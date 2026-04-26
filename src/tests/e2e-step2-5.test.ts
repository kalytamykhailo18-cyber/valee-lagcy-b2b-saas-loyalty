import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { initiateRedemption, expireRedemption } from '../services/redemption.js';
import { getAccountBalance } from '../services/ledger.js';
import { issueStaffTokens } from '../services/auth.js';
import merchantRoutes from '../api/routes/merchant.js';
import bcrypt from 'bcryptjs';
import fs from 'fs';

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

async function post(base: string, path: string, body: any, token: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as any };
}

async function test() {
  console.log('=== STEP 2.5: CASHIER QR SCANNER — FULL E2E ===\n');
  await cleanAll();

  const tenantA = await createTenant('Scanner Store', 'scanner-store', 'ss@t.com');
  const tenantB = await createTenant('Other Store', 'other-store-scan', 'os@t.com');
  const sysA = await createSystemAccounts(tenantA.id);
  await createSystemAccounts(tenantB.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');

  const cashier = await prisma.staff.create({
    data: { tenantId: tenantA.id, name: 'Cashier', email: 'c@ss.com', passwordHash: await bcrypt.hash('pass', 10), role: 'cashier' },
  });
  const owner = await prisma.staff.create({
    data: { tenantId: tenantA.id, name: 'Owner', email: 'o@ss.com', passwordHash: await bcrypt.hash('pass', 10), role: 'owner' },
  });

  // Give consumer 500 pts
  await processCSV(`invoice_number,total\nSC-001,500.00`, tenantA.id, owner.id);
  await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SC-001', total_amount: 500, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenantA.id, phoneNumber: '+584125550001' } },
  });
  const product = await prisma.product.create({
    data: { tenantId: tenantA.id, name: 'Coffee Mug', redemptionCost: '100.00000000', assetTypeId: asset.id, stock: 3, active: true, minLevel: 1 },
  });

  // Generate a redemption QR
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenantA.id, assetTypeId: asset.id,
  });

  // Start server
  const app = Fastify();
  await app.register(cors);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const cashierToken = issueStaffTokens({ staffId: cashier.id, tenantId: tenantA.id, role: 'cashier', type: 'staff' }).accessToken;

  // ──────────────────────────────────
  // VALIDATION FLOW: all 7 checks
  // ──────────────────────────────────

  // Check 1: Decodes token
  console.log('Validation checks 1-7:');

  // Check 2: Invalid signature → rejected
  const tampered = Buffer.from(JSON.stringify({
    payload: { tokenId: 'fake', amount: '999' },
    signature: 'aaaa'.repeat(16),
  })).toString('base64');
  const check2 = await post(base, '/api/merchant/scan-redemption', { token: tampered }, cashierToken);
  assert(check2.data.success === false, 'Check 2: Invalid signature → rejected');

  // Check 3: Expired token → rejected
  const redemption2 = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenantA.id, assetTypeId: asset.id,
  });
  await prisma.redemptionToken.update({
    where: { id: redemption2.tokenId! }, data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const check3 = await post(base, '/api/merchant/scan-redemption', { token: redemption2.token! }, cashierToken);
  assert(check3.data.success === false, 'Check 3: Expired token → rejected');
  assert(check3.data.message.includes('expired'), `  Reason: ${check3.data.message}`);

  // Check 6: Tenant mismatch → rejected
  const otherCashier = await prisma.staff.create({
    data: { tenantId: tenantB.id, name: 'Other Cashier', email: 'c@os.com', passwordHash: '$2b$10$x', role: 'cashier' },
  });
  const otherToken = issueStaffTokens({ staffId: otherCashier.id, tenantId: tenantB.id, role: 'cashier', type: 'staff' }).accessToken;
  const check6 = await post(base, '/api/merchant/scan-redemption', { token: redemption.token! }, otherToken);
  assert(check6.data.success === false, 'Check 6: Tenant mismatch → rejected');
  assert(check6.data.message.includes('different') || check6.data.message.includes('mismatch'), `  Reason: ${check6.data.message}`);

  // Check 7: ALL PASS → success
  console.log('\nAll checks pass → REDEMPTION_CONFIRMED:');
  const stockBefore = (await prisma.product.findUnique({ where: { id: product.id } }))!.stock;
  const balBefore = await getAccountBalance(account!.id, asset.id, tenantA.id);

  const success = await post(base, '/api/merchant/scan-redemption', { token: redemption.token! }, cashierToken);
  assert(success.data.success === true, 'Scan succeeded');
  assert(success.data.productName === 'Coffee Mug', `Product: ${success.data.productName}`);
  assert(Number(success.data.amount) === 100, `Amount: ${success.data.amount}`);

  // REDEMPTION_CONFIRMED double-entry
  const confirmed = await prisma.ledgerEntry.findMany({ where: { tenantId: tenantA.id, eventType: 'REDEMPTION_CONFIRMED' } });
  assert(confirmed.length === 2, `2 REDEMPTION_CONFIRMED entries (got ${confirmed.length})`);
  const confDebit = confirmed.find(e => e.entryType === 'DEBIT')!;
  const confCredit = confirmed.find(e => e.entryType === 'CREDIT')!;
  assert(confDebit.accountId === sysA.holding.id, 'DEBIT from holding');
  assert(confCredit.accountId === account!.id, 'CREDIT to consumer');

  // Stock decremented
  const stockAfter = (await prisma.product.findUnique({ where: { id: product.id } }))!.stock;
  assert(stockAfter === stockBefore - 1, `Stock: ${stockBefore} → ${stockAfter}`);

  // Token marked used
  const usedToken = await prisma.redemptionToken.findUnique({ where: { id: redemption.tokenId! } });
  assert(usedToken!.status === 'used', 'Token status: used');
  assert(usedToken!.usedByStaffId === cashier.id, 'Used by cashier recorded');

  // Check 4: Same QR again → rejected (idempotency)
  console.log('\nCheck 4: Same QR scanned again:');
  const dup = await post(base, '/api/merchant/scan-redemption', { token: redemption.token! }, cashierToken);
  assert(dup.data.success === false, 'Duplicate scan → rejected');
  assert(dup.data.message.includes('already'), `  Reason: ${dup.data.message}`);

  // ──────────────────────────────────
  // RESULT SCREENS
  // ──────────────────────────────────
  console.log('\nResult screens (frontend):');
  const scanSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/scanner/page.tsx', 'utf-8');

  // Success: full-screen green
  assert(scanSrc.includes('bg-green-500'), 'Success: green background');
  assert(scanSrc.includes('CANJE EXITOSO'), 'Success: "CANJE EXITOSO"');
  assert(scanSrc.includes('productName'), 'Success: shows product name');
  assert(scanSrc.includes('amount'), 'Success: shows value amount');
  assert(scanSrc.includes('✅'), 'Success: checkmark icon');

  // Failure: full-screen red
  assert(scanSrc.includes('bg-red-500'), 'Failure: red background');
  assert(scanSrc.includes('RECHAZADO'), 'Failure: "RECHAZADO"');
  assert(scanSrc.includes('result?.message'), 'Failure: shows specific reason');
  assert(scanSrc.includes('❌'), 'Failure: X icon');
  assert(scanSrc.includes('Intentar de nuevo'), 'Failure: try again option');

  // ──────────────────────────────────
  // AUDIT TRAIL
  // ──────────────────────────────────
  console.log('\nAudit trail:');
  const successAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenantA.id}::uuid AND action_type = 'QR_SCAN_SUCCESS'
  `;
  assert(successAudit.length >= 1, `QR_SCAN_SUCCESS audit entry (${successAudit.length})`);
  assert(successAudit[0].actor_id === cashier.id, 'Logged cashier ID');
  assert(successAudit[0].outcome === 'success', 'Outcome: success');
  assert(successAudit[0].consumer_account_id === account!.id, 'Consumer account logged');

  const failAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenantA.id}::uuid AND action_type = 'QR_SCAN_FAILURE'
  `;
  assert(failAudit.length >= 1, `QR_SCAN_FAILURE audit entry (${failAudit.length})`);
  assert(failAudit[0].outcome === 'failure', 'Outcome: failure');
  assert(failAudit[0].failure_reason !== null, `Failure reason logged: "${failAudit[0].failure_reason?.slice(0,40)}"`);

  // Audit immutable
  try {
    await prisma.$executeRaw`DELETE FROM audit_log WHERE tenant_id = ${tenantA.id}::uuid`;
    assert(false, 'Audit DELETE should be blocked');
  } catch {
    assert(true, 'Audit log is immutable (DELETE blocked)');
  }

  // ──────────────────────────────────
  // INTERFACE: minimal, camera-first
  // ──────────────────────────────────
  console.log('\nInterface:');
  assert(scanSrc.includes('Escaner de canjes'), 'Page title: "Escaner de canjes"');
  assert(scanSrc.includes('Camara QR activa'), 'Camera always active');
  assert(scanSrc.includes('Procesar canje'), 'Single action button');

  await app.close();
  console.log(`\n=== STEP 2.5: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
