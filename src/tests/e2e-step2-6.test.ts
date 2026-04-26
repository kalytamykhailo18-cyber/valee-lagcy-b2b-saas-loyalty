import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { initiateRedemption, processRedemption } from '../services/redemption.js';
import { issueStaffTokens, issueConsumerTokens } from '../services/auth.js';
import merchantRoutes from '../api/routes/merchant.js';
import consumerRoutes from '../api/routes/consumer.js';
import bcrypt from 'bcryptjs';
import fs from 'fs';

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

async function post(base: string, path: string, body: any, token: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as any };
}
async function put(base: string, path: string, body: any, token: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as any };
}
async function patch(base: string, path: string, token: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, data: await res.json() as any };
}
async function get(base: string, path: string, token: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, data: await res.json() as any };
}

async function test() {
  console.log('=== STEP 2.6: CATALOG MANAGEMENT — FULL E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Catalog Mgmt Store', 'catalog-mgmt', 'cm@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@cm.com', passwordHash: await bcrypt.hash('pass', 10), role: 'owner' },
  });
  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'c@cm.com', passwordHash: await bcrypt.hash('pass', 10), role: 'cashier' },
  });

  // Give consumer 500 pts
  await processCSV(`invoice_number,total\nCM-001,500.00`, tenant.id, owner.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'CM-001', total_amount: 500, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

  // Start server
  const app = Fastify();
  await app.register(cors);
  await app.register(merchantRoutes);
  await app.register(consumerRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const ownerToken = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;
  const cashierToken = issueStaffTokens({ staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff' }).accessToken;
  const consumerToken = issueConsumerTokens({ accountId: account!.id, tenantId: tenant.id, phoneNumber: '+584125550001', type: 'consumer' }).accessToken;

  // ──────────────────────────────────
  // 1. CREATE product (owner only)
  // ──────────────────────────────────
  console.log('1. Create product');
  const createRes = await post(base, '/api/merchant/products', {
    name: 'Coffee Mug', description: 'A nice mug', photoUrl: 'https://cdn.example.com/mug.jpg',
    redemptionCost: '100', assetTypeId: asset.id, stock: 3,
  }, ownerToken);
  assert(createRes.status === 200, `Create: 200 (got ${createRes.status})`);
  assert(createRes.data.product.name === 'Coffee Mug', `Name: ${createRes.data.product.name}`);
  const productId = createRes.data.product.id;

  // Cashier cannot create
  const cashierCreate = await post(base, '/api/merchant/products', {
    name: 'Hack', redemptionCost: '1', assetTypeId: asset.id,
  }, cashierToken);
  assert(cashierCreate.status === 403, `Cashier create → 403 (got ${cashierCreate.status})`);

  // Audit log
  const createAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenant.id}::uuid AND action_type = 'PRODUCT_CREATED'
  `;
  assert(createAudit.length === 1, 'PRODUCT_CREATED audit entry');

  // ──────────────────────────────────
  // 2. EDIT product (owner only)
  // ──────────────────────────────────
  console.log('\n2. Edit product');
  const editRes = await put(base, `/api/merchant/products/${productId}`, {
    name: 'Premium Mug', stock: 5, redemptionCost: '150',
  }, ownerToken);
  assert(editRes.status === 200, `Edit: 200`);
  assert(editRes.data.product.name === 'Premium Mug', `Name updated: ${editRes.data.product.name}`);
  assert(editRes.data.product.stock === 5, `Stock updated: ${editRes.data.product.stock}`);

  // Audit log
  const editAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenant.id}::uuid AND action_type = 'PRODUCT_UPDATED'
  `;
  assert(editAudit.length === 1, 'PRODUCT_UPDATED audit entry');

  // ──────────────────────────────────
  // 3. TOGGLE active/inactive
  // ──────────────────────────────────
  console.log('\n3. Toggle active/inactive');

  // Toggle inactive
  const toggleOff = await patch(base, `/api/merchant/products/${productId}/toggle`, ownerToken);
  assert(toggleOff.data.product.active === false, 'Toggled to inactive');

  // Consumer catalog: product gone
  const catOff = await get(base, '/api/consumer/catalog', consumerToken);
  assert(!catOff.data.products.some((p: any) => p.name === 'Premium Mug'), 'Inactive: disappeared from consumer catalog');

  // Toggle back active
  const toggleOn = await patch(base, `/api/merchant/products/${productId}/toggle`, ownerToken);
  assert(toggleOn.data.product.active === true, 'Toggled to active');

  // Consumer catalog: product back
  const catOn = await get(base, '/api/consumer/catalog', consumerToken);
  assert(catOn.data.products.some((p: any) => p.name === 'Premium Mug'), 'Active: reappeared in consumer catalog');

  // Audit log
  const toggleAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenant.id}::uuid AND action_type = 'PRODUCT_TOGGLED'
  `;
  assert(toggleAudit.length === 2, `PRODUCT_TOGGLED audit entries: ${toggleAudit.length} (off + on)`);

  // ──────────────────────────────────
  // 4. STOCK decrements on redemption
  // ──────────────────────────────────
  console.log('\n4. Stock decrements on redemption');

  // Set cost back to 100 for the redemption test
  await put(base, `/api/merchant/products/${productId}`, { redemptionCost: '100' }, ownerToken);

  const stockBefore = (await prisma.product.findUnique({ where: { id: productId } }))!.stock;
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId, tenantId: tenant.id, assetTypeId: asset.id,
  });
  await processRedemption({ token: redemption.token!, cashierStaffId: cashier.id, cashierTenantId: tenant.id });

  const stockAfter = (await prisma.product.findUnique({ where: { id: productId } }))!.stock;
  assert(stockAfter === stockBefore - 1, `Stock: ${stockBefore} → ${stockAfter}`);

  // ──────────────────────────────────
  // 5. ZERO STOCK → invisible to consumers
  // ──────────────────────────────────
  console.log('\n5. Zero stock → invisible to consumers');

  // Set stock to 1
  await prisma.product.update({ where: { id: productId }, data: { stock: 1 } });

  // Redeem the last one
  const lastRedemption = await initiateRedemption({
    consumerAccountId: account!.id, productId, tenantId: tenant.id, assetTypeId: asset.id,
  });
  await processRedemption({ token: lastRedemption.token!, cashierStaffId: cashier.id, cashierTenantId: tenant.id });

  const finalStock = (await prisma.product.findUnique({ where: { id: productId } }))!.stock;
  assert(finalStock === 0, `Stock now 0 (got ${finalStock})`);

  // Consumer catalog: product gone (zero stock)
  const catZero = await get(base, '/api/consumer/catalog', consumerToken);
  assert(!catZero.data.products.some((p: any) => p.name === 'Premium Mug'), 'Zero stock: disappeared from consumer catalog');

  // Owner dashboard: still sees it
  const ownerProducts = await get(base, '/api/merchant/products', ownerToken);
  assert(ownerProducts.data.products.some((p: any) => p.name === 'Premium Mug' && p.stock === 0), 'Owner still sees zero-stock product');

  // Restock
  await put(base, `/api/merchant/products/${productId}`, { stock: 10 }, ownerToken);
  const catRestocked = await get(base, '/api/consumer/catalog', consumerToken);
  assert(catRestocked.data.products.some((p: any) => p.name === 'Premium Mug'), 'Restocked: reappears in consumer catalog');

  // ──────────────────────────────────
  // 6. FRONTEND pages exist
  // ──────────────────────────────────
  console.log('\n6. Frontend');
  const prodSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/products/page.tsx', 'utf-8');
  assert(prodSrc.includes('Productos'), 'Products management page title');
  assert(prodSrc.includes('Nuevo'), 'Add new product button');
  assert(prodSrc.includes('handleToggle'), 'Toggle active/inactive function');
  assert(prodSrc.includes('Activo') && prodSrc.includes('Inactivo'), 'Active/Inactive status labels');
  assert(prodSrc.includes('redemptionCost'), 'Shows redemption cost');
  assert(prodSrc.includes('stock') || prodSrc.includes('Stock'), 'Shows stock');

  await app.close();
  console.log(`\n=== STEP 2.6: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
