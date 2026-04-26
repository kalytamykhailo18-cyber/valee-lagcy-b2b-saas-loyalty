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
  await prisma.recurrenceNotification.deleteMany(); await prisma.recurrenceRule.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.dispute.deleteMany(); await prisma.redemptionToken.deleteMany();
  await prisma.dualScanSession.deleteMany(); await prisma.staffScanSession.deleteMany();
  await prisma.passwordResetToken.deleteMany();
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
  console.log('=== CSV RECONCILE: pending submissions counted as Cargadas, not Duplicadas ===\n');
  await cleanAll();

  const tenant = await createTenant('Reconcile Store', 'reconcile-store', 'r@s.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@r.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // ──────────────────────────────────
  // Setup: consumer submits 2 invoices via WhatsApp BEFORE any CSV exists.
  // These end up as 'pending_validation' (no CSV row to match against yet).
  // ──────────────────────────────────
  console.log('1. Customer submits 2 photo invoices before CSV upload');
  const v1 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550101', assetTypeId: asset.id,
    extractedData: { invoice_number: 'REC-1001', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const v2 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550102', assetTypeId: asset.id,
    extractedData: { invoice_number: 'REC-1002', total_amount: 200, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(v1.success === true && v2.success === true, 'Both submissions accepted (provisional)');

  const pending = await prisma.invoice.findMany({
    where: { tenantId: tenant.id, status: 'pending_validation' },
    orderBy: { invoiceNumber: 'asc' },
  });
  assert(pending.length === 2, `2 invoices in pending_validation (got ${pending.length})`);

  // ──────────────────────────────────
  // 2. CSV upload includes BOTH pending invoices + 1 brand-new row.
  // Expected:
  //   - REC-1001 → reconciled to 'claimed' → counts as Cargada (was the bug)
  //   - REC-1002 → reconciled to 'claimed' → counts as Cargada
  //   - REC-1003 → new row, inserted → Cargada
  // Total: rowsLoaded=3, rowsSkipped=0, rowsErrored=0
  // ──────────────────────────────────
  console.log('\n2. Upload CSV with the 2 pending + 1 new');
  const csv1 = await processCSV(
    `invoice_number,total\nREC-1001,100.00\nREC-1002,200.00\nREC-1003,300.00`,
    tenant.id, owner.id,
  );
  assert(csv1.rowsLoaded === 3, `rowsLoaded === 3 (got ${csv1.rowsLoaded}) — pending reconciliations count as Cargadas`);
  assert(csv1.rowsSkipped === 0, `rowsSkipped === 0 (got ${csv1.rowsSkipped}) — no duplicates`);
  assert(csv1.rowsErrored === 0, `rowsErrored === 0 (got ${csv1.rowsErrored})`);

  const claimed = await prisma.invoice.count({ where: { tenantId: tenant.id, status: 'claimed' } });
  assert(claimed === 2, `2 invoices flipped to 'claimed' (got ${claimed})`);
  const stillPending = await prisma.invoice.count({ where: { tenantId: tenant.id, status: 'pending_validation' } });
  assert(stillPending === 0, `0 invoices left pending_validation (got ${stillPending})`);
  const available = await prisma.invoice.count({ where: { tenantId: tenant.id, status: 'available' } });
  assert(available === 1, `REC-1003 stored as 'available' (got ${available})`);

  // ──────────────────────────────────
  // 3. True duplicates (already-claimed) still count as Duplicadas.
  // Re-upload all 3: REC-1001 and REC-1002 are now 'claimed', REC-1003 is 'available'.
  // None should reconcile (no pending). All 3 should silently skip via ON CONFLICT.
  // ──────────────────────────────────
  console.log('\n3. Re-upload same CSV — true duplicates skipped');
  const csv2 = await processCSV(
    `invoice_number,total\nREC-1001,100.00\nREC-1002,200.00\nREC-1003,300.00`,
    tenant.id, owner.id,
  );
  assert(csv2.rowsLoaded === 0, `rowsLoaded === 0 (got ${csv2.rowsLoaded}) — already-claimed are not reconciled`);
  assert(csv2.rowsSkipped === 3, `rowsSkipped === 3 (got ${csv2.rowsSkipped}) — true duplicates`);
  assert(csv2.rowsErrored === 0, `rowsErrored === 0 (got ${csv2.rowsErrored})`);

  // ──────────────────────────────────
  // 4. Amount mismatch on a pending invoice → counted as Error, not silently skipped.
  // ──────────────────────────────────
  console.log('\n4. Amount mismatch on pending invoice → reported as error');
  const v3 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550103', assetTypeId: asset.id,
    extractedData: { invoice_number: 'REC-9999', total_amount: 500, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(v3.success === true, 'Mismatched submission accepted (provisional)');

  const csv3 = await processCSV(
    `invoice_number,total\nREC-9999,999.00`,  // CSV says 999, pending says 500 → mismatch
    tenant.id, owner.id,
  );
  assert(csv3.rowsLoaded === 0, `rowsLoaded === 0 (got ${csv3.rowsLoaded})`);
  assert(csv3.rowsSkipped === 0, `rowsSkipped === 0 (got ${csv3.rowsSkipped}) — no longer silently skipped`);
  assert(csv3.rowsErrored === 1, `rowsErrored === 1 (got ${csv3.rowsErrored}) — mismatch reported`);
  assert(
    csv3.errorDetails.length === 1 && /mismatch/i.test(csv3.errorDetails[0].reason),
    `Error reason mentions mismatch (got "${csv3.errorDetails[0]?.reason}")`,
  );

  const stillPendingMis = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'REC-9999' } });
  assert(stillPendingMis?.status === 'pending_validation', 'Mismatched pending invoice stays pending (not silently confirmed)');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
