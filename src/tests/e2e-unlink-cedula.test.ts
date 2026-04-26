import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, upgradeToVerified } from '../services/accounts.js';
import { issueStaffTokens, issueAdminTokens } from '../services/auth.js';
import merchantRoutes from '../api/routes/merchant.js';
import adminRoutes from '../api/routes/admin.js';
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
  console.log('=== DOWNGRADE: ONLY ADMIN CAN UNLINK CEDULA ===\n');
  await cleanAll();

  const tenant = await createTenant('Downgrade Store', 'downgrade-store', 'dg@t.com');
  await createSystemAccounts(tenant.id);

  const { account } = await findOrCreateConsumerAccount(tenant.id, '+584125550001');
  await upgradeToVerified(account.id, tenant.id, 'V-12345678');

  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'c@dg.com', passwordHash: await bcrypt.hash('pass', 10), role: 'cashier' },
  });
  const admin = await prisma.adminUser.create({
    data: { name: 'Admin', email: 'admin@dg.com', passwordHash: await bcrypt.hash('admin', 10) },
  });

  const app = Fastify();
  await app.register(cors);
  await app.register(merchantRoutes);
  await app.register(adminRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const cashierToken = issueStaffTokens({ staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff' }).accessToken;
  const adminToken = issueAdminTokens({ adminId: admin.id, type: 'admin' }).accessToken;

  // ──────────────────────────────────
  // 1. Verified account exists
  // ──────────────────────────────────
  console.log('1. Account is verified');
  const before = await prisma.account.findUnique({ where: { id: account.id } });
  assert(before!.accountType === 'verified', `Type: verified`);
  assert(before!.cedula === 'V-12345678', `Cedula: ${before!.cedula}`);

  // ──────────────────────────────────
  // 2. No merchant/cashier route can downgrade
  // ──────────────────────────────────
  console.log('\n2. No merchant route for downgrade');
  // The identity-upgrade route only goes shadow→verified
  const upgradeAgain = await fetch(`${base}/api/merchant/identity-upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
    body: JSON.stringify({ phoneNumber: '+584125550001', cedula: '' }),
  });
  const upgradeData = await upgradeAgain.json() as any;
  assert(upgradeData.error?.includes('already verified') || upgradeAgain.status === 400, 'Cashier cannot downgrade via upgrade route');

  // No unlink route for merchants
  const merchantUnlink = await fetch(`${base}/api/admin/unlink-cedula`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
    body: JSON.stringify({ accountId: account.id, tenantId: tenant.id, reason: 'test' }),
  });
  assert(merchantUnlink.status === 401 || merchantUnlink.status === 403, `Cashier cannot access admin unlink: ${merchantUnlink.status}`);

  // ──────────────────────────────────
  // 3. Admin CAN unlink cédula
  // ──────────────────────────────────
  console.log('\n3. Admin can unlink cédula');
  const unlinkRes = await fetch(`${base}/api/admin/unlink-cedula`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ accountId: account.id, tenantId: tenant.id, reason: 'Customer requested reset' }),
  });
  const unlinkData = await unlinkRes.json() as any;
  assert(unlinkRes.ok, `Admin unlink: 200 (got ${unlinkRes.status})`);
  assert(unlinkData.success === true, 'Unlink succeeded');
  assert(unlinkData.account.accountType === 'shadow', `Downgraded to: shadow`);
  assert(unlinkData.account.cedula === null, `Cedula removed: null`);

  // Verify in DB
  const after = await prisma.account.findUnique({ where: { id: account.id } });
  assert(after!.accountType === 'shadow', 'DB: accountType = shadow');
  assert(after!.cedula === null, 'DB: cedula = null');

  // Audit log
  const auditEntries = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE consumer_account_id = ${account.id}::uuid
    AND metadata::text LIKE '%unlink_cedula%'
  `;
  assert(auditEntries.length === 1, 'Unlink action audited');
  assert(auditEntries[0].metadata?.reason === 'Customer requested reset', `Reason logged: ${auditEntries[0].metadata?.reason}`);
  assert(auditEntries[0].metadata?.previousCedula === 'V-12345678', 'Previous cedula logged');

  // ──────────────────────────────────
  // 4. After unlink, can re-verify with new cédula
  // ──────────────────────────────────
  console.log('\n4. After unlink → can re-verify');
  await upgradeToVerified(account.id, tenant.id, 'V-99999999');
  const reVerified = await prisma.account.findUnique({ where: { id: account.id } });
  assert(reVerified!.accountType === 'verified', 'Re-verified');
  assert(reVerified!.cedula === 'V-99999999', `New cedula: ${reVerified!.cedula}`);

  await app.close();
  console.log(`\n=== UNLINK CEDULA: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
