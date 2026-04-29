import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { initiateDualScan, confirmDualScan } from '../services/dual-scan.js';
import { issueStaffTokens } from '../services/auth.js';
import { registerScanRoutes } from '../api/routes/merchant/scan.js';

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

// Mirror the frontend decoder so a regression that breaks the bare-nonce
// branch is caught here, not in the browser. Eric 2026-04-26: cashier never
// saw the success card after the consumer confirmed — JSON.parse(atob(nonce))
// was throwing on the new short-QR token format and the polling effect
// silently bailed out before it ever called the status endpoint.
function decodeDualScanNonce(token: string): string | null {
  if (/^[0-9a-f]{8,32}$/i.test(token)) return token;
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    const n = decoded?.payload?.nonce;
    return typeof n === 'string' ? n : null;
  } catch {
    return null;
  }
}

async function test() {
  console.log('=== E2E: dual-scan merchant sees confirmation after consumer pays ===\n');
  await cleanAll();

  const tenant = await createTenant('Restaurante', 'rest-confirm', 'r@r.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1');
  await setTenantConversionRate(tenant.id, asset.id, '1');

  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Mesonero', email: 'm@r.com', passwordHash: '$2b$10$x', role: 'cashier' },
  });

  // 1. Cashier initiates → server returns a short nonce as token.
  console.log('1. initiateDualScan returns a short nonce as the token');
  const init = await initiateDualScan({
    tenantId: tenant.id,
    cashierId: cashier.id,
    branchId: null,
    amount: '30.00',
    assetTypeId: asset.id,
  });
  assert(init.success === true, 'Initiate succeeded');
  assert(typeof init.token === 'string' && init.token.length <= 32, `Token is short (len=${init.token?.length})`);
  assert(/^[0-9a-f]+$/i.test(init.token!), `Token is plain hex nonce (got "${init.token}")`);

  // 2. Frontend decoder MUST extract the nonce from the bare-nonce form.
  console.log('\n2. Frontend decoder extracts nonce from bare-nonce form');
  const decoded = decodeDualScanNonce(init.token!);
  assert(decoded === init.token, `Decoder returns the same nonce (got "${decoded}")`);

  // 3. Status endpoint returns consumed=false BEFORE the consumer confirms.
  console.log('\n3. Status endpoint returns consumed=false before confirmation');
  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await registerScanRoutes(app);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const cashierToken = issueStaffTokens({ staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff' }).accessToken;

  const beforeRes = await fetch(`http://127.0.0.1:${port}/api/merchant/dual-scan/status/${decoded}`, {
    headers: { Authorization: `Bearer ${cashierToken}` },
  });
  const before: any = await beforeRes.json();
  assert(beforeRes.status === 200, `GET /status → 200 (got ${beforeRes.status})`);
  assert(before.consumed === false, `consumed=false before payment (got ${JSON.stringify(before)})`);

  // 4. Consumer confirms via WhatsApp/PWA flow.
  console.log('\n4. Consumer confirms');
  const conf = await confirmDualScan({ token: init.token!, consumerPhone: '+584125550100' });
  assert(conf.success === true, `Consumer confirmation succeeded (msg: "${conf.message}")`);

  // 5. Status endpoint NOW returns consumed=true with the consumer phone + value.
  console.log('\n5. Status endpoint flips to consumed=true with full payload');
  const afterRes = await fetch(`http://127.0.0.1:${port}/api/merchant/dual-scan/status/${decoded}`, {
    headers: { Authorization: `Bearer ${cashierToken}` },
  });
  const after: any = await afterRes.json();
  assert(after.consumed === true, `consumed=true after payment (got ${JSON.stringify(after)})`);
  assert(parseFloat(after.valueAssigned) > 0, `valueAssigned > 0 (got ${after.valueAssigned})`);
  assert(after.consumerPhone === '+584125550100', `consumerPhone returned (got "${after.consumerPhone}")`);
  assert(typeof after.confirmedAt === 'string', `confirmedAt is a timestamp (got "${after.confirmedAt}")`);

  // 6. Status is tenant-scoped — a cashier from another tenant cannot peek.
  console.log('\n6. Cross-tenant cashier cannot read the status');
  const otherTenant = await createTenant('Otro', 'rest-other', 'o@o.com');
  const otherCashier = await prisma.staff.create({
    data: { tenantId: otherTenant.id, name: 'Otro', email: 'o@x.com', passwordHash: '$2b$10$x', role: 'cashier' },
  });
  const otherToken = issueStaffTokens({ staffId: otherCashier.id, tenantId: otherTenant.id, role: 'cashier', type: 'staff' }).accessToken;
  const crossRes = await fetch(`http://127.0.0.1:${port}/api/merchant/dual-scan/status/${decoded}`, {
    headers: { Authorization: `Bearer ${otherToken}` },
  });
  const cross: any = await crossRes.json();
  assert(cross.consumed === false, `Cross-tenant read sees consumed=false (got ${JSON.stringify(cross)})`);

  // 7. Decoder defensive: legacy base64 token still works (deploy-window safety).
  console.log('\n7. Decoder still accepts legacy base64 token');
  const legacy = Buffer.from(JSON.stringify({ payload: { nonce: 'abc123' }, signature: 'x' })).toString('base64');
  assert(decodeDualScanNonce(legacy) === 'abc123', 'Legacy base64 token decodes to inner nonce');
  assert(decodeDualScanNonce('not-a-valid-token-!!!') === null, 'Garbage input returns null');

  await app.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
