import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import bcrypt from 'bcryptjs';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
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
  console.log('=== E2E: bonus defaults on a freshly-created tenant ===\n');
  await cleanAll();

  // 1. Direct DB check — the column defaults must be 5000 / 1000.
  const tenant = await createTenant('Brand New', 'brand-new-bonus', 'b@n.com');
  assert(tenant.welcomeBonusAmount === 5000, `Tenant.welcomeBonusAmount = 5000 (got ${tenant.welcomeBonusAmount})`);
  assert(tenant.referralBonusAmount === 1000, `Tenant.referralBonusAmount = 1000 (got ${tenant.referralBonusAmount})`);
  assert(tenant.welcomeBonusActive === true, `welcomeBonusActive defaults true (got ${tenant.welcomeBonusActive})`);
  assert(tenant.referralBonusActive === true, `referralBonusActive defaults true (got ${tenant.referralBonusActive})`);

  // 2. The /api/merchant/settings response surfaces those defaults so the
  //    onboarding wizard step 2 prefills 5.000 / 1.000 — this is the bug
  //    Eric saw (showing 50 / 100 because the column default was the old one).
  await createSystemAccounts(tenant.id);
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@b.com', passwordHash: await bcrypt.hash('x', 10), role: 'owner' },
  });

  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const ownerToken = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;

  const res = await fetch(`http://127.0.0.1:${port}/api/merchant/settings`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const body: any = await res.json();
  assert(res.status === 200, `GET /settings → 200 (got ${res.status})`);
  assert(body.welcomeBonusAmount === 5000, `Settings.welcomeBonusAmount = 5000 (got ${body.welcomeBonusAmount}) — onboarding will show "5.000"`);
  assert(body.referralBonusAmount === 1000, `Settings.referralBonusAmount = 1000 (got ${body.referralBonusAmount}) — onboarding will show "1.000"`);
  assert(body.welcomeBonusActive === true, `welcomeBonusActive = true`);
  assert(body.referralBonusActive === true, `referralBonusActive = true`);
  assert(body.welcomeBonusLimit === null, `welcomeBonusLimit = null (no cap by default)`);
  assert(body.referralBonusLimit === null, `referralBonusLimit = null (no cap by default)`);

  await app.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
