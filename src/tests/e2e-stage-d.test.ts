import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { getAccountBalance } from '../services/ledger.js';

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
  console.log('=== STAGE D: VALUE ASSIGNMENT — ALL 5 CHECKS ===\n');
  await cleanAll();

  const tenant = await createTenant('Value Store', 'value-store', 'v@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '2.00000000'); // 2 points per $1
  // Override for this tenant: 3 points per $1
  await setTenantConversionRate(tenant.id, asset.id, '3.00000000');

  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@v.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  await processCSV(`invoice_number,total\nVAL-001,100.00\nVAL-002,50.00`, tenant.id, staff.id);

  // ──────────────────────────────────
  // Full success: all checks pass → value assigned
  // ──────────────────────────────────
  console.log('Full validation → value assignment');
  const result = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'VAL-001', total_amount: 100, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(result.success === true, 'Validation succeeded');

  // ──────────────────────────────────
  // CHECK 1: Invoice marked as "claimed" — cannot be used again
  // ──────────────────────────────────
  console.log('\n1. Invoice marked as "claimed"');
  const invoice = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'VAL-001' } });
  assert(invoice!.status === 'claimed', `Invoice status: claimed (got: ${invoice!.status})`);
  assert(invoice!.consumerAccountId !== null, 'consumer_account_id set');
  assert(invoice!.ledgerEntryId !== null, 'ledger_entry_id set');

  // Attempt to claim again
  const dup = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'VAL-001', total_amount: 100, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(dup.success === false, 'Cannot claim again');
  assert(dup.message.includes('already'), 'Says already used');

  // ──────────────────────────────────
  // CHECK 2: Value calculated using merchant's conversion rule
  // ──────────────────────────────────
  console.log('\n2. Value calculated via conversion rule ($100 × 3.0 rate = 300 pts)');
  assert(result.valueAssigned === '300.00000000', `Value assigned: 300 (got: ${result.valueAssigned})`);

  // Verify with a second invoice to confirm rate is applied consistently
  const result2 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550002', assetTypeId: asset.id,
    extractedData: { invoice_number: 'VAL-002', total_amount: 50, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(result2.valueAssigned === '150.00000000', `$50 × 3.0 = 150 pts (got: ${result2.valueAssigned})`);

  // ──────────────────────────────────
  // CHECK 3: Two ledger entries (double-entry), debit pool + credit consumer
  // ──────────────────────────────────
  console.log('\n3. Double-entry: DEBIT issued_value_pool, CREDIT consumer');
  const entries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: 'VAL-001' },
  });
  assert(entries.length === 2, `2 ledger entries (got: ${entries.length})`);

  const debit = entries.find(e => e.entryType === 'DEBIT')!;
  const credit = entries.find(e => e.entryType === 'CREDIT')!;

  assert(debit.accountId === sys.pool.id, `DEBIT account = issued_value_pool (${debit.accountId.slice(0,8)}...)`);
  assert(credit.accountId === invoice!.consumerAccountId, `CREDIT account = consumer (${credit.accountId.slice(0,8)}...)`);
  assert(Number(debit.amount) === 300, `DEBIT amount: 300`);
  assert(Number(credit.amount) === 300, `CREDIT amount: 300`);
  assert(debit.pairedEntryId === credit.id, 'DEBIT paired → CREDIT');
  assert(credit.pairedEntryId === debit.id, 'CREDIT paired → DEBIT');

  // Both use invoice reference ID
  assert(debit.referenceId === 'VAL-001', `DEBIT reference_id = VAL-001`);
  assert(credit.referenceId === 'VAL-001', `CREDIT reference_id = VAL-001`);

  // ──────────────────────────────────
  // CHECK 4: Event type is INVOICE_CLAIMED
  // ──────────────────────────────────
  console.log('\n4. Event type: INVOICE_CLAIMED');
  assert(debit.eventType === 'INVOICE_CLAIMED', `DEBIT event: INVOICE_CLAIMED (got: ${debit.eventType})`);
  assert(credit.eventType === 'INVOICE_CLAIMED', `CREDIT event: INVOICE_CLAIMED (got: ${credit.eventType})`);

  // ──────────────────────────────────
  // CHECK 5: Balance recalculated from ledger state
  // ──────────────────────────────────
  console.log('\n5. Balance recalculated from ledger history');

  // Consumer 1: claimed VAL-001 ($100 × 3.0 = 300 pts)
  const account1 = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });
  const bal1 = await getAccountBalance(account1!.id, asset.id, tenant.id);
  assert(Number(bal1) === 300, `Consumer 1 balance: 300 (got: ${bal1})`);
  assert(result.newBalance === '300.00000000', `Response newBalance matches: ${result.newBalance}`);

  // Consumer 2: claimed VAL-002 ($50 × 3.0 = 150 pts)
  const account2 = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550002' } },
  });
  const bal2 = await getAccountBalance(account2!.id, asset.id, tenant.id);
  assert(Number(bal2) === 150, `Consumer 2 balance: 150 (got: ${bal2})`);

  // Verify: no stored balance column exists
  const cols = await prisma.$queryRaw<any[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'accounts' AND column_name ILIKE '%balance%'
  `;
  assert(cols.length === 0, 'No balance column in accounts table — always computed');

  console.log(`\n=== STAGE D: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
