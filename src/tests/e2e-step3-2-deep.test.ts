import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import prisma from '../db/client.js';
import { createAssetType } from '../services/assets.js';
import { issueAdminTokens } from '../services/auth.js';
import { getAccountBalance } from '../services/ledger.js';
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
  console.log('=== STEP 3.2: ADMIN PANEL — DEEP E2E ===\n');
  await cleanAll();

  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const admin = await prisma.adminUser.create({
    data: { name: 'Eric', email: 'eric@valee.app', passwordHash: await bcrypt.hash('admin123', 10) },
  });

  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(adminRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  // ──────────────────────────────────
  // 1. ADMIN AUTH
  // ──────────────────────────────────
  console.log('1. Admin authentication');
  const loginRes = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'eric@valee.app', password: 'admin123' }),
  });
  const loginData = await loginRes.json() as any;
  assert(loginRes.ok, `Login: ${loginRes.status}`);
  assert(!!loginData.accessToken, 'Access token issued');
  assert(loginData.admin.name === 'Eric', 'Admin name correct');
  const adminToken = loginData.accessToken;

  // Wrong password
  const badLogin = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'eric@valee.app', password: 'wrong' }),
  });
  assert(badLogin.status === 401, `Wrong password: 401 (got ${badLogin.status})`);

  // ──────────────────────────────────
  // 2. TENANT CREATION (full onboarding)
  // ──────────────────────────────────
  console.log('\n2. Create tenant (full onboarding)');
  const createRes = await fetch(`${base}/api/admin/tenants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: 'Panaderia Luna', slug: 'panaderia-luna', ownerEmail: 'luna@test.com',
      ownerName: 'Maria Luna', ownerPassword: 'luna123',
      assetTypeId: asset.id, conversionRate: '1.5',
    }),
  });
  const createData = await createRes.json() as any;
  assert(createRes.ok, `Create tenant: ${createRes.status}`);
  assert(createData.tenant.name === 'Panaderia Luna', 'Tenant name correct');
  assert(createData.tenant.slug === 'panaderia-luna', 'Slug correct');
  const tenantId = createData.tenant.id;

  // Verify system accounts created
  const sysAccounts = await prisma.account.findMany({ where: { tenantId, accountType: 'system' } });
  assert(sysAccounts.length === 2, `2 system accounts (pool + holding)`);

  // Verify owner staff created
  const ownerStaff = await prisma.staff.findFirst({ where: { tenantId, role: 'owner' } });
  assert(ownerStaff !== null, 'Owner staff account created');
  assert(ownerStaff!.email === 'luna@test.com', 'Owner email correct');

  // Verify conversion rate set
  const config = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
  assert(config !== null, 'Conversion rate configured');
  assert(Number(config!.conversionRate) === 1.5, `Rate: 1.5 (got ${config!.conversionRate})`);

  // Verify QR generated
  const tenantWithQR = await prisma.tenant.findUnique({ where: { id: tenantId } });
  assert(tenantWithQR!.qrCodeUrl !== null, 'QR code generated');

  // Verify TENANT_CREATED audit
  const createAudit = await prisma.$queryRaw<any[]>`SELECT * FROM audit_log WHERE action_type = 'TENANT_CREATED'`;
  assert(createAudit.length === 1, 'TENANT_CREATED audit entry');

  // ──────────────────────────────────
  // 3. TENANT LIST + VIEW
  // ──────────────────────────────────
  console.log('\n3. List and view tenants');
  const listRes = await fetch(`${base}/api/admin/tenants`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const listData = await listRes.json() as any;
  assert(listRes.ok, 'List tenants OK');
  assert(listData.tenants.length === 1, `1 tenant (got ${listData.tenants.length})`);
  assert(listData.tenants[0].name === 'Panaderia Luna', 'Correct tenant');

  // ──────────────────────────────────
  // 4. TENANT DEACTIVATION
  // ──────────────────────────────────
  console.log('\n4. Deactivate tenant');
  const deactRes = await fetch(`${base}/api/admin/tenants/${tenantId}/deactivate`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${adminToken}` },
  });
  const deactData = await deactRes.json() as any;
  assert(deactRes.ok, `Deactivate: ${deactRes.status}`);
  assert(deactData.tenant.status === 'inactive', 'Status: inactive');

  const deactAudit = await prisma.$queryRaw<any[]>`SELECT * FROM audit_log WHERE action_type = 'TENANT_DEACTIVATED'`;
  assert(deactAudit.length === 1, 'TENANT_DEACTIVATED audit entry');

  // ──────────────────────────────────
  // 5. GLOBAL LEDGER AUDIT
  // ──────────────────────────────────
  console.log('\n5. Global ledger audit');

  // Create a consumer + validate invoice to get ledger data
  const { findOrCreateConsumerAccount } = await import('../services/accounts.js');
  // Re-activate tenant for this test
  await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'active' } });
  const { account: consumer } = await findOrCreateConsumerAccount(tenantId, '+584125550001');
  const poolAccount = await prisma.account.findFirst({ where: { tenantId, systemAccountType: 'issued_value_pool' } });
  const { writeDoubleEntry } = await import('../services/ledger.js');
  await writeDoubleEntry({
    tenantId, eventType: 'ADJUSTMENT_MANUAL', debitAccountId: poolAccount!.id, creditAccountId: consumer.id,
    amount: '100.00000000', assetTypeId: asset.id, referenceId: 'ADMIN-TEST-1', referenceType: 'manual_adjustment',
    metadata: { reason: 'Test entry for admin view' },
  });

  const ledgerRes = await fetch(`${base}/api/admin/ledger?tenantId=${tenantId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const ledgerData = await ledgerRes.json() as any;
  assert(ledgerRes.ok, 'Ledger endpoint OK');
  assert(ledgerData.entries.length >= 2, `${ledgerData.entries.length} ledger entries`);
  assert(ledgerData.total >= 2, `Total count: ${ledgerData.total}`);

  // Filter by event type
  const filteredRes = await fetch(`${base}/api/admin/ledger?eventType=ADJUSTMENT_MANUAL`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const filteredData = await filteredRes.json() as any;
  assert(filteredData.entries.length >= 2, 'Filtered by event type works');

  // ──────────────────────────────────
  // 6. HASH CHAIN VERIFICATION
  // ──────────────────────────────────
  console.log('\n6. Hash chain verification');
  const hashRes = await fetch(`${base}/api/admin/verify-hash-chain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ tenantId }),
  });
  const hashData = await hashRes.json() as any;
  assert(hashRes.ok, 'Hash chain endpoint OK');
  assert(hashData.valid === true, 'Hash chain valid');

  // Check all tenants at once
  const hashAllRes = await fetch(`${base}/api/admin/verify-hash-chain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({}),
  });
  const hashAllData = await hashAllRes.json() as any;
  assert(hashAllData.allValid === true, 'All tenants hash chains valid');

  // ──────────────────────────────────
  // 7. MANUAL ADJUSTMENT (double-entry)
  // ──────────────────────────────────
  console.log('\n7. Manual adjustment');

  // Missing reason → rejected
  const noReasonRes = await fetch(`${base}/api/admin/manual-adjustment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ accountId: consumer.id, tenantId, amount: '50', direction: 'credit', reason: 'ab', assetTypeId: asset.id }),
  });
  assert(noReasonRes.status === 400, `Short reason rejected: ${noReasonRes.status}`);

  // Valid adjustment
  const adjRes = await fetch(`${base}/api/admin/manual-adjustment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ accountId: consumer.id, tenantId, amount: '75.00000000', direction: 'credit', reason: 'Customer complaint resolution test', assetTypeId: asset.id }),
  });
  const adjData = await adjRes.json() as any;
  assert(adjRes.ok, `Adjustment: ${adjRes.status}`);
  assert(Number(adjData.newBalance) === 175, `New balance: ${adjData.newBalance}`);

  // Verify double-entry
  const adjEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId, eventType: 'ADJUSTMENT_MANUAL' },
  });
  assert(adjEntries.length === 4, `4 ADJUSTMENT_MANUAL entries (2 test + 2 adjustment)`);

  // Verify audit logged
  const adjAudit = await prisma.$queryRaw<any[]>`SELECT * FROM audit_log WHERE action_type = 'MANUAL_ADJUSTMENT'`;
  assert(adjAudit.length === 1, 'MANUAL_ADJUSTMENT audit entry');
  assert((adjAudit[0].metadata as any).reason === 'Customer complaint resolution test', 'Reason stored in audit');

  // ──────────────────────────────────
  // 8. PLATFORM METRICS
  // ──────────────────────────────────
  console.log('\n8. Platform metrics');
  const metricsRes = await fetch(`${base}/api/admin/metrics`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const metricsData = await metricsRes.json() as any;
  assert(metricsRes.ok, 'Metrics endpoint OK');
  assert(metricsData.activeTenants >= 1, `Active tenants: ${metricsData.activeTenants}`);
  assert(metricsData.totalConsumers >= 1, `Total consumers: ${metricsData.totalConsumers}`);
  assert(typeof metricsData.totalValueInCirculation === 'string', 'Value in circulation present');
  assert(typeof metricsData.validationsLast30Days === 'number', 'Validations last 30 days present');
  assert(typeof metricsData.shadowAccounts === 'number', 'Shadow accounts count');
  assert(typeof metricsData.verifiedAccounts === 'number', 'Verified accounts count');

  // ──────────────────────────────────
  // 9. NON-ADMIN CANNOT ACCESS
  // ──────────────────────────────────
  console.log('\n9. Non-admin blocked');
  const noAuthRes = await fetch(`${base}/api/admin/tenants`);
  assert(noAuthRes.status === 401, `No auth: 401 (got ${noAuthRes.status})`);

  // Staff token cannot access admin routes
  const { issueStaffTokens } = await import('../services/auth.js');
  const fakeStaff = issueStaffTokens({ staffId: ownerStaff!.id, tenantId, role: 'owner', type: 'staff' });
  const staffAdminRes = await fetch(`${base}/api/admin/tenants`, {
    headers: { Authorization: `Bearer ${fakeStaff.accessToken}` },
  });
  assert(staffAdminRes.status === 403, `Staff token on admin route: 403 (got ${staffAdminRes.status})`);

  // ──────────────────────────────────
  // 10. FRONTEND PAGES EXIST
  // ──────────────────────────────────
  console.log('\n10. Frontend pages');
  const fs = await import('fs');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(admin)/admin/page.tsx'), 'Admin dashboard');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(admin)/admin/login/page.tsx'), 'Admin login');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(admin)/admin/tenants/page.tsx'), 'Tenant management');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(admin)/admin/ledger/page.tsx'), 'Ledger audit');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(admin)/admin/adjustments/page.tsx'), 'Manual adjustments');

  await app.close();
  console.log(`\n=== STEP 3.2: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
