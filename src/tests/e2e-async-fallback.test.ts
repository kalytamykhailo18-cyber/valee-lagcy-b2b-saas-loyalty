import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { createPendingValidation } from '../services/invoice-validation.js';
import { getAccountBalance } from '../services/ledger.js';
import { runReconciliation } from '../services/reconciliation.js';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function cleanAll() {
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_truncate`;
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
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_truncate`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_update`;
}

async function test() {
  console.log('=== ASYNC FALLBACK: FULL E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Async Store', 'async-store', 'as@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@as.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  const phone1 = '+584125550001';
  const phone2 = '+584125550002';

  // ============================================
  // SCENARIO A: Pending → CSV uploaded → confirmed
  // ============================================
  console.log('SCENARIO A: Pending → CSV uploaded later → reconciliation confirms\n');

  // Step 1: Consumer submits invoice BEFORE CSV is uploaded
  console.log('  1. Invoice submitted — no CSV yet → pending_validation');
  const pending1 = await createPendingValidation({
    tenantId: tenant.id, senderPhone: phone1, invoiceNumber: 'ASYNC-001',
    totalAmount: 200, assetTypeId: asset.id,
  });
  assert(pending1.success === true, 'Pending validation created');
  assert(pending1.status === 'pending_validation', `Status: ${pending1.status}`);

  // Step 2: Verify invoice record has status pending_validation
  const pendingInv = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: 'ASYNC-001', source: 'photo_submission' },
  });
  assert(pendingInv !== null, 'Invoice record exists');
  assert(pendingInv!.status === 'pending_validation', `Invoice status: ${pendingInv!.status}`);

  // Step 3: Provisional ledger credit with status PROVISIONAL
  const provEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: 'PENDING-ASYNC-001' },
  });
  assert(provEntries.length === 2, `2 provisional ledger entries (got ${provEntries.length})`);
  assert(provEntries.every(e => e.status === 'provisional'), 'Both entries status: provisional');

  const debit = provEntries.find(e => e.entryType === 'DEBIT')!;
  const credit = provEntries.find(e => e.entryType === 'CREDIT')!;
  assert(debit.accountId === sys.pool.id, 'DEBIT from issued_value_pool');
  assert(credit.accountId === pendingInv!.consumerAccountId, 'CREDIT to consumer');

  // Step 4: Consumer has provisional balance
  const acc1 = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: phone1 } },
  });
  const provBalance = await getAccountBalance(acc1!.id, asset.id, tenant.id);
  assert(Number(provBalance) === 200, `Provisional balance: 200 (got ${provBalance})`);

  // Step 5: Consumer notified it's being reviewed
  assert(pending1.message.includes('verified') || pending1.message.includes('verificar') || pending1.message.includes('provisional'), 'Message says being reviewed');

  // Step 6: Reconciliation runs — no CSV yet, stays pending
  console.log('\n  2. Reconciliation runs — no CSV yet → stays pending');
  const recon1 = await runReconciliation();
  assert(recon1.stillPending >= 1, `Still pending: ${recon1.stillPending}`);
  assert(recon1.confirmed === 0, 'Nothing confirmed yet');

  // Step 7: Merchant uploads CSV with matching invoice
  console.log('\n  3. CSV uploaded with matching invoice');
  await processCSV(`invoice_number,total\nASYNC-001,200.00`, tenant.id, staff.id);

  // Step 8: CSV upload confirmed the pending invoice directly
  // Reconciliation has nothing left to do — pending was already resolved
  console.log('\n  4. CSV upload confirmed pending invoice directly');
  const recon2 = await runReconciliation();
  assert(recon2.stillPending === 0, `No pending left: ${recon2.stillPending}`);

  // Step 9: Invoice status updated to CONFIRMED (claimed)
  const confirmedInv = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: 'ASYNC-001', source: 'photo_submission' },
  });
  assert(confirmedInv!.status === 'claimed', `Invoice status: claimed (got ${confirmedInv!.status})`);

  // Step 10: Balance still correct
  const confirmedBalance = await getAccountBalance(acc1!.id, asset.id, tenant.id);
  assert(Number(confirmedBalance) === 200, `Balance after confirmation: 200 (got ${confirmedBalance})`);

  // ============================================
  // SCENARIO B: Pending → timeout expires → reversal
  // ============================================
  console.log('\n\nSCENARIO B: Pending → timeout expires → reversal\n');

  // Step 1: Consumer submits invoice
  console.log('  1. Invoice submitted → pending_validation');
  const pending2 = await createPendingValidation({
    tenantId: tenant.id, senderPhone: phone2, invoiceNumber: 'ASYNC-002',
    totalAmount: 150, assetTypeId: asset.id,
  });
  assert(pending2.status === 'pending_validation', 'Status: pending_validation');

  const acc2 = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: phone2 } },
  });
  const provBal2 = await getAccountBalance(acc2!.id, asset.id, tenant.id);
  assert(Number(provBal2) === 150, `Provisional balance: 150 (got ${provBal2})`);

  // Step 2: Force the pending invoice past the reconciliation window
  console.log('\n  2. Time window expires (RECONCILIATION_WINDOW_HOURS from .env)');
  const windowHours = parseInt(process.env.RECONCILIATION_WINDOW_HOURS || '24');
  assert(windowHours === 24, `RECONCILIATION_WINDOW_HOURS: ${windowHours}`);

  await prisma.invoice.updateMany({
    where: { tenantId: tenant.id, invoiceNumber: 'ASYNC-002', source: 'photo_submission' },
    data: { createdAt: new Date(Date.now() - (windowHours + 1) * 60 * 60 * 1000) },
  });

  // Step 3: Reconciliation runs — no CSV match, window expired → reversal
  console.log('\n  3. Reconciliation → reversal');
  const recon3 = await runReconciliation();
  assert(recon3.reversed >= 1, `Reversed: ${recon3.reversed}`);

  // Step 4: Invoice status set to rejected
  const rejectedInv = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: 'ASYNC-002', source: 'photo_submission' },
  });
  assert(rejectedInv!.status === 'rejected', `Invoice status: rejected (got ${rejectedInv!.status})`);
  assert(rejectedInv!.rejectionReason !== null, `Rejection reason set: "${rejectedInv!.rejectionReason?.slice(0,50)}"`);

  // Step 5: REVERSAL double-entry created
  const reversalEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REVERSAL' },
  });
  assert(reversalEntries.length === 2, `2 REVERSAL entries (double-entry) (got ${reversalEntries.length})`);

  const revDebit = reversalEntries.find(e => e.entryType === 'DEBIT')!;
  const revCredit = reversalEntries.find(e => e.entryType === 'CREDIT')!;
  assert(revDebit.accountId === acc2!.id, 'REVERSAL DEBIT from consumer (value removed)');
  assert(revCredit.accountId === sys.pool.id, 'REVERSAL CREDIT to pool (value returned)');
  assert(revDebit.pairedEntryId === revCredit.id, 'REVERSAL entries paired');

  // Step 6: Balance reversed to 0
  const reversedBalance = await getAccountBalance(acc2!.id, asset.id, tenant.id);
  assert(Number(reversedBalance) === 0, `Balance after reversal: 0 (got ${reversedBalance})`);

  // ============================================
  // VERIFICATION: Background worker exists
  // ============================================
  console.log('\n\nBACKGROUND WORKER');
  const { startWorkers } = await import('../services/workers.js');
  assert(typeof startWorkers === 'function', 'startWorkers function exists (BullMQ, uses REDIS_URL from .env)');

  const workerSrc = (await import('fs')).readFileSync('/home/loyalty-platform/src/services/workers.ts', 'utf-8');
  assert(workerSrc.includes('reconciliation'), 'Reconciliation worker defined');
  assert(workerSrc.includes('setInterval'), 'Runs periodically');
  assert(workerSrc.includes('REDIS_URL'), 'Uses REDIS_URL from .env');

  console.log(`\n=== ASYNC FALLBACK: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
