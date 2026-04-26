import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { getAccountBalance } from '../services/ledger.js';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function cleanAll() {
  assertTestDatabase();
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
  console.log('=== NO PHONE ON RECEIPT → PROCEEDS WITH INVOICE NUMBER + AMOUNT ===\n');
  await cleanAll();

  const tenant = await createTenant('NoPhone Store', 'nophone-store', 'np@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@np.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // CSV has invoices — some with phone, some without
  await processCSV(`invoice_number,total,phone
NP-001,300.00,+584125550001
NP-002,150.00,
NP-003,75.50,`, tenant.id, staff.id);

  // ──────────────────────────────────
  // 1. No phone on receipt, no phone in CSV → validates via invoice_number + amount only
  // ──────────────────────────────────
  console.log('1. No phone on receipt → Stage B skipped, Stage C uses invoice_number + amount');
  const r1 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125559999', assetTypeId: asset.id,
    extractedData: {
      invoice_number: 'NP-002',
      total_amount: 150.00,
      transaction_date: '2024-01-01',
      customer_phone: null, // No phone on receipt
      merchant_name: null,
      confidence_score: 0.95,
    },
  });
  assert(r1.success === true, 'Validated successfully without phone');
  assert(r1.stage === 'complete', 'Reached complete (Stage B skipped)');
  assert(r1.invoiceNumber === 'NP-002', 'Matched by invoice_number');
  assert(r1.valueAssigned === '150.00000000', 'Value assigned from amount: 150');

  // Verify: Stage C matched on invoice_number in the CSV
  const inv = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'NP-002' } });
  assert(inv!.status === 'claimed', 'Invoice claimed via invoice_number match');

  // Verify: double-entry created
  const entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, referenceId: 'NP-002' } });
  assert(entries.length === 2, '2 ledger entries (double-entry)');

  // ──────────────────────────────────
  // 2. Any sender phone can claim when receipt has no phone
  // ──────────────────────────────────
  console.log('\n2. Any sender can claim when receipt has no phone (no identity gate)');
  const r2 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550000', assetTypeId: asset.id,
    extractedData: {
      invoice_number: 'NP-003',
      total_amount: 75.50,
      transaction_date: '2024-01-01',
      customer_phone: null,
      merchant_name: null,
      confidence_score: 0.95,
    },
  });
  assert(r2.success === true, 'Different sender validated (no phone gate)');

  // ──────────────────────────────────
  // 3. Amount mismatch still caught even without phone
  // ──────────────────────────────────
  console.log('\n3. Stage C still checks amount even without phone');
  await processCSV(`invoice_number,total\nNP-004,500.00`, tenant.id, staff.id);

  const r3 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550000', assetTypeId: asset.id,
    extractedData: {
      invoice_number: 'NP-004',
      total_amount: 999.00, // Wrong amount
      customer_phone: null,
      merchant_name: null,
      transaction_date: null,
      confidence_score: 0.95,
    },
  });
  assert(r3.success === false, 'Amount mismatch caught without phone');
  assert(r3.status === 'manual_review', 'Flagged for manual review');

  // ──────────────────────────────────
  // 4. Verify the code path: customer_phone null → skip identity check
  // ──────────────────────────────────
  console.log('\n4. Code verification: null phone skips identity check');
  const fs = await import('fs');
  const src = fs.readFileSync('/home/loyalty-platform/src/services/invoice-validation.ts', 'utf-8');
  assert(src.includes('if (extracted.customer_phone)'), 'Identity check is conditional on customer_phone');

  console.log(`\n=== NO PHONE PROCEEDS: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
