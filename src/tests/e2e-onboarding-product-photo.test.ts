import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import bcrypt from 'bcryptjs';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
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
  console.log('=== E2E: onboarding product photo round-trips to consumer welcome ===\n');
  await cleanAll();

  const tenant = await createTenant('Hotel Herrera', 'hotel-herrera', 'h@h.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '100');
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: '100' },
  });
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@h.com', passwordHash: await bcrypt.hash('x', 10), role: 'owner' },
  });

  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const ownerToken = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;

  // 1. Create product via the same endpoint the onboarding wizard now uses,
  //    with a photoUrl in the payload (this is the field Genesis flagged was
  //    missing from the wizard).
  const photoUrl = 'https://res.cloudinary.com/valee-test/image/upload/v1/cafe-test.jpg';
  const createRes = await fetch(`http://127.0.0.1:${port}/api/merchant/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      name: 'Cafe gratis',
      redemptionCost: '100',
      assetTypeId: asset.id,
      stock: 10,
      active: true,
      photoUrl,
    }),
  });
  const createBody: any = await createRes.json();
  assert(createRes.status === 200 || createRes.status === 201, `Create product → 2xx (got ${createRes.status})`);
  assert(createBody.product?.photoUrl === photoUrl, `Returned product carries photoUrl (got "${createBody.product?.photoUrl}")`);

  // 2. The DB row has the photoUrl persisted.
  const dbRow = await prisma.product.findFirst({ where: { tenantId: tenant.id, name: 'Cafe gratis' } });
  assert(dbRow?.photoUrl === photoUrl, `DB product row has photoUrl (got "${dbRow?.photoUrl}")`);

  // 3. The consumer welcome card filters products with `active && photoUrl`
  //    and shows up to 4. A product with photo qualifies.
  const previewable = await prisma.product.findMany({
    where: { tenantId: tenant.id, active: true, photoUrl: { not: null } },
    select: { id: true, name: true, photoUrl: true },
    take: 4,
  });
  assert(previewable.length === 1, `Welcome card preview pool has 1 photo product (got ${previewable.length})`);
  assert(previewable[0].photoUrl === photoUrl, `Preview surfaces the same Cloudinary URL`);

  // 4. A product created without a photo (skip-photo path) still works but
  //    does NOT appear in the welcome card preview.
  await fetch(`http://127.0.0.1:${port}/api/merchant/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      name: 'Producto sin foto',
      redemptionCost: '50',
      assetTypeId: asset.id,
      stock: 5,
      active: true,
    }),
  });
  const allProducts = await prisma.product.count({ where: { tenantId: tenant.id } });
  assert(allProducts === 2, `2 products total (got ${allProducts})`);
  const previewable2 = await prisma.product.count({
    where: { tenantId: tenant.id, active: true, photoUrl: { not: null } },
  });
  assert(previewable2 === 1, `Welcome preview still 1 (no-photo product excluded) — got ${previewable2}`);

  await app.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
