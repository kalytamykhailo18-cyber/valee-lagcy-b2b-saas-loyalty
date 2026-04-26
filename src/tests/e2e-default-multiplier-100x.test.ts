import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import bcrypt from 'bcryptjs';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { convertToLoyaltyValue } from '../services/assets.js';
import { issueStaffTokens } from '../services/auth.js';
import merchantRoutes from '../api/routes/merchant.js';

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
  console.log('=== E2E: new tenant default multiplier = 100x (10% cashback) ===\n');
  await cleanAll();

  // Asset type freshly created — must default to 100x to match the new
  // platform-wide default (Eric 2026-04-25).
  const asset = await createAssetType('Points', 'pts', '100');
  assert(asset.defaultConversionRate.toString() === '100', `New AssetType defaults to 100 (got ${asset.defaultConversionRate})`);

  const tenant = await createTenant('Brand New Comercio', 'brand-new', 'b@n.com');
  await createSystemAccounts(tenant.id);
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@b.com', passwordHash: await bcrypt.hash('x', 10), role: 'owner' },
  });

  // 1. The merchant has NOT touched multiplier yet — no tenantAssetConfig row.
  //    The /api/merchant/multiplier endpoint must report 100x as currentRate
  //    so the dashboard greets them with "100x = 10% cashback".
  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const ownerToken = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;

  const res = await fetch(`http://127.0.0.1:${port}/api/merchant/multiplier`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const body: any = await res.json();
  assert(res.status === 200, `GET /multiplier → 200 (got ${res.status})`);
  assert(body.currentRate === '100', `currentRate === '100' for fresh tenant (got "${body.currentRate}")`);
  assert(body.defaultRate === '100', `defaultRate === '100' (got "${body.defaultRate}")`);

  // 2. The conversion math actually applies 100x. $1 invoice → 100 points.
  const points1usd = await convertToLoyaltyValue('1', tenant.id, asset.id, undefined, 'reference');
  assert(points1usd === '100', `$1 → 100 pts (got ${points1usd})`);

  // 3. $10 → 1000 points (matches the dashboard preview text).
  const points10usd = await convertToLoyaltyValue('10', tenant.id, asset.id, undefined, 'reference');
  assert(points10usd === '1000', `$10 → 1000 pts (got ${points10usd})`);

  // 4. Merchant overrides to 50x (5% cashback) → conversion follows the override.
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: '50' },
  });
  const points1at50 = await convertToLoyaltyValue('1', tenant.id, asset.id, undefined, 'reference');
  assert(points1at50 === '50', `Override 50x → $1 = 50 pts (got ${points1at50})`);

  // 5. The endpoint reflects the override (currentRate=50, defaultRate stays 100).
  const res2 = await fetch(`http://127.0.0.1:${port}/api/merchant/multiplier`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const body2: any = await res2.json();
  assert(body2.currentRate === '50', `Override reflected: currentRate === '50' (got "${body2.currentRate}")`);
  assert(body2.defaultRate === '100', `Default platform-wide stays 100 (got "${body2.defaultRate}")`);

  await app.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
