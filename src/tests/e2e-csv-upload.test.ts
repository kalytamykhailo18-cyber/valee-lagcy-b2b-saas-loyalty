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
  console.log('=== CSV UPLOAD: FULL E2E ===\n');
  await cleanAll();

  const tenantA = await createTenant('Store A', 'store-a-csv', 'a@csv.com');
  const tenantB = await createTenant('Store B', 'store-b-csv', 'b@csv.com');
  await createSystemAccounts(tenantA.id);
  await createSystemAccounts(tenantB.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');

  const staffA = await prisma.staff.create({
    data: { tenantId: tenantA.id, name: 'Owner A', email: 'o@a.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  const staffB = await prisma.staff.create({
    data: { tenantId: tenantB.id, name: 'Owner B', email: 'o@b.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // ──────────────────────────────────
  // 1. Upload flow: extract fields, store as "available"
  // ──────────────────────────────────
  console.log('1. Upload CSV — fields extracted, status "available"');
  const csv = `invoice_number,total,date,phone
CSV-001,150.00,2024-03-01,+58412001
CSV-002,275.50,2024-03-02,+58412002
CSV-003,80.00,2024-03-03,
CSV-004,320.00,2024-03-04,+58412004
CSV-005,99.99,2024-03-05,+58412005`;

  const result = await processCSV(csv, tenantA.id, staffA.id);
  assert(result.status === 'completed', `Status: completed`);
  assert(result.rowsLoaded === 5, `5 rows loaded (got ${result.rowsLoaded})`);
  assert(result.rowsSkipped === 0, `0 skipped (got ${result.rowsSkipped})`);
  assert(result.rowsErrored === 0, `0 errors (got ${result.rowsErrored})`);

  const invoices = await prisma.invoice.findMany({ where: { tenantId: tenantA.id }, orderBy: { invoiceNumber: 'asc' } });
  assert(invoices.length === 5, `5 invoices in DB`);
  assert(invoices.every(i => i.status === 'available'), 'All have status "available"');
  assert(invoices.every(i => i.source === 'csv_upload'), 'All have source "csv_upload"');
  assert(invoices[0].invoiceNumber === 'CSV-001', 'Invoice number extracted');
  assert(Number(invoices[0].amount) === 150, 'Amount extracted');
  assert(invoices[0].customerPhone === '+58412001', 'Phone extracted');
  assert(invoices[2].customerPhone === null, 'Missing phone stored as null');

  // ──────────────────────────────────
  // 2. Duplicate skipping — silently, not an error
  // ──────────────────────────────────
  console.log('\n2. Re-upload same CSV — duplicates silently skipped');
  const result2 = await processCSV(csv, tenantA.id, staffA.id);
  assert(result2.rowsLoaded === 0, `0 new rows (got ${result2.rowsLoaded})`);
  assert(result2.rowsSkipped === 5, `5 skipped (got ${result2.rowsSkipped})`);
  assert(result2.rowsErrored === 0, `0 errors (got ${result2.rowsErrored})`);

  const invoicesAfter = await prisma.invoice.findMany({ where: { tenantId: tenantA.id } });
  assert(invoicesAfter.length === 5, `Still 5 invoices (no duplicates created)`);

  // ──────────────────────────────────
  // 3. Malformed rows counted as errors
  // ──────────────────────────────────
  console.log('\n3. Malformed rows counted as errors');
  const csvBad = `invoice_number,total
GOOD-001,100.00
,bad_amount
GOOD-002,200.00
,,`;

  const result3 = await processCSV(csvBad, tenantA.id, staffA.id);
  assert(result3.rowsLoaded === 2, `2 loaded (got ${result3.rowsLoaded})`);
  assert(result3.rowsErrored === 2, `2 errored (got ${result3.rowsErrored})`);

  // ──────────────────────────────────
  // 4. Tenant isolation — A's data invisible to B
  // ──────────────────────────────────
  console.log('\n4. Tenant isolation on CSV data');
  const invoicesB = await prisma.invoice.findMany({ where: { tenantId: tenantB.id } });
  assert(invoicesB.length === 0, `Tenant B has 0 invoices (got ${invoicesB.length})`);

  // Upload to B — same invoice numbers, different tenant
  await processCSV(`invoice_number,total\nCSV-001,999.00`, tenantB.id, staffB.id);
  const invoicesBafter = await prisma.invoice.findMany({ where: { tenantId: tenantB.id } });
  assert(invoicesBafter.length === 1, `Tenant B has 1 invoice`);
  assert(Number(invoicesBafter[0].amount) === 999, `Tenant B CSV-001 = $999 (independent from A's $150)`);

  // ──────────────────────────────────
  // 5. Flexible column name matching
  // ──────────────────────────────────
  console.log('\n5. Flexible column name variations');
  const csvSpanish = `factura_numero,monto,fecha,telefono
ESP-001,100.00,2024-06-01,+58412999`;
  const result5 = await processCSV(csvSpanish, tenantA.id, staffA.id);
  assert(result5.rowsLoaded === 1, `Spanish columns parsed (got ${result5.rowsLoaded})`);

  const csvAlt = `order_id,grand_total,timestamp,celular
ALT-001,50.00,2024-06-01,+58412888`;
  const result6 = await processCSV(csvAlt, tenantA.id, staffA.id);
  assert(result6.rowsLoaded === 1, `Alternative columns parsed (got ${result6.rowsLoaded})`);

  // ──────────────────────────────────
  // 6. Uploaded invoices available for consumers to claim
  // ──────────────────────────────────
  console.log('\n6. Uploaded invoices available for claim');
  const claimResult = await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+58412CLAIM1', assetTypeId: asset.id,
    extractedData: { invoice_number: 'CSV-001', total_amount: 150, transaction_date: '2024-03-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(claimResult.success === true, 'Consumer claimed CSV invoice successfully');
  assert(claimResult.valueAssigned === '150.00000000', `Value assigned: ${claimResult.valueAssigned}`);

  const claimed = await prisma.invoice.findFirst({ where: { tenantId: tenantA.id, invoiceNumber: 'CSV-001' } });
  assert(claimed!.status === 'claimed', 'Invoice status changed to "claimed"');

  // ──────────────────────────────────
  // 7. Upload batch tracking
  // ──────────────────────────────────
  console.log('\n7. Upload batch tracking');
  const batches = await prisma.uploadBatch.findMany({ where: { tenantId: tenantA.id }, orderBy: { createdAt: 'asc' } });
  assert(batches.length >= 2, `Multiple batches tracked (got ${batches.length})`);
  assert(batches[0].status === 'completed', 'Batch status: completed');
  assert(batches[0].rowsLoaded !== null, 'rowsLoaded recorded');
  assert(batches[0].rowsSkipped !== null, 'rowsSkipped recorded');
  assert(batches[0].rowsErrored !== null, 'rowsErrored recorded');
  assert(batches[0].uploadedByStaffId === staffA.id, 'Tracked which staff uploaded');

  // ──────────────────────────────────
  // 8. Background processing support
  // ──────────────────────────────────
  console.log('\n8. Background processing (BullMQ queue available)');
  // enqueueCsvJob exists and can queue to Redis when REDIS_URL is set
  const { enqueueCsvJob } = await import('../services/workers.js');
  assert(typeof enqueueCsvJob === 'function', 'enqueueCsvJob function exists for async processing');

  console.log(`\n=== CSV UPLOAD: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
