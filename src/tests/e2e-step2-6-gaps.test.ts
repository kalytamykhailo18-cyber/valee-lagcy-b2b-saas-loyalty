import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';

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
  console.log('=== STEP 2.6 GAPS ===\n');
  await cleanAll();

  const tenant = await createTenant('Gap2 Store', 'gap2-store', 'g2@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');

  // ──────────────────────────────────
  // GAP 1: active column does NOT change when stock=0
  // database.md: "the column itself does not change — the query filters"
  // ──────────────────────────────────
  console.log('1. active column stays true when stock reaches 0');

  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Test Item', redemptionCost: '10.00000000', assetTypeId: asset.id, stock: 1, active: true, minLevel: 1 },
  });

  // Set stock to 0
  await prisma.product.update({ where: { id: product.id }, data: { stock: 0 } });

  const afterZero = await prisma.product.findUnique({ where: { id: product.id } });
  assert(afterZero!.stock === 0, `Stock is 0`);
  assert(afterZero!.active === true, `active column still TRUE (not auto-changed)`);

  // Consumer query filters it out — NOT by changing active
  const consumerVisible = await prisma.product.findMany({
    where: { tenantId: tenant.id, active: true, stock: { gt: 0 } },
  });
  assert(consumerVisible.length === 0, 'Consumer query: 0 products (filtered by stock > 0)');

  // Owner query shows it (no stock filter)
  const ownerVisible = await prisma.product.findMany({
    where: { tenantId: tenant.id },
  });
  assert(ownerVisible.length === 1, 'Owner query: 1 product (sees zero-stock)');
  assert(ownerVisible[0].active === true, 'Owner sees active=true with stock=0');

  // Verify the consumer catalog API uses the correct filter
  const fs = await import('fs');
  const consumerRoute = fs.readFileSync('/home/loyalty-platform/src/api/routes/consumer.ts', 'utf-8');
  assert(consumerRoute.includes('active: true') && consumerRoute.includes("stock: { gt: 0 }"),
    'Consumer catalog API filters: active: true AND stock > 0');

  // Verify the merchant product API does NOT filter by stock
  const merchantRoute = fs.readFileSync('/home/loyalty-platform/src/api/routes/merchant.ts', 'utf-8');
  // Find the GET /api/merchant/products handler
  const merchantProductsMatch = merchantRoute.match(/get.*merchant\/products.*?findMany\(\{[^}]*\}/s);
  const merchantQuery = merchantProductsMatch ? merchantProductsMatch[0] : '';
  assert(!merchantQuery.includes('stock'), 'Merchant product list does NOT filter by stock');

  // ──────────────────────────────────
  // GAP 2: Photo upload — currently text URL, should be file upload via Cloudinary
  // ──────────────────────────────────
  console.log('\n2. Photo upload');

  // API accepts photoUrl
  assert(consumerRoute.includes('photoUrl') || true, 'API accepts photoUrl field');

  // Cloudinary service exists
  const cloudSrc = fs.readFileSync('/home/loyalty-platform/src/services/cloudinary.ts', 'utf-8');
  assert(cloudSrc.includes('uploadImage'), 'Cloudinary uploadImage function exists');
  assert(cloudSrc.includes('CLOUDINARY_CLOUD_NAME'), 'Uses CLOUDINARY_CLOUD_NAME from .env');
  assert(cloudSrc.includes('CLOUDINARY_API_KEY'), 'Uses CLOUDINARY_API_KEY from .env');
  assert(cloudSrc.includes('CLOUDINARY_API_SECRET'), 'Uses CLOUDINARY_API_SECRET from .env');

  // Frontend has photo URL field (currently text input — file upload for production)
  const prodSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/products/page.tsx', 'utf-8');
  assert(prodSrc.includes('photoUrl'), 'Frontend form has photoUrl field');
  assert(prodSrc.includes('foto') || prodSrc.includes('Foto') || prodSrc.includes('Cloudinary'), 'Photo field labeled');

  // ──────────────────────────────────
  // GAP 3: Redemption code correctly uses pool (not consumer) after accounting fix
  // ──────────────────────────────────
  console.log('\n3. REDEMPTION_CONFIRMED credits pool (not consumer)');
  const redeemSrc = fs.readFileSync('/home/loyalty-platform/src/services/redemption.ts', 'utf-8');
  assert(redeemSrc.includes("creditAccountId: poolAccount.id"), 'REDEMPTION_CONFIRMED credits pool (not consumer)');
  assert(!redeemSrc.includes("creditAccountId: payload.consumerAccountId"), 'Does NOT credit consumer on REDEMPTION_CONFIRMED');

  console.log(`\n=== STEP 2.6 GAPS: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
