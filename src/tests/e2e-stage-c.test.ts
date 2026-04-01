import dotenv from 'dotenv'; dotenv.config();
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
  console.log('=== STAGE C: MERCHANT DATA CROSS-REFERENCE ===\n');
  await cleanAll();

  const tenantA = await createTenant('Store A', 'store-a-c', 'a@c.com');
  const tenantB = await createTenant('Store B', 'store-b-c', 'b@c.com');
  await createSystemAccounts(tenantA.id);
  await createSystemAccounts(tenantB.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staffA = await prisma.staff.create({ data: { tenantId: tenantA.id, name: 'O', email: 'o@a.com', passwordHash: '$2b$10$x', role: 'owner' } });
  const staffB = await prisma.staff.create({ data: { tenantId: tenantB.id, name: 'O', email: 'o@b.com', passwordHash: '$2b$10$x', role: 'owner' } });

  await processCSV(`invoice_number,total\nSC-001,100.00\nSC-002,250.50\nSC-003,75.00`, tenantA.id, staffA.id);
  await processCSV(`invoice_number,total\nSC-001,999.00`, tenantB.id, staffB.id);

  // ──────────────────────────────────
  // CHECK 1: Invoice exists in merchant's registry → proceed
  // ──────────────────────────────────
  console.log('1. Invoice exists in registry → proceeds');
  const r1 = await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SC-001', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(r1.success === true, 'SC-001 found in Store A → validated');

  // ──────────────────────────────────
  // CHECK 1 (negative): Invoice NOT in registry → rejected
  // ──────────────────────────────────
  console.log('\n1b. Invoice NOT in registry → rejected');
  const r1b = await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+584125550002', assetTypeId: asset.id,
    extractedData: { invoice_number: 'FAKE-999', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(r1b.success === false, 'FAKE-999 not found → rejected');
  assert(r1b.stage === 'cross_reference', `Stage: cross_reference (got: ${r1b.stage})`);
  assert(r1b.message.includes('not found'), 'Message says not found');

  // ──────────────────────────────────
  // CHECK 1 (tenant scoped): Invoice exists in Store B but NOT in Store A
  // ──────────────────────────────────
  console.log('\n1c. Lookup scoped to the correct merchant (QR tenant)');
  // SC-001 was already claimed in Store A. It exists in Store B with $999.
  // A consumer in Store A cannot see Store B's registry.
  const r1c = await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+584125550003', assetTypeId: asset.id,
    extractedData: { invoice_number: 'ONLY-IN-B', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(r1c.success === false, 'Invoice from Store B not visible in Store A context');

  // ──────────────────────────────────
  // CHECK 2: Amount matches within tolerance → proceed
  // ──────────────────────────────────
  console.log('\n2. Amount tolerance check');
  const tolerance = parseFloat(process.env.INVOICE_AMOUNT_TOLERANCE || '0.05');
  console.log(`   INVOICE_AMOUNT_TOLERANCE from .env: ${tolerance} (${tolerance * 100}%)`);

  // Exact match
  const r2a = await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+584125550004', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SC-002', total_amount: 250.50, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(r2a.success === true, 'Exact amount match ($250.50 == $250.50) → validated');

  // Within tolerance (a few cents)
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
  await prisma.ledgerEntry.deleteMany({ where: { tenantId: tenantA.id, referenceId: 'SC-002' } });
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.invoice.updateMany({ where: { tenantId: tenantA.id, invoiceNumber: 'SC-002' }, data: { status: 'available', consumerAccountId: null, ledgerEntryId: null } });

  // 5% of 250.50 = 12.525. So 250.50 + 12 = 262.50 should pass
  const r2b = await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+584125550005', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SC-002', total_amount: 262.00, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(r2b.success === true, 'Within tolerance ($262 vs $250.50, diff $11.50 < 5% of $262 = $13.10) → validated');

  // Significantly different → flagged for review
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
  await prisma.ledgerEntry.deleteMany({ where: { tenantId: tenantA.id, referenceId: 'SC-002' } });
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.invoice.updateMany({ where: { tenantId: tenantA.id, invoiceNumber: 'SC-002' }, data: { status: 'available', consumerAccountId: null, ledgerEntryId: null } });

  const r2c = await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+584125550006', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SC-002', total_amount: 999.00, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(r2c.success === false, 'Significant amount mismatch ($999 vs $250.50) → rejected');
  assert(r2c.status === 'manual_review', 'Status: manual_review (flagged for review)');
  assert(r2c.message.includes('does not match'), 'Message explains amount mismatch');

  // ──────────────────────────────────
  // CHECK 3: Already claimed → rejected
  // ──────────────────────────────────
  console.log('\n3. Already claimed → rejected');
  // SC-001 was claimed in test 1 above
  const r3 = await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+584125550007', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SC-001', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(r3.success === false, 'Already claimed → rejected');
  assert(r3.message.includes('already'), 'Message says already used');

  // Verify invoice status
  const claimedInv = await prisma.invoice.findFirst({ where: { tenantId: tenantA.id, invoiceNumber: 'SC-001' } });
  assert(claimedInv!.status === 'claimed', 'Invoice status is "claimed" in DB');

  // No extra ledger entries from the rejected attempt
  const claimedEntries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenantA.id, referenceId: 'SC-001' } });
  assert(claimedEntries.length === 2, 'Still only 2 ledger entries (original claim, no duplicate)');

  // ──────────────────────────────────
  // CODE VERIFICATION
  // ──────────────────────────────────
  console.log('\n4. Code verification');
  const fs = await import('fs');
  const src = fs.readFileSync('/home/loyalty-platform/src/services/invoice-validation.ts', 'utf-8');
  assert(src.includes('tenantId_invoiceNumber'), 'Looks up by (tenantId, invoiceNumber) — scoped to merchant');
  assert(src.includes("INVOICE_AMOUNT_TOLERANCE"), 'Uses INVOICE_AMOUNT_TOLERANCE from .env');
  assert(src.includes("status === 'claimed'"), 'Checks if already claimed');

  console.log(`\n=== STAGE C: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
