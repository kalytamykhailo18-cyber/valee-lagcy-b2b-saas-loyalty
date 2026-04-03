import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { initiateRedemption, expireRedemption } from '../services/redemption.js';
import { getAccountBalance } from '../services/ledger.js';
import { issueConsumerTokens, issueStaffTokens } from '../services/auth.js';
import consumerRoutes from '../api/routes/consumer.js';
import merchantRoutes from '../api/routes/merchant.js';
import { createHmac } from 'crypto';
import bcrypt from 'bcryptjs';
import fs from 'fs';

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
  console.log('=== STEP 2.5: CASHIER QR SCANNER — DEEP E2E ===\n');
  await cleanAll();

  const tenantA = await createTenant('Scanner Store', 'scanner-store', 'ss@t.com');
  const tenantB = await createTenant('Other Store', 'other-store-25', 'os@t.com');
  const sysA = await createSystemAccounts(tenantA.id);
  await createSystemAccounts(tenantB.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staffA = await prisma.staff.create({
    data: { tenantId: tenantA.id, name: 'Cashier A', email: 'c@ss.com', passwordHash: await bcrypt.hash('pass', 10), role: 'cashier' },
  });
  const ownerA = await prisma.staff.create({
    data: { tenantId: tenantA.id, name: 'Owner A', email: 'o@ss.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  const staffB = await prisma.staff.create({
    data: { tenantId: tenantB.id, name: 'Cashier B', email: 'c@os.com', passwordHash: await bcrypt.hash('pass', 10), role: 'cashier' },
  });

  // Give consumer 500 pts
  await processCSV(`invoice_number,total\nSS-001,500.00`, tenantA.id, ownerA.id);
  await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SS-001', total_amount: 500, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenantA.id, phoneNumber: '+584125550001' } },
  });
  const product = await prisma.product.create({
    data: { tenantId: tenantA.id, name: 'Test Prize', redemptionCost: '100.00000000', assetTypeId: asset.id, stock: 3, active: true, minLevel: 1 },
  });

  // Generate a redemption QR
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenantA.id, assetTypeId: asset.id,
  });

  // Start server
  const app = Fastify();
  await app.register(cors);
  await app.register(cookie);
  await app.register(consumerRoutes);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const cashierTokenA = issueStaffTokens({ staffId: staffA.id, tenantId: tenantA.id, role: 'cashier', type: 'staff' }).accessToken;
  const cashierTokenB = issueStaffTokens({ staffId: staffB.id, tenantId: tenantB.id, role: 'cashier', type: 'staff' }).accessToken;

  // ──────────────────────────────────
  // VALIDATION CHECKS 1-7
  // ──────────────────────────────────

  // Check 1: Decodes the token
  console.log('Check 1: Decode token');
  const decoded = JSON.parse(Buffer.from(redemption.token!, 'base64').toString('utf-8'));
  assert(!!decoded.payload, 'Token decoded successfully');
  assert(!!decoded.signature, 'Signature present');

  // Check 2: Verify HMAC signature
  console.log('\nCheck 2: HMAC signature verification');
  const expectedSig = createHmac('sha256', process.env.HMAC_SECRET!)
    .update(JSON.stringify(decoded.payload)).digest('hex');
  assert(decoded.signature === expectedSig, 'Signature matches');

  // Tampered token → rejected
  const tampered = Buffer.from(JSON.stringify({
    payload: { ...decoded.payload, amount: '999999' },
    signature: decoded.signature,
  })).toString('base64');
  const tamperedRes = await fetch(`${base}/api/merchant/scan-redemption`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierTokenA}` },
    body: JSON.stringify({ token: tampered }),
  });
  const tamperedData = await tamperedRes.json() as any;
  assert(tamperedData.success === false, 'Tampered token rejected');
  assert(tamperedData.message.includes('signature') || tamperedData.message.includes('Invalid'), `Reason: ${tamperedData.message}`);

  // Check 3: TTL check (expired)
  console.log('\nCheck 3: TTL expiry check');
  const redemption2 = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenantA.id, assetTypeId: asset.id,
  });
  await prisma.redemptionToken.update({
    where: { id: redemption2.tokenId! }, data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expiredRes = await fetch(`${base}/api/merchant/scan-redemption`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierTokenA}` },
    body: JSON.stringify({ token: redemption2.token }),
  });
  const expiredData = await expiredRes.json() as any;
  assert(expiredData.success === false, 'Expired QR rejected');
  assert(expiredData.message.includes('expired') || expiredData.message.includes('Expired'), `Reason: ${expiredData.message}`);

  // Check 4: Idempotency (scan twice)
  console.log('\nCheck 4: Idempotency — cannot scan twice');
  // First scan the valid token
  const scanRes1 = await fetch(`${base}/api/merchant/scan-redemption`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierTokenA}` },
    body: JSON.stringify({ token: redemption.token }),
  });
  const scanData1 = await scanRes1.json() as any;
  assert(scanData1.success === true, 'First scan succeeds');

  // Second scan same token
  const scanRes2 = await fetch(`${base}/api/merchant/scan-redemption`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierTokenA}` },
    body: JSON.stringify({ token: redemption.token }),
  });
  const scanData2 = await scanRes2.json() as any;
  assert(scanData2.success === false, 'Second scan rejected');
  assert(scanData2.message.includes('already'), `Reason: ${scanData2.message}`);

  // Check 5: Pending redemption matches
  console.log('\nCheck 5: Pending redemption verified');
  const confirmedEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenantA.id, eventType: 'REDEMPTION_CONFIRMED' },
  });
  assert(confirmedEntries.length === 2, `2 REDEMPTION_CONFIRMED entries (${confirmedEntries.length})`);

  // Check 6: Tenant match
  console.log('\nCheck 6: Tenant mismatch rejected');
  const redemption3 = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenantA.id, assetTypeId: asset.id,
  });
  const crossRes = await fetch(`${base}/api/merchant/scan-redemption`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierTokenB}` },
    body: JSON.stringify({ token: redemption3.token }),
  });
  const crossData = await crossRes.json() as any;
  assert(crossData.success === false, 'Cross-tenant scan rejected');
  assert(crossData.message.includes('mismatch') || crossData.message.includes('different'), `Reason: ${crossData.message}`);

  // Check 7: Success → REDEMPTION_CONFIRMED + stock decrement
  console.log('\nCheck 7: Success flow');
  assert(scanData1.productName === 'Test Prize', `Product: ${scanData1.productName}`);
  const productAfter = await prisma.product.findUnique({ where: { id: product.id } });
  assert(productAfter!.stock === 2, `Stock: 3 → 2 (got ${productAfter!.stock})`);

  // ──────────────────────────────────
  // RESULT SCREENS (frontend)
  // ──────────────────────────────────
  console.log('\nResult screens (frontend)');
  const scannerSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/scanner/page.tsx', 'utf-8');
  assert(scannerSrc.includes('bg-green-500'), 'Success: full-screen green');
  assert(scannerSrc.includes('CANJE EXITOSO'), 'Success: "CANJE EXITOSO"');
  assert(scannerSrc.includes('productName'), 'Success: shows product name');
  assert(scannerSrc.includes('amount'), 'Success: shows value amount');
  assert(scannerSrc.includes('bg-red-500'), 'Failure: full-screen red');
  assert(scannerSrc.includes('RECHAZADO'), 'Failure: "RECHAZADO"');
  assert(scannerSrc.includes('result?.message'), 'Failure: shows specific reason');

  // ──────────────────────────────────
  // AUDIT TRAIL
  // ──────────────────────────────────
  console.log('\nAudit trail');
  const successAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenantA.id}::uuid AND action_type = 'QR_SCAN_SUCCESS'
  `;
  assert(successAudit.length >= 1, `QR_SCAN_SUCCESS audit entry (${successAudit.length})`);
  assert(successAudit[0].actor_id === staffA.id, 'Audit records cashier ID');
  assert(successAudit[0].outcome === 'success', 'Audit outcome: success');

  const failAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenantA.id}::uuid AND action_type = 'QR_SCAN_FAILURE'
  `;
  assert(failAudit.length >= 1, `QR_SCAN_FAILURE audit entry (${failAudit.length})`);

  // Audit is immutable
  try {
    await prisma.$executeRaw`DELETE FROM audit_log WHERE tenant_id = ${tenantA.id}::uuid`;
    assert(false, 'Audit DELETE should be blocked');
  } catch {
    assert(true, 'Audit log immutable (DELETE blocked)');
  }

  // ──────────────────────────────────
  // BALANCE UPDATED
  // ──────────────────────────────────
  console.log('\nBalance after scan');
  const balAfter = await getAccountBalance(account!.id, asset.id, tenantA.id);
  // Started 500, two PENDING_REDEMPTION (-100 each), one confirmed, one expired token pending
  // 500 - 100 (confirmed) - 100 (pending from redemption3) = 300
  assert(Number(balAfter) <= 400, `Balance reduced after redemption (got ${balAfter})`);

  await app.close();
  console.log(`\n=== STEP 2.5: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
