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
import { issueConsumerTokens, issueStaffTokens } from '../services/auth.js';
import consumerRoutes from '../api/routes/consumer.js';
import merchantRoutes from '../api/routes/merchant.js';
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
  console.log('=== STEP 2.6: CATALOG MANAGEMENT — DEEP E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Catalog Mgmt Store', 'catmgmt-store', 'cm@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@cm.com', passwordHash: await bcrypt.hash('pass', 10), role: 'owner' },
  });
  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'c@cm.com', passwordHash: await bcrypt.hash('pass', 10), role: 'cashier' },
  });

  // Give consumer points for redemption test
  await processCSV(`invoice_number,total\nCM-001,500.00`, tenant.id, owner.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'CM-001', total_amount: 500, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(consumerRoutes); await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const ownerToken = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;
  const cashierToken = issueStaffTokens({ staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff' }).accessToken;
  const consumerToken = issueConsumerTokens({ accountId: account!.id, tenantId: tenant.id, phoneNumber: '+584125550001', type: 'consumer' }).accessToken;

  // ──────────────────────────────────
  // 1. CREATE product via API
  // ──────────────────────────────────
  console.log('1. Create product');
  const createRes = await fetch(`${base}/api/merchant/products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: 'Coffee Mug', description: 'A nice mug', photoUrl: 'https://cdn.example.com/mug.jpg', redemptionCost: '100', assetTypeId: asset.id, stock: 5, minLevel: 1 }),
  });
  const createData = await createRes.json() as any;
  assert(createRes.ok, `Create: ${createRes.status}`);
  assert(createData.product.name === 'Coffee Mug', `Name: ${createData.product.name}`);
  const productId = createData.product.id;

  // Audit logged
  const createAudit = await prisma.$queryRaw<any[]>`SELECT * FROM audit_log WHERE action_type = 'PRODUCT_CREATED' AND tenant_id = ${tenant.id}::uuid`;
  assert(createAudit.length === 1, 'PRODUCT_CREATED audit entry');

  // ──────────────────────────────────
  // 2. EDIT product (name, stock, cost)
  // ──────────────────────────────────
  console.log('\n2. Edit product');
  const editRes = await fetch(`${base}/api/merchant/products/${productId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: 'Premium Mug', stock: 10, redemptionCost: '150' }),
  });
  const editData = await editRes.json() as any;
  assert(editRes.ok, `Edit: ${editRes.status}`);
  assert(editData.product.name === 'Premium Mug', `Updated name: ${editData.product.name}`);
  assert(editData.product.stock === 10, `Updated stock: ${editData.product.stock}`);

  // Audit logged
  const editAudit = await prisma.$queryRaw<any[]>`SELECT * FROM audit_log WHERE action_type = 'PRODUCT_UPDATED' AND tenant_id = ${tenant.id}::uuid`;
  assert(editAudit.length === 1, 'PRODUCT_UPDATED audit entry');

  // ──────────────────────────────────
  // 3. TOGGLE active/inactive → disappears from consumer catalog
  // ──────────────────────────────────
  console.log('\n3. Toggle active/inactive');

  // Visible before toggle
  const catBefore = await fetch(`${base}/api/consumer/catalog`, { headers: { Authorization: `Bearer ${consumerToken}` } });
  const catBeforeData = await catBefore.json() as any;
  assert(catBeforeData.products.some((p: any) => p.name === 'Premium Mug'), 'Product visible before toggle');

  // Toggle OFF
  const toggleRes = await fetch(`${base}/api/merchant/products/${productId}/toggle`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const toggleData = await toggleRes.json() as any;
  assert(toggleData.product.active === false, 'Toggled to inactive');

  // Invisible after toggle
  const catAfter = await fetch(`${base}/api/consumer/catalog`, { headers: { Authorization: `Bearer ${consumerToken}` } });
  const catAfterData = await catAfter.json() as any;
  assert(!catAfterData.products.some((p: any) => p.name === 'Premium Mug'), 'Product hidden after toggle');

  // Toggle back ON
  await fetch(`${base}/api/merchant/products/${productId}/toggle`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const catBack = await fetch(`${base}/api/consumer/catalog`, { headers: { Authorization: `Bearer ${consumerToken}` } });
  const catBackData = await catBack.json() as any;
  assert(catBackData.products.some((p: any) => p.name === 'Premium Mug'), 'Product reappears after re-toggle');

  // Audit logged
  const toggleAudit = await prisma.$queryRaw<any[]>`SELECT * FROM audit_log WHERE action_type = 'PRODUCT_TOGGLED' AND tenant_id = ${tenant.id}::uuid`;
  assert(toggleAudit.length === 2, `PRODUCT_TOGGLED audit entries: ${toggleAudit.length}`);

  // ──────────────────────────────────
  // 4. STOCK decrement on redemption
  // ──────────────────────────────────
  console.log('\n4. Stock decrements on redemption');
  const stockBefore = (await prisma.product.findUnique({ where: { id: productId } }))!.stock;

  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId, tenantId: tenant.id, assetTypeId: asset.id,
  });
  await processRedemption({ token: redemption.token!, cashierStaffId: cashier.id, cashierTenantId: tenant.id });

  const stockAfter = (await prisma.product.findUnique({ where: { id: productId } }))!.stock;
  assert(stockAfter === stockBefore - 1, `Stock: ${stockBefore} → ${stockAfter}`);

  // ──────────────────────────────────
  // 5. ZERO STOCK → invisible to consumer
  // ──────────────────────────────────
  console.log('\n5. Zero stock → invisible');
  await prisma.product.update({ where: { id: productId }, data: { stock: 0 } });

  const catZero = await fetch(`${base}/api/consumer/catalog`, { headers: { Authorization: `Bearer ${consumerToken}` } });
  const catZeroData = await catZero.json() as any;
  assert(!catZeroData.products.some((p: any) => p.name === 'Premium Mug'), 'Zero-stock product invisible to consumer');

  // Owner still sees it
  const ownerProducts = await fetch(`${base}/api/merchant/products`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const ownerData = await ownerProducts.json() as any;
  assert(ownerData.products.some((p: any) => p.name === 'Premium Mug'), 'Owner still sees zero-stock product');

  // Restock
  await fetch(`${base}/api/merchant/products/${productId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ stock: 5 }),
  });
  const catRestocked = await fetch(`${base}/api/consumer/catalog`, { headers: { Authorization: `Bearer ${consumerToken}` } });
  const catRestockedData = await catRestocked.json() as any;
  assert(catRestockedData.products.some((p: any) => p.name === 'Premium Mug'), 'Restocked product visible again');

  // ──────────────────────────────────
  // 6. CASHIER cannot manage products
  // ──────────────────────────────────
  console.log('\n6. Cashier cannot manage products (owner-only)');
  const cashierCreate = await fetch(`${base}/api/merchant/products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
    body: JSON.stringify({ name: 'Hack', redemptionCost: '1', assetTypeId: asset.id }),
  });
  assert(cashierCreate.status === 403, `Cashier create: 403 (got ${cashierCreate.status})`);

  // ──────────────────────────────────
  // 7. Frontend has all required elements
  // ──────────────────────────────────
  console.log('\n7. Frontend elements');
  const pageSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/products/page.tsx', 'utf-8');
  assert(pageSrc.includes('Nombre'), 'Create form: name field');
  assert(pageSrc.includes('Descripcion'), 'Create form: description field');
  assert(pageSrc.includes('foto') || pageSrc.includes('URL'), 'Create form: photo field');
  assert(pageSrc.includes('Costo'), 'Create form: redemption cost');
  assert(pageSrc.includes('Stock'), 'Create form: stock');
  assert(pageSrc.includes('Editar'), 'Edit button on each product');
  assert(pageSrc.includes('handleSaveEdit'), 'Save edit function');
  assert(pageSrc.includes('startEdit'), 'Start edit function');
  assert(pageSrc.includes('Activo') && pageSrc.includes('Inactivo'), 'Active/Inactive toggle');
  assert(pageSrc.includes('Sin stock'), 'Zero stock warning message');

  await app.close();
  console.log(`\n=== STEP 2.6: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
