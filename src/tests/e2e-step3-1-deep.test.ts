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
import { initiateRedemption, processRedemption } from '../services/redemption.js';
import { authenticateStaff, issueStaffTokens } from '../services/auth.js';
import consumerRoutes from '../api/routes/consumer.js';
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
  console.log('=== STEP 3.1: ROLE SEPARATION + AUDIT TRAIL — DEEP E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Role Store', 'role-store', 'rl@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'owner@rl.com', passwordHash: await bcrypt.hash('owner123', 10), role: 'owner' },
  });
  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'cashier@rl.com', passwordHash: await bcrypt.hash('cash123', 10), role: 'cashier' },
  });

  // Setup: give consumer points + product for scan test
  await processCSV(`invoice_number,total\nRL-001,500.00`, tenant.id, owner.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'RL-001', total_amount: 500, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });
  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Prize', redemptionCost: '50.00000000', assetTypeId: asset.id, stock: 5, active: true, minLevel: 1 },
  });

  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(consumerRoutes); await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const ownerToken = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;
  const cashierToken = issueStaffTokens({ staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff' }).accessToken;

  // ──────────────────────────────────
  // 1. OWNER can access all routes
  // ──────────────────────────────────
  console.log('1. Owner can access all routes');
  const ownerCSV = await fetch(`${base}/api/merchant/csv-upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ csvContent: 'invoice_number,total\nOWN-001,100.00' }),
  });
  assert(ownerCSV.ok, `Owner CSV upload: ${ownerCSV.status}`);

  const ownerProducts = await fetch(`${base}/api/merchant/products`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert(ownerProducts.ok, `Owner products: ${ownerProducts.status}`);

  const ownerAnalytics = await fetch(`${base}/api/merchant/analytics`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert(ownerAnalytics.ok, `Owner analytics: ${ownerAnalytics.status}`);

  const ownerStaff = await fetch(`${base}/api/merchant/staff`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert(ownerStaff.ok, `Owner staff list: ${ownerStaff.status}`);

  const ownerAudit = await fetch(`${base}/api/merchant/audit-log`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert(ownerAudit.ok, `Owner audit log: ${ownerAudit.status}`);

  // ──────────────────────────────────
  // 2. CASHIER blocked from owner-only routes
  // ──────────────────────────────────
  console.log('\n2. Cashier blocked from owner-only routes');
  const cashierCSV = await fetch(`${base}/api/merchant/csv-upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
    body: JSON.stringify({ csvContent: 'x,y\n1,2' }),
  });
  assert(cashierCSV.status === 403, `Cashier CSV: 403 (got ${cashierCSV.status})`);

  const cashierProducts = await fetch(`${base}/api/merchant/products`, { headers: { Authorization: `Bearer ${cashierToken}` } });
  assert(cashierProducts.status === 403, `Cashier products: 403 (got ${cashierProducts.status})`);

  const cashierAnalytics = await fetch(`${base}/api/merchant/analytics`, { headers: { Authorization: `Bearer ${cashierToken}` } });
  assert(cashierAnalytics.status === 403, `Cashier analytics: 403 (got ${cashierAnalytics.status})`);

  const cashierStaffList = await fetch(`${base}/api/merchant/staff`, { headers: { Authorization: `Bearer ${cashierToken}` } });
  assert(cashierStaffList.status === 403, `Cashier staff list: 403 (got ${cashierStaffList.status})`);

  const cashierAudit = await fetch(`${base}/api/merchant/audit-log`, { headers: { Authorization: `Bearer ${cashierToken}` } });
  assert(cashierAudit.status === 403, `Cashier audit log: 403 (got ${cashierAudit.status})`);

  // ──────────────────────────────────
  // 3. CASHIER can access scanner + customer lookup + identity upgrade
  // ──────────────────────────────────
  console.log('\n3. Cashier can access allowed routes');
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  const cashierScan = await fetch(`${base}/api/merchant/scan-redemption`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
    body: JSON.stringify({ token: redemption.token }),
  });
  assert(cashierScan.ok, `Cashier scan: ${cashierScan.status}`);

  const cashierLookup = await fetch(`${base}/api/merchant/customer-lookup/${encodeURIComponent('+584125550001')}`, {
    headers: { Authorization: `Bearer ${cashierToken}` },
  });
  assert(cashierLookup.ok, `Cashier lookup: ${cashierLookup.status}`);

  // ──────────────────────────────────
  // 4. STAFF CREATION by owner
  // ──────────────────────────────────
  console.log('\n4. Owner creates cashier account');
  const newStaff = await fetch(`${base}/api/merchant/staff`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: 'New Cashier', email: 'new@rl.com', password: 'pass', role: 'cashier' }),
  });
  const newStaffData = await newStaff.json() as any;
  assert(newStaff.ok, `Create staff: ${newStaff.status}`);
  assert(newStaffData.staff.role === 'cashier', `Role: ${newStaffData.staff.role}`);

  // New cashier can authenticate
  const newAuth = await authenticateStaff('new@rl.com', 'pass', tenant.id);
  assert(newAuth !== null, 'New cashier can authenticate');

  // ──────────────────────────────────
  // 5. STAFF DEACTIVATION by owner
  // ──────────────────────────────────
  console.log('\n5. Owner deactivates cashier');
  const deactivateRes = await fetch(`${base}/api/merchant/staff/${newStaffData.staff.id}/deactivate`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const deactivateData = await deactivateRes.json() as any;
  assert(deactivateRes.ok, `Deactivate: ${deactivateRes.status}`);
  assert(deactivateData.staff.active === false, 'Deactivated');

  // Deactivated cashier cannot authenticate
  const deadAuth = await authenticateStaff('new@rl.com', 'pass', tenant.id);
  assert(deadAuth === null, 'Deactivated cashier cannot authenticate');

  // Owner cannot deactivate themselves
  const selfDeactivate = await fetch(`${base}/api/merchant/staff/${owner.id}/deactivate`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert(selfDeactivate.status === 400, `Self-deactivate blocked: ${selfDeactivate.status}`);

  // ──────────────────────────────────
  // 6. AUDIT TRAIL: immutable, all actions logged
  // ──────────────────────────────────
  console.log('\n6. Audit trail');

  // Fetch audit log
  const auditRes = await fetch(`${base}/api/merchant/audit-log`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const auditData = await auditRes.json() as any;
  assert(auditRes.ok, 'Audit log endpoint works');
  assert(auditData.entries.length >= 3, `${auditData.entries.length} audit entries`);

  // Check specific entries exist
  const actionTypes = auditData.entries.map((e: any) => e.action_type);
  assert(actionTypes.includes('QR_SCAN_SUCCESS'), 'QR_SCAN_SUCCESS in audit');
  assert(actionTypes.includes('STAFF_CREATED'), 'STAFF_CREATED in audit');
  assert(actionTypes.includes('STAFF_DEACTIVATED'), 'STAFF_DEACTIVATED in audit');
  assert(actionTypes.includes('CSV_UPLOAD'), 'CSV_UPLOAD in audit');
  assert(actionTypes.includes('CUSTOMER_LOOKUP'), 'CUSTOMER_LOOKUP in audit');

  // Each entry has required fields
  const scanEntry = auditData.entries.find((e: any) => e.action_type === 'QR_SCAN_SUCCESS');
  assert(!!scanEntry.created_at, 'Timestamp present');
  assert(!!scanEntry.actor_id, 'Cashier ID present');
  assert(scanEntry.outcome === 'success', 'Outcome present');

  // Immutable: cannot delete or update
  try {
    await prisma.$executeRaw`DELETE FROM audit_log WHERE tenant_id = ${tenant.id}::uuid`;
    assert(false, 'DELETE should be blocked');
  } catch {
    assert(true, 'Audit DELETE blocked');
  }
  try {
    await prisma.$executeRaw`UPDATE audit_log SET outcome = 'failure' WHERE tenant_id = ${tenant.id}::uuid`;
    assert(false, 'UPDATE should be blocked');
  } catch {
    assert(true, 'Audit UPDATE blocked');
  }

  // ──────────────────────────────────
  // 7. STAFF LIST shows all staff
  // ──────────────────────────────────
  console.log('\n7. Staff list');
  const staffRes = await fetch(`${base}/api/merchant/staff`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const staffData = await staffRes.json() as any;
  assert(staffData.staff.length >= 3, `${staffData.staff.length} staff members`);
  assert(staffData.staff.some((s: any) => s.name === 'New Cashier' && s.active === false), 'Deactivated cashier visible with active=false');

  await app.close();
  console.log(`\n=== STEP 3.1: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
