import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { initiateRedemption, processRedemption, expireRedemption } from '../services/redemption.js';
import { writeDoubleEntry, getAccountBalance } from '../services/ledger.js';
import { resolveDispute, createDispute } from '../services/disputes.js';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function cleanAll() {
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_no_update`;
  await prisma.dispute.deleteMany(); await prisma.redemptionToken.deleteMany();
  await prisma.invoice.deleteMany(); await prisma.uploadBatch.deleteMany();
  await prisma.ledgerEntry.deleteMany(); await prisma.auditLog.deleteMany();
  await prisma.idempotencyKey.deleteMany(); await prisma.tenantAssetConfig.deleteMany();
  await prisma.product.deleteMany(); await prisma.otpSession.deleteMany();
  await prisma.staff.deleteMany(); await prisma.account.deleteMany();
  await prisma.assetType.deleteMany(); await prisma.branch.deleteMany();
  await prisma.adminUser.deleteMany(); await prisma.tenant.deleteMany();
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_update`;
}

async function test() {
  console.log('=== DOUBLE-ENTRY RULE: EVERY FINANCIAL EVENT ===\n');
  await cleanAll();

  const tenant = await createTenant('DE Store', 'de-store', 'de@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@de.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  const { account: consumer } = await (await import('../services/accounts.js')).findOrCreateConsumerAccount(tenant.id, '+58412DE001');

  // Load CSV so invoice validation works
  await processCSV(`invoice_number,total\nDE-001,200.00\nDE-002,100.00`, tenant.id, staff.id);

  // Helper to count entries for a given event type
  async function countEntries(eventType: string) {
    return prisma.ledgerEntry.count({ where: { tenantId: tenant.id, eventType: eventType as any } });
  }

  // ──────────────────────────────────────────────
  // 1. INVOICE_CLAIMED
  // Debit: merchant issued_value_pool
  // Credit: consumer account
  // ──────────────────────────────────────────────
  console.log('1. INVOICE_CLAIMED');
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412DE001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'DE-001', total_amount: 200, transaction_date: '2024-01-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  let entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, eventType: 'INVOICE_CLAIMED' } });
  assert(entries.length === 2, `2 entries created (got ${entries.length})`);
  const debit = entries.find(e => e.entryType === 'DEBIT')!;
  const credit = entries.find(e => e.entryType === 'CREDIT')!;
  assert(debit.accountId === sys.pool.id, `DEBIT account = issued_value_pool`);
  assert(credit.accountId === consumer.id, `CREDIT account = consumer`);
  assert(debit.pairedEntryId === credit.id, `DEBIT paired → CREDIT`);
  assert(credit.pairedEntryId === debit.id, `CREDIT paired → DEBIT`);
  assert(Number(debit.amount) === Number(credit.amount), `Same amount on both sides`);

  // ──────────────────────────────────────────────
  // 2. REDEMPTION_PENDING
  // Debit: consumer account (value reserved)
  // Credit: redemption_holding
  // ──────────────────────────────────────────────
  console.log('\n2. REDEMPTION_PENDING');
  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Test', redemptionCost: '50.00000000', assetTypeId: asset.id, stock: 5, active: true },
  });
  const redemption = await initiateRedemption({
    consumerAccountId: consumer.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, eventType: 'REDEMPTION_PENDING' } });
  assert(entries.length === 2, `2 entries created (got ${entries.length})`);
  const rpDebit = entries.find(e => e.entryType === 'DEBIT')!;
  const rpCredit = entries.find(e => e.entryType === 'CREDIT')!;
  assert(rpDebit.accountId === consumer.id, `DEBIT account = consumer (value leaves)`);
  assert(rpCredit.accountId === sys.holding.id, `CREDIT account = redemption_holding (value reserved)`);

  // ──────────────────────────────────────────────
  // 3. REDEMPTION_CONFIRMED
  // Debit: redemption_holding
  // Credit: consumer (value consumed, cycle closed)
  // ──────────────────────────────────────────────
  console.log('\n3. REDEMPTION_CONFIRMED');
  await processRedemption({ token: redemption.token!, cashierStaffId: staff.id, cashierTenantId: tenant.id });
  entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED' } });
  assert(entries.length === 2, `2 entries created (got ${entries.length})`);
  const rcDebit = entries.find(e => e.entryType === 'DEBIT')!;
  const rcCredit = entries.find(e => e.entryType === 'CREDIT')!;
  assert(rcDebit.accountId === sys.holding.id, `DEBIT account = redemption_holding`);
  assert(rcCredit.accountId === consumer.id, `CREDIT account = consumer`);

  // ──────────────────────────────────────────────
  // 4. REDEMPTION_EXPIRED
  // Debit: redemption_holding (value released)
  // Credit: consumer (value returned)
  // ──────────────────────────────────────────────
  console.log('\n4. REDEMPTION_EXPIRED');
  const redemption2 = await initiateRedemption({
    consumerAccountId: consumer.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  // Force expire
  await prisma.redemptionToken.update({
    where: { id: redemption2.tokenId! }, data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await expireRedemption(redemption2.tokenId!);
  entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, eventType: 'REDEMPTION_EXPIRED' } });
  assert(entries.length === 2, `2 entries created (got ${entries.length})`);
  const reDebit = entries.find(e => e.entryType === 'DEBIT')!;
  const reCredit = entries.find(e => e.entryType === 'CREDIT')!;
  assert(reDebit.accountId === sys.holding.id, `DEBIT account = redemption_holding (releases)`);
  assert(reCredit.accountId === consumer.id, `CREDIT account = consumer (value returned)`);

  // ──────────────────────────────────────────────
  // 5. REVERSAL
  // Debit: consumer (value removed)
  // Credit: issued_value_pool (value returned to merchant)
  // ──────────────────────────────────────────────
  console.log('\n5. REVERSAL');
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'REVERSAL',
    debitAccountId: consumer.id, creditAccountId: sys.pool.id,
    amount: '10.00000000', assetTypeId: asset.id,
    referenceId: 'REV-TEST', referenceType: 'invoice',
    metadata: { reason: 'Test reversal' },
  });
  entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, eventType: 'REVERSAL' } });
  assert(entries.length === 2, `2 entries created (got ${entries.length})`);
  const rvDebit = entries.find(e => e.entryType === 'DEBIT')!;
  const rvCredit = entries.find(e => e.entryType === 'CREDIT')!;
  assert(rvDebit.accountId === consumer.id, `DEBIT account = consumer (value removed)`);
  assert(rvCredit.accountId === sys.pool.id, `CREDIT account = issued_value_pool (returned)`);

  // ──────────────────────────────────────────────
  // 6. ADJUSTMENT_MANUAL
  // Debit: depends on direction
  // Credit: depends on direction
  // ──────────────────────────────────────────────
  console.log('\n6. ADJUSTMENT_MANUAL (credit direction)');
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: sys.pool.id, creditAccountId: consumer.id,
    amount: '25.00000000', assetTypeId: asset.id,
    referenceId: 'ADJ-TEST', referenceType: 'manual_adjustment',
    metadata: { reason: 'Manual credit for testing' },
  });
  entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL' } });
  assert(entries.length === 2, `2 entries created (got ${entries.length})`);

  // ──────────────────────────────────────────────
  // 7. DISPUTE APPROVAL → ADJUSTMENT_MANUAL (via disputes service)
  // ──────────────────────────────────────────────
  console.log('\n7. DISPUTE APPROVAL (creates ADJUSTMENT_MANUAL)');
  const dispute = await createDispute({
    tenantId: tenant.id, consumerAccountId: consumer.id, description: 'Test dispute',
  });
  await resolveDispute({
    disputeId: dispute.id, action: 'approve', reason: 'Valid claim',
    resolverId: staff.id, resolverType: 'staff',
    adjustmentAmount: '15.00000000', assetTypeId: asset.id,
  });
  entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL' } });
  assert(entries.length === 4, `4 ADJUSTMENT_MANUAL entries total (2 manual + 2 dispute) (got ${entries.length})`);

  // ──────────────────────────────────────────────
  // VERIFY: No single-entry writes exist anywhere
  // ──────────────────────────────────────────────
  console.log('\n8. GLOBAL CHECK: No single-entry events');
  const allEntries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id } });
  const byRef: Record<string, number> = {};
  for (const e of allEntries) {
    byRef[e.referenceId] = (byRef[e.referenceId] || 0) + 1;
  }
  const singles = Object.entries(byRef).filter(([_, count]) => count !== 2);
  assert(singles.length === 0, `Every reference_id has exactly 2 entries (${Object.keys(byRef).length} refs, ${singles.length} singles)`);
  if (singles.length > 0) {
    for (const [ref, count] of singles) {
      console.log(`       PROBLEM: ${ref} has ${count} entries`);
    }
  }

  // ──────────────────────────────────────────────
  // VERIFY: Every entry has a paired_entry_id
  // ──────────────────────────────────────────────
  console.log('\n9. GLOBAL CHECK: Every entry is paired');
  const unpaired = allEntries.filter(e => !e.pairedEntryId);
  assert(unpaired.length === 0, `All ${allEntries.length} entries have paired_entry_id (${unpaired.length} unpaired)`);

  // ──────────────────────────────────────────────
  // VERIFY: Total debits = total credits (accounting equation)
  // ──────────────────────────────────────────────
  console.log('\n10. GLOBAL CHECK: Total debits = total credits');
  const totalDebits = allEntries.filter(e => e.entryType === 'DEBIT').reduce((s, e) => s + Number(e.amount), 0);
  const totalCredits = allEntries.filter(e => e.entryType === 'CREDIT').reduce((s, e) => s + Number(e.amount), 0);
  assert(totalDebits === totalCredits, `Debits ${totalDebits} = Credits ${totalCredits}`);

  console.log(`\n=== DOUBLE-ENTRY VERIFICATION: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
