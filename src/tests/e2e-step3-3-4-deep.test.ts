import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice, createPendingValidation } from '../services/invoice-validation.js';
import { initiateRedemption, processRedemption } from '../services/redemption.js';
import { getAccountBalance } from '../services/ledger.js';
import { runReconciliation } from '../services/reconciliation.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../services/idempotency.js';
import { issueStaffTokens, issueAdminTokens } from '../services/auth.js';
import merchantRoutes from '../api/routes/merchant.js';
import adminRoutes from '../api/routes/admin.js';
import consumerRoutes from '../api/routes/consumer.js';
import bcrypt from 'bcryptjs';

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
  console.log('=== STEPS 3.3 + 3.4: IDEMPOTENCY + RECONCILIATION — DEEP E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Idemp Store', 'idemp-store', 'id@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@id.com', passwordHash: await bcrypt.hash('pass', 10), role: 'owner' },
  });
  const admin = await prisma.adminUser.create({
    data: { name: 'Admin', email: 'admin@id.com', passwordHash: await bcrypt.hash('admin', 10) },
  });

  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(consumerRoutes); await app.register(merchantRoutes); await app.register(adminRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const ownerToken = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;
  const adminToken = issueAdminTokens({ adminId: admin.id, type: 'admin' }).accessToken;

  // ══════════════════════════════════
  // STEP 3.3: TRANSACTION IDEMPOTENCY
  // ══════════════════════════════════
  console.log('══ STEP 3.3: TRANSACTION IDEMPOTENCY ══\n');

  // ── 1. Invoice: same invoice cannot be claimed twice ──
  console.log('1. Invoice idempotency (DB unique constraint)');
  await processCSV(`invoice_number,total\nIDP-001,100.00`, tenant.id, owner.id);
  const v1 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'IDP-001', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(v1.success === true, 'First claim succeeds');

  const v2 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'IDP-001', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(v2.success === false, 'Second claim rejected');
  assert(v2.message.includes('already'), 'Reason: already used');

  const entries1 = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, referenceId: 'IDP-001' } });
  assert(entries1.length === 2, `Only 2 entries (not 4) — ${entries1.length}`);

  // ── 2. Redemption: same QR cannot be scanned twice ──
  console.log('\n2. Redemption idempotency (token status check)');
  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Prize', redemptionCost: '10.00000000', assetTypeId: asset.id, stock: 5, active: true, minLevel: 1 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  const scan1 = await processRedemption({ token: redemption.token!, cashierStaffId: owner.id, cashierTenantId: tenant.id });
  assert(scan1.success === true, 'First scan succeeds');

  const scan2 = await processRedemption({ token: redemption.token!, cashierStaffId: owner.id, cashierTenantId: tenant.id });
  assert(scan2.success === false, 'Second scan rejected');

  const confirmedEntries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED' } });
  assert(confirmedEntries.length === 2, `Only 2 REDEMPTION_CONFIRMED (not 4) — ${confirmedEntries.length}`);

  // ── 3. CSV: duplicate rows silently skipped ──
  console.log('\n3. CSV idempotency (ON CONFLICT DO NOTHING)');
  const csv2 = await processCSV(`invoice_number,total\nIDP-001,100.00\nIDP-002,200.00`, tenant.id, owner.id);
  assert(csv2.rowsLoaded === 1, `1 new row (got ${csv2.rowsLoaded})`);
  assert(csv2.rowsSkipped === 1, `1 skipped (got ${csv2.rowsSkipped})`);

  // ── 4. Idempotency key store/retrieve ──
  console.log('\n4. Idempotency key service');
  const check1 = await checkIdempotencyKey('test-key');
  assert(check1 === null, 'Key not found initially');

  await storeIdempotencyKey('test-key', 'test', { data: 'result' });
  const check2 = await checkIdempotencyKey('test-key');
  assert(check2 !== null, 'Key found after storing');
  assert(check2.data === 'result', 'Stored result correct');

  // TTL from .env
  assert(typeof process.env.OFFLINE_QUEUE_TTL_HOURS === 'string', 'OFFLINE_QUEUE_TTL_HOURS in .env');

  // ══════════════════════════════════
  // STEP 3.4: ASYNC RECONCILIATION
  // ══════════════════════════════════
  console.log('\n\n══ STEP 3.4: ASYNC RECONCILIATION ══\n');

  // ── 5. Pending validation when no CSV ──
  console.log('5. Invoice pending when no CSV uploaded');
  const pending = await createPendingValidation({
    tenantId: tenant.id, senderPhone: '+584125550002', invoiceNumber: 'RECON-001',
    totalAmount: 300, assetTypeId: asset.id,
  });
  assert(pending.status === 'pending_validation', 'Status: pending_validation');

  const accPend = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550002' } },
  });
  const provBal = await getAccountBalance(accPend!.id, asset.id, tenant.id);
  assert(Number(provBal) === 300, `Provisional balance: ${provBal}`);

  // Provisional ledger entries
  const provEntries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, referenceId: 'PENDING-RECON-001' } });
  assert(provEntries.length === 2, '2 provisional entries (double-entry)');
  assert(provEntries.every(e => e.status === 'provisional'), 'Both status: provisional');

  // ── 6. Reconciliation stays pending (no CSV yet) ──
  console.log('\n6. Reconciliation — stays pending');
  const recon1 = await runReconciliation();
  assert(recon1.stillPending >= 1, `Still pending: ${recon1.stillPending}`);

  // ── 7. CSV uploaded → confirms pending ──
  console.log('\n7. CSV uploaded → pending confirmed');
  await processCSV(`invoice_number,total\nRECON-001,300.00`, tenant.id, owner.id);
  const recon2 = await runReconciliation();
  assert(recon2.stillPending === 0, `0 still pending (got ${recon2.stillPending})`);

  const confirmedInv = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: 'RECON-001', source: 'photo_submission' },
  });
  assert(confirmedInv!.status === 'claimed', `Invoice confirmed: ${confirmedInv!.status}`);

  // ── 8. Expired pending → reversal ──
  console.log('\n8. Expired pending → reversal');
  const tenant2 = await createTenant('Recon Store 2', 'recon-store-2-deep', 'rc2@t.com');
  await createSystemAccounts(tenant2.id);

  const pending2 = await createPendingValidation({
    tenantId: tenant2.id, senderPhone: '+584125550003', invoiceNumber: 'RECON-002',
    totalAmount: 150, assetTypeId: asset.id,
  });

  // Force past the reconciliation window
  const windowHours = parseInt(process.env.RECONCILIATION_WINDOW_HOURS || '24');
  await prisma.invoice.updateMany({
    where: { tenantId: tenant2.id, invoiceNumber: 'RECON-002', source: 'photo_submission' },
    data: { createdAt: new Date(Date.now() - (windowHours + 1) * 60 * 60 * 1000) },
  });

  const recon3 = await runReconciliation();
  assert(recon3.reversed >= 1, `Reversed: ${recon3.reversed}`);

  const rejectedInv = await prisma.invoice.findFirst({
    where: { tenantId: tenant2.id, invoiceNumber: 'RECON-002', source: 'photo_submission' },
  });
  assert(rejectedInv!.status === 'rejected', `Invoice rejected: ${rejectedInv!.status}`);

  const accRev = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant2.id, phoneNumber: '+584125550003' } },
  });
  const revBal = await getAccountBalance(accRev!.id, asset.id, tenant2.id);
  assert(Number(revBal) === 0, `Balance after reversal: ${revBal}`);

  const reversalEntries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant2.id, eventType: 'REVERSAL' } });
  assert(reversalEntries.length === 2, `2 REVERSAL entries (got ${reversalEntries.length})`);

  // ── 9. Manual review queue — merchant ──
  console.log('\n9. Manual review queue (merchant)');

  // Create a manual_review invoice
  await prisma.invoice.create({
    data: { tenantId: tenant.id, invoiceNumber: 'REVIEW-001', amount: 200, status: 'manual_review',
      source: 'photo_submission', rejectionReason: 'Amount mismatch: $200 vs $150' },
  });

  const reviewRes = await fetch(`${base}/api/merchant/manual-review`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const reviewData = await reviewRes.json() as any;
  assert(reviewRes.ok, 'Manual review queue endpoint works');
  assert(reviewData.invoices.length >= 1, `${reviewData.invoices.length} items in review queue`);
  assert(reviewData.invoices.some((i: any) => i.invoiceNumber === 'REVIEW-001'), 'REVIEW-001 in queue');

  // Reject it
  const reviewInv = reviewData.invoices.find((i: any) => i.invoiceNumber === 'REVIEW-001');
  const resolveRes = await fetch(`${base}/api/merchant/manual-review/${reviewInv.id}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ action: 'reject', reason: 'Receipt does not match our records' }),
  });
  const resolveData = await resolveRes.json() as any;
  assert(resolveRes.ok, `Resolve: ${resolveRes.status}`);
  assert(resolveData.success === true, 'Resolution successful');

  const rejectedReview = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'REVIEW-001' } });
  assert(rejectedReview!.status === 'rejected', 'Invoice rejected after review');

  // ── 10. Manual review queue — admin (cross-tenant) ──
  console.log('\n10. Manual review queue (admin)');
  const adminReviewRes = await fetch(`${base}/api/admin/manual-review`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const adminReviewData = await adminReviewRes.json() as any;
  assert(adminReviewRes.ok, 'Admin manual review endpoint works');

  // ── 11. .env vars used ──
  console.log('\n11. .env variables');
  assert(typeof process.env.RECONCILIATION_WINDOW_HOURS === 'string', 'RECONCILIATION_WINDOW_HOURS');
  assert(typeof process.env.INVOICE_AMOUNT_TOLERANCE === 'string', 'INVOICE_AMOUNT_TOLERANCE');
  assert(typeof process.env.OFFLINE_QUEUE_TTL_HOURS === 'string', 'OFFLINE_QUEUE_TTL_HOURS');

  await app.close();
  console.log(`\n=== STEPS 3.3+3.4: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
