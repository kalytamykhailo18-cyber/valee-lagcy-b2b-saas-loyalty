import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';

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
  console.log('=== STAGE B: IDENTITY CROSS-CHECK (ANTI-FRAUD) ===\n');
  await cleanAll();

  const tenant = await createTenant('ID Store', 'id-store', 'id@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@id.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total,phone\nID-001,100.00,+584125550001\nID-002,200.00,`, tenant.id, staff.id);

  // ──────────────────────────────────
  // 1. Phone on receipt matches sender → PASSES (proceeds to Stage C)
  // ──────────────────────────────────
  console.log('1. Phone on receipt matches sender → passes');
  const matchResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'ID-001', total_amount: 100, transaction_date: '2024-01-01',
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(matchResult.success === true, 'Phone match → validation succeeds');
  assert(matchResult.stage === 'complete', 'Reaches stage: complete (passed Stage B)');

  // ──────────────────────────────────
  // 2. Phone on receipt does NOT match sender → REJECTED IMMEDIATELY
  // ──────────────────────────────────
  console.log('\n2. Phone mismatch → rejected immediately at Stage B');
  const mismatchResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125559999', assetTypeId: asset.id,
    extractedData: { invoice_number: 'ID-002', total_amount: 200, transaction_date: '2024-01-01',
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(mismatchResult.success === false, 'Rejected');
  assert(mismatchResult.stage === 'identity_check', `Stage: identity_check (got: ${mismatchResult.stage})`);
  assert(mismatchResult.message.includes('phone number'), 'Message explains phone mismatch');
  assert(mismatchResult.message.includes('does not match'), 'Message says does not match');

  // Verify: no ledger entries created (Stage D never reached)
  const mismatchEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: 'ID-002' },
  });
  assert(mismatchEntries.length === 0, 'No ledger entries created on mismatch (Stage D not reached)');

  // Verify: invoice still available (not claimed)
  const inv = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'ID-002' } });
  assert(inv!.status === 'available', 'Invoice still available (not claimed)');

  // ──────────────────────────────────
  // 3. No phone on receipt → PROCEEDS (skips Stage B)
  // ──────────────────────────────────
  console.log('\n3. No phone on receipt → skips Stage B, proceeds to Stage C');
  const noPhoneResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125559999', assetTypeId: asset.id,
    extractedData: { invoice_number: 'ID-002', total_amount: 200, transaction_date: '2024-01-01',
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(noPhoneResult.success === true, 'No phone on receipt → proceeds and validates');
  assert(noPhoneResult.stage === 'complete', 'Reaches complete (Stage B skipped)');

  // ──────────────────────────────────
  // 4. Phone normalization — spaces/dashes stripped before comparison
  // ──────────────────────────────────
  console.log('\n4. Phone normalization (spaces, dashes, parentheses stripped)');

  // Reset ID-001 for this test
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
  await prisma.ledgerEntry.deleteMany({ where: { tenantId: tenant.id, referenceId: 'ID-001' } });
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.invoice.updateMany({ where: { tenantId: tenant.id, invoiceNumber: 'ID-001' }, data: { status: 'available', consumerAccountId: null, ledgerEntryId: null } });

  const normalizedResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58 412 555-0001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'ID-001', total_amount: 100, transaction_date: '2024-01-01',
      customer_phone: '+58(412)555-0001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(normalizedResult.success === true, 'Normalized phones match (+58 412 555-0001 == +58(412)555-0001)');

  // ──────────────────────────────────
  // 5. Anti-fraud: prevents cashier submitting on behalf of others
  // ──────────────────────────────────
  console.log('\n5. Anti-fraud: cashier cannot claim consumer\'s invoice');

  await processCSV(`invoice_number,total,phone\nFRAUD-001,500.00,+584125550099`, tenant.id, staff.id);

  // Cashier's phone is different from the consumer's phone on the receipt
  const fraudResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125558888', assetTypeId: asset.id,
    extractedData: { invoice_number: 'FRAUD-001', total_amount: 500, transaction_date: '2024-01-01',
      customer_phone: '+584125550099', merchant_name: null, confidence_score: 0.95 },
  });
  assert(fraudResult.success === false, 'Fraud attempt blocked');
  assert(fraudResult.stage === 'identity_check', 'Blocked at identity_check');

  // No value assigned
  const fraudEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: 'FRAUD-001' },
  });
  assert(fraudEntries.length === 0, 'No value assigned in fraud attempt');

  // ──────────────────────────────────
  // 6. Verify code uses phone normalization
  // ──────────────────────────────────
  console.log('\n6. Code verification');
  const fs = await import('fs');
  const src = fs.readFileSync('/home/loyalty-platform/src/services/invoice-validation.ts', 'utf-8');
  assert(src.includes('replace(/[\\s\\-()]/g'), 'Phone normalization strips spaces, dashes, parens');
  assert(src.includes('normalizedExtracted !== normalizedSender'), 'Compares normalized phones');

  console.log(`\n=== STAGE B IDENTITY: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
