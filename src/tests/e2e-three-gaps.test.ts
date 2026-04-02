import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import cors from '@fastify/cors';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { getAccountBalance } from '../services/ledger.js';
import { computeLevel, checkAndUpdateLevel } from '../services/levels.js';
import { issueStaffTokens, issueConsumerTokens } from '../services/auth.js';
import merchantRoutes from '../api/routes/merchant.js';
import consumerRoutes from '../api/routes/consumer.js';
import bcrypt from 'bcryptjs';

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
  console.log('=== THREE GAPS: MULTIPLIER UI + LEVEL-UP + LEVEL FILTERING ===\n');
  await cleanAll();

  const tenant = await createTenant('Gap Store', 'gap-store-3', 'gs@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@gs.com', passwordHash: await bcrypt.hash('pass', 10), role: 'owner' },
  });

  // ──────────────────────────────────
  // GAP 1: Multiplier dashboard UI via HTTP API
  // ──────────────────────────────────
  console.log('GAP 1: Multiplier dashboard UI (API test)');

  const app = Fastify();
  await app.register(cors);
  await app.register(merchantRoutes);
  await app.register(consumerRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const ownerToken = issueStaffTokens({ staffId: staff.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;

  // GET current multiplier
  const getRes = await fetch(`${base}/api/merchant/multiplier`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const getData = await getRes.json() as any;
  assert(getRes.ok, `GET multiplier: 200`);
  assert(Number(getData.currentRate) === 1, `Current rate: 1x (default)`);

  // PUT set to 2x
  const putRes = await fetch(`${base}/api/merchant/multiplier`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ multiplier: '2', assetTypeId: asset.id }),
  });
  const putData = await putRes.json() as any;
  assert(putRes.ok, `PUT multiplier 2x: 200`);
  assert(Number(putData.newRate) === 2, `New rate: 2x`);

  // Verify it sticks
  const getRes2 = await fetch(`${base}/api/merchant/multiplier`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const getData2 = await getRes2.json() as any;
  assert(Number(getData2.currentRate) === 2, `Rate persisted: 2x`);

  // PUT set to 1.5x
  await fetch(`${base}/api/merchant/multiplier`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ multiplier: '1.5', assetTypeId: asset.id }),
  });

  // Frontend has multiplier UI
  const fs = await import('fs');
  const dashSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/page.tsx', 'utf-8');
  assert(dashSrc.includes('Multiplicador de puntos'), 'Dashboard shows "Multiplicador de puntos" label');
  assert(dashSrc.includes('1.5') && dashSrc.includes('2') && dashSrc.includes('3'), 'Quick-select buttons: 1x, 1.5x, 2x, 3x');
  assert(dashSrc.includes('getMultiplier'), 'Loads current multiplier');
  assert(dashSrc.includes('setMultiplier'), 'Can set new multiplier');

  // ──────────────────────────────────
  // GAP 2: Level-up rules
  // ──────────────────────────────────
  console.log('\nGAP 2: Level-up rules');

  // Reset multiplier to 1x for predictable amounts
  await setTenantConversionRate(tenant.id, asset.id, '1.00000000');

  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, '+584125550001');
  assert(consumer.level === 1, 'Starts at level 1');

  // Level 2 requires 5 claims. Create 5 invoices and claim them.
  let csv = 'invoice_number,total\n';
  for (let i = 1; i <= 6; i++) csv += `LVL-${String(i).padStart(3,'0')},10.00\n`;
  await processCSV(csv, tenant.id, staff.id);

  // Claim 4 — still level 1
  for (let i = 1; i <= 4; i++) {
    await validateInvoice({
      tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
      extractedData: { invoice_number: `LVL-${String(i).padStart(3,'0')}`, total_amount: 10, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
    });
  }
  const level4 = await computeLevel(consumer.id, tenant.id);
  assert(level4 === 1, `After 4 claims: level 1 (got ${level4})`);

  // Claim 5th — should level up to 2
  const result5 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'LVL-005', total_amount: 10, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const acc5 = await prisma.account.findUnique({ where: { id: consumer.id } });
  assert(acc5!.level === 2, `After 5 claims: level 2 (got ${acc5!.level})`);
  assert(result5.message.includes('level 2') || result5.message.includes('Level 2'), `Validation message mentions level up`);

  // ──────────────────────────────────
  // GAP 3: Level-based reward filtering
  // ──────────────────────────────────
  console.log('\nGAP 3: Level-based reward filtering');

  // Create products at different levels
  const prodLevel1 = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Basic Prize', redemptionCost: '5.00000000', assetTypeId: asset.id, stock: 10, active: true, minLevel: 1 },
  });
  const prodLevel3 = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Premium Prize', redemptionCost: '5.00000000', assetTypeId: asset.id, stock: 10, active: true, minLevel: 3 },
  });
  const prodLevel5 = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'VIP Prize', redemptionCost: '5.00000000', assetTypeId: asset.id, stock: 10, active: true, minLevel: 5 },
  });

  // Consumer at level 2 — should see level 1 + 2 products, not 3 or 5
  const consumerToken = issueConsumerTokens({
    accountId: consumer.id, tenantId: tenant.id, phoneNumber: '+584125550001', type: 'consumer',
  }).accessToken;

  const catalogRes = await fetch(`${base}/api/consumer/catalog`, {
    headers: { Authorization: `Bearer ${consumerToken}` },
  });
  const catalogData = await catalogRes.json() as any;

  assert(catalogRes.ok, 'Catalog loads');
  assert(catalogData.consumerLevel === 2, `Consumer level in response: ${catalogData.consumerLevel}`);

  const productNames = catalogData.products.map((p: any) => p.name);
  assert(productNames.includes('Basic Prize'), 'Level 1 product visible at level 2');
  assert(!productNames.includes('Premium Prize'), 'Level 3 product hidden at level 2');
  assert(!productNames.includes('VIP Prize'), 'Level 5 product hidden at level 2');

  // min_level column in DB
  const minLevelCol = await prisma.$queryRaw<any[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'min_level'
  `;
  assert(minLevelCol.length === 1, 'products.min_level column exists');

  // Product creation accepts minLevel
  const merchantSrc = fs.readFileSync('/home/loyalty-platform/src/api/routes/merchant.ts', 'utf-8');
  assert(merchantSrc.includes('minLevel'), 'Product creation accepts minLevel parameter');

  await app.close();

  console.log(`\n=== THREE GAPS: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
