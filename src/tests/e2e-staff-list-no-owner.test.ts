import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import bcrypt from 'bcryptjs';
import { createTenant } from '../services/tenants.js';
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
  console.log('=== E2E: GET /staff omits owner; POST /staff rejects role=owner ===\n');
  await cleanAll();

  const tenant = await createTenant('Granja', 'granja-test', 'g@g.com');
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Victoria', email: 'victoria@valee.app', passwordHash: await bcrypt.hash('x', 10), role: 'owner' },
  });
  await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Eric', email: 'eric@valee.app', passwordHash: await bcrypt.hash('x', 10), role: 'cashier' },
  });

  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const ownerToken = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;

  // 1. GET /api/merchant/staff must NOT return the owner row anymore.
  const listRes = await fetch(`http://127.0.0.1:${port}/api/merchant/staff`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const listBody: any = await listRes.json();
  assert(listRes.status === 200, `GET /staff → 200 (got ${listRes.status})`);
  assert(Array.isArray(listBody.staff), 'staff field is array');
  const ownerRow = listBody.staff.find((s: any) => s.role === 'owner');
  assert(!ownerRow, `Owner row NOT in staff list (got: ${ownerRow ? ownerRow.name : 'absent'})`);
  const cashierRow = listBody.staff.find((s: any) => s.email === 'eric@valee.app');
  assert(!!cashierRow, 'Cashier row IS still returned');

  // 2. POST /api/merchant/staff with role='owner' must be rejected.
  const createOwnerRes = await fetch(`http://127.0.0.1:${port}/api/merchant/staff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: 'Mal Actor', email: 'malo@x.com', password: 'pass1234', role: 'owner' }),
  });
  const createOwnerBody: any = await createOwnerRes.json();
  assert(createOwnerRes.status === 400, `Create with role=owner → 400 (got ${createOwnerRes.status})`);
  assert(/Solo se pueden crear cajeros/.test(createOwnerBody.error || ''), `Error message clear (got: "${createOwnerBody.error}")`);

  // 3. POST without role at all defaults to cashier (frontend no longer sends role).
  const createNoRoleRes = await fetch(`http://127.0.0.1:${port}/api/merchant/staff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: 'Juan Perez', email: 'juan@granja.com', password: 'pass1234' }),
  });
  const createNoRoleBody: any = await createNoRoleRes.json();
  assert(createNoRoleRes.status === 200 || createNoRoleRes.status === 201, `Create without role → 2xx (got ${createNoRoleRes.status})`);
  assert(createNoRoleBody.staff?.role === 'cashier', `Default role is cashier (got "${createNoRoleBody.staff?.role}")`);

  // 4. Confirm DB has no new owners after both attempts.
  const ownerCount = await prisma.staff.count({ where: { tenantId: tenant.id, role: 'owner' } });
  assert(ownerCount === 1, `Still exactly 1 owner in DB (got ${ownerCount})`);

  await app.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
