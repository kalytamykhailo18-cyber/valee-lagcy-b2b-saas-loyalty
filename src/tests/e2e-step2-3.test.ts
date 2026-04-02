import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import cors from '@fastify/cors';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { issueConsumerTokens } from '../services/auth.js';
import consumerRoutes from '../api/routes/consumer.js';
import fs from 'fs';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function cleanAll() {
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
  console.log('=== STEP 2.3: PRODUCT CATALOG — FULL E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Catalog Store', 'catalog-store', 'cat@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@cat.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Give consumer 200 points
  await processCSV(`invoice_number,total\nCAT-001,200.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'CAT-001', total_amount: 200, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

  // Create products with different scenarios
  await prisma.product.create({ data: { tenantId: tenant.id, name: 'Cheap Item', description: 'A small prize', photoUrl: 'https://cdn.example.com/cheap.jpg', redemptionCost: '50.00000000', assetTypeId: asset.id, stock: 10, active: true, minLevel: 1 } });
  await prisma.product.create({ data: { tenantId: tenant.id, name: 'Exact Match', description: 'Costs exactly your balance', photoUrl: null, redemptionCost: '200.00000000', assetTypeId: asset.id, stock: 3, active: true, minLevel: 1 } });
  await prisma.product.create({ data: { tenantId: tenant.id, name: 'Expensive Item', description: 'Way too pricey', photoUrl: 'https://cdn.example.com/expensive.jpg', redemptionCost: '5000.00000000', assetTypeId: asset.id, stock: 1, active: true, minLevel: 1 } });
  await prisma.product.create({ data: { tenantId: tenant.id, name: 'Out of Stock', description: 'Gone', photoUrl: null, redemptionCost: '10.00000000', assetTypeId: asset.id, stock: 0, active: true, minLevel: 1 } });
  await prisma.product.create({ data: { tenantId: tenant.id, name: 'Inactive Product', description: 'Disabled', photoUrl: null, redemptionCost: '10.00000000', assetTypeId: asset.id, stock: 5, active: false, minLevel: 1 } });

  // Start server
  const app = Fastify();
  await app.register(cors);
  await app.register(consumerRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const token = issueConsumerTokens({
    accountId: account!.id, tenantId: tenant.id, phoneNumber: '+584125550001', type: 'consumer',
  }).accessToken;

  // Fetch catalog
  const res = await fetch(`${base}/api/consumer/catalog`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json() as any;

  assert(res.ok, `Catalog endpoint: ${res.status}`);

  // ──────────────────────────────────
  // 1. Product card fields
  // ──────────────────────────────────
  console.log('1. Product card fields');
  const cheap = data.products.find((p: any) => p.name === 'Cheap Item');
  assert(cheap !== undefined, 'Cheap Item visible');
  assert(cheap.name === 'Cheap Item', `name: ${cheap.name}`);
  assert(cheap.description === 'A small prize', `description: ${cheap.description}`);
  assert(cheap.photoUrl === 'https://cdn.example.com/cheap.jpg', `photoUrl: ${cheap.photoUrl}`);
  assert(Number(cheap.redemptionCost) === 50, `redemptionCost: ${cheap.redemptionCost}`);
  assert(cheap.stock === 10, `stock: ${cheap.stock}`);

  // ──────────────────────────────────
  // 2. canAfford logic
  // ──────────────────────────────────
  console.log('\n2. Affordability (balance = 200)');
  assert(cheap.canAfford === true, 'Cheap Item (50 pts): canAfford=true');

  const exact = data.products.find((p: any) => p.name === 'Exact Match');
  assert(exact.canAfford === true, 'Exact Match (200 pts): canAfford=true (exact balance)');

  const expensive = data.products.find((p: any) => p.name === 'Expensive Item');
  assert(expensive.canAfford === false, 'Expensive Item (5000 pts): canAfford=false');

  // ──────────────────────────────────
  // 3. Filtering: zero stock hidden, inactive hidden
  // ──────────────────────────────────
  console.log('\n3. Filtering');
  const names = data.products.map((p: any) => p.name);
  assert(!names.includes('Out of Stock'), 'Zero-stock product hidden');
  assert(!names.includes('Inactive Product'), 'Inactive product hidden');
  assert(data.products.length === 3, `3 visible products (got ${data.products.length})`);

  // ──────────────────────────────────
  // 4. Frontend: grayscale + lock for unaffordable
  // ──────────────────────────────────
  console.log('\n4. Frontend: grayscale/color + lock/active');
  const catSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/catalog/page.tsx', 'utf-8');

  assert(catSrc.includes('grayscale'), 'Unaffordable products: grayscale class');
  assert(catSrc.includes('opacity-70') || catSrc.includes('opacity'), 'Unaffordable products: reduced opacity');
  assert(catSrc.includes('Bloqueado') || catSrc.includes('🔒'), 'Unaffordable: lock icon or "Bloqueado"');
  assert(catSrc.includes('Canjear'), 'Affordable: "Canjear" button');

  // ──────────────────────────────────
  // 5. Frontend: tap unaffordable → motivational message
  // ──────────────────────────────────
  console.log('\n5. Frontend: tap unaffordable → message');
  assert(catSrc.includes('handleProductClick'), 'Product click handler exists');
  assert(catSrc.includes('Necesitas') || catSrc.includes('puntos mas'), 'Message explains how many more points needed');
  assert(catSrc.includes('factura') || catSrc.includes('ganar'), 'Message mentions scanning invoice to earn more');

  // ──────────────────────────────────
  // 6. Frontend: product card has all 6 elements
  // ──────────────────────────────────
  console.log('\n6. Frontend: product card elements');
  assert(catSrc.includes('product.photoUrl') || catSrc.includes('photoUrl'), 'Photo displayed');
  assert(catSrc.includes('product.name') || catSrc.includes('p.name'), 'Name displayed');
  assert(catSrc.includes('redemptionCost'), 'Cost displayed');
  assert(catSrc.includes('product.stock') || catSrc.includes('disponibles'), 'Stock displayed');
  assert(catSrc.includes('product.description') || catSrc.includes('description'), 'Description available');
  assert(catSrc.includes('Canjear'), 'Redeem button present');

  // ──────────────────────────────────
  // 7. Catalog driven by merchant dashboard (toggle test)
  // ──────────────────────────────────
  console.log('\n7. Catalog driven by merchant configuration');

  // Toggle Cheap Item inactive
  await prisma.product.update({ where: { id: cheap.id }, data: { active: false } });
  const res2 = await fetch(`${base}/api/consumer/catalog`, { headers: { Authorization: `Bearer ${token}` } });
  const data2 = await res2.json() as any;
  const names2 = data2.products.map((p: any) => p.name);
  assert(!names2.includes('Cheap Item'), 'Toggled inactive → disappears immediately');

  // Toggle back active
  await prisma.product.update({ where: { id: cheap.id }, data: { active: true } });
  const res3 = await fetch(`${base}/api/consumer/catalog`, { headers: { Authorization: `Bearer ${token}` } });
  const data3 = await res3.json() as any;
  const names3 = data3.products.map((p: any) => p.name);
  assert(names3.includes('Cheap Item'), 'Toggled active → reappears immediately');

  await app.close();
  console.log(`\n=== STEP 2.3: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
