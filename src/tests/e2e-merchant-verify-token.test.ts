import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { issueStaffTokens } from '../services/auth.js';
import merchantRoutes from '../api/routes/merchant.js';
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
  console.log('=== MERCHANT VERIFIES OUTPUT TOKEN ===\n');
  await cleanAll();

  const tenantA = await createTenant('Verify Store', 'verify-store', 'vs@t.com');
  const tenantB = await createTenant('Other Store', 'other-store-vt', 'os@t.com');
  await createSystemAccounts(tenantA.id);
  await createSystemAccounts(tenantB.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');

  const staffA = await prisma.staff.create({
    data: { tenantId: tenantA.id, name: 'Owner A', email: 'o@vs.com', passwordHash: await bcrypt.hash('pass', 10), role: 'owner' },
  });
  const staffB = await prisma.staff.create({
    data: { tenantId: tenantB.id, name: 'Owner B', email: 'o@os.com', passwordHash: await bcrypt.hash('pass', 10), role: 'owner' },
  });

  await processCSV(`invoice_number,total\nVER-001,350.00`, tenantA.id, staffA.id);

  // Consumer validates invoice → gets token
  const valResult = await validateInvoice({
    tenantId: tenantA.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'VER-001', total_amount: 350, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(valResult.outputToken !== undefined, 'Consumer received outputToken');

  // Start test Fastify server
  const app = Fastify();
  await app.register(cors);
  await app.register(cookie);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const tokenA = issueStaffTokens({ staffId: staffA.id, tenantId: tenantA.id, role: 'owner', type: 'staff' }).accessToken;
  const tokenB = issueStaffTokens({ staffId: staffB.id, tenantId: tenantB.id, role: 'owner', type: 'staff' }).accessToken;

  // ──────────────────────────────────
  // 1. Merchant scans token → confirms validation event occurred
  // ──────────────────────────────────
  console.log('1. Merchant scans token → confirms event in ledger');
  const verifyRes = await fetch(`${base}/api/merchant/verify-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ token: valResult.outputToken }),
  });
  const verifyData = await verifyRes.json() as any;

  assert(verifyRes.ok, `HTTP 200 (got ${verifyRes.status})`);
  assert(verifyData.valid === true, 'Token is valid');
  assert(verifyData.ledgerEntry.eventType === 'INVOICE_CLAIMED', `Event: ${verifyData.ledgerEntry.eventType}`);
  assert(verifyData.ledgerEntry.referenceId === 'VER-001', `Reference: ${verifyData.ledgerEntry.referenceId}`);
  assert(Number(verifyData.ledgerEntry.amount) === 350, `Amount: ${verifyData.ledgerEntry.amount}`);
  assert(verifyData.ledgerEntry.status === 'confirmed', `Status: ${verifyData.ledgerEntry.status}`);
  assert(!!verifyData.ledgerEntry.createdAt, 'Timestamp present');
  assert(verifyData.payload.consumerAccountId !== undefined, 'Consumer account in payload');

  // ──────────────────────────────────
  // 2. Tampered token → rejected
  // ──────────────────────────────────
  console.log('\n2. Tampered token → rejected');
  const tamperedRes = await fetch(`${base}/api/merchant/verify-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ token: valResult.outputToken!.slice(0, -3) + 'XXX' }),
  });
  const tamperedData = await tamperedRes.json() as any;
  assert(tamperedRes.status === 400, `Tampered → 400 (got ${tamperedRes.status})`);
  assert(tamperedData.valid === false, 'Tampered → invalid');

  // ──────────────────────────────────
  // 3. Different merchant cannot verify another tenant's token
  // ──────────────────────────────────
  console.log('\n3. Cross-tenant verification blocked');
  const crossRes = await fetch(`${base}/api/merchant/verify-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({ token: valResult.outputToken }),
  });
  const crossData = await crossRes.json() as any;
  assert(crossRes.status === 403, `Cross-tenant → 403 (got ${crossRes.status})`);
  assert(crossData.valid === false, 'Cross-tenant → invalid');
  assert(crossData.reason.includes('different merchant'), `Reason: ${crossData.reason}`);

  // ──────────────────────────────────
  // 4. Unauthenticated request rejected
  // ──────────────────────────────────
  console.log('\n4. Unauthenticated → 401');
  const noAuthRes = await fetch(`${base}/api/merchant/verify-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: valResult.outputToken }),
  });
  assert(noAuthRes.status === 401, `No auth → 401 (got ${noAuthRes.status})`);

  await app.close();
  console.log(`\n=== MERCHANT VERIFY: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
