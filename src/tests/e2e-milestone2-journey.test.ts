import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { generateOTP, issueStaffTokens } from '../services/auth.js';
import consumerRoutes from '../api/routes/consumer.js';
import merchantRoutes from '../api/routes/merchant.js';
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

async function post(base: string, path: string, body: any, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as any };
}

async function get(base: string, path: string, token: string) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, data: await res.json() as any };
}

async function test() {
  console.log('=== MILESTONE 2: FULL USER JOURNEY VIA HTTP API ===\n');
  await cleanAll();

  const tenant = await createTenant('Journey Store', 'journey-store', 'js@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'owner@js.com', passwordHash: await bcrypt.hash('pass123', 10), role: 'owner' },
  });
  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'cashier@js.com', passwordHash: await bcrypt.hash('cash123', 10), role: 'cashier' },
  });

  // Upload CSV and give consumer some value
  await processCSV(`invoice_number,total\nJRN-001,500.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'JRN-001', total_amount: 500, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  // Create products
  await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Coffee Mug', redemptionCost: '100.00000000', assetTypeId: asset.id, stock: 5, active: true, minLevel: 1 },
  });
  await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Laptop', redemptionCost: '99999.00000000', assetTypeId: asset.id, stock: 1, active: true, minLevel: 1 },
  });
  await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Sold Out Item', redemptionCost: '10.00000000', assetTypeId: asset.id, stock: 0, active: true, minLevel: 1 },
  });
  await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Hidden Item', redemptionCost: '10.00000000', assetTypeId: asset.id, stock: 5, active: false, minLevel: 1 },
  });

  // Start test server
  const app = Fastify();
  await app.register(cors);
  await app.register(cookie);
  await app.register(consumerRoutes);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  // ──────────────────────────────────
  // STEP 2.1: Consumer OTP login → JWT → balance → history
  // ──────────────────────────────────
  console.log('STEP 2.1: Consumer login (OTP) → balance → history');

  // Request OTP
  const otpRes = await post(base, '/api/consumer/auth/request-otp', { phoneNumber: '+584125550001', tenantSlug: 'journey-store' });
  assert(otpRes.status === 200, `OTP requested (${otpRes.status})`);

  // In production, OTP is not returned in response — read it from the DB
  let otp = otpRes.data.otp;
  if (!otp) {
    // Generate a fresh OTP directly for testing
    otp = await generateOTP('+584125550001');
  }
  assert(otp?.length === 6, `OTP obtained: ${otp}`);

  // Verify OTP → get JWT
  const verifyRes = await post(base, '/api/consumer/auth/verify-otp', { phoneNumber: '+584125550001', otp, tenantSlug: 'journey-store' });
  assert(verifyRes.status === 200, `OTP verified (${verifyRes.status})`);
  assert(!!verifyRes.data.accessToken, 'Access token issued');
  assert(!!verifyRes.data.refreshToken, 'Refresh token issued');
  const consumerToken = verifyRes.data.accessToken;

  // Get balance
  const balRes = await get(base, '/api/consumer/balance', consumerToken);
  assert(balRes.status === 200, `Balance endpoint (${balRes.status})`);
  assert(Number(balRes.data.balance) >= 500, `Balance: ${balRes.data.balance}`);
  assert(balRes.data.unitLabel === 'pts', `Unit label: ${balRes.data.unitLabel}`);

  // Get history
  const histRes = await get(base, '/api/consumer/history', consumerToken);
  assert(histRes.status === 200, `History endpoint (${histRes.status})`);
  assert(histRes.data.entries.length >= 1, `History entries: ${histRes.data.entries.length}`);
  assert(histRes.data.entries[0].eventType === 'INVOICE_CLAIMED' || histRes.data.entries[0].eventType === 'ADJUSTMENT_MANUAL', `First event: ${histRes.data.entries[0].eventType}`);

  // Get account info
  const accRes = await get(base, '/api/consumer/account', consumerToken);
  assert(accRes.status === 200, `Account endpoint (${accRes.status})`);
  assert(accRes.data.phoneNumber === '+584125550001', 'Phone correct');

  // ──────────────────────────────────
  // STEP 2.3: Product catalog
  // ──────────────────────────────────
  console.log('\nSTEP 2.3: Product catalog');

  const catRes = await get(base, '/api/consumer/catalog', consumerToken);
  assert(catRes.status === 200, `Catalog endpoint (${catRes.status})`);

  const productNames = catRes.data.products.map((p: any) => p.name);
  assert(productNames.includes('Coffee Mug'), 'Affordable product visible');
  assert(productNames.includes('Laptop'), 'Expensive product visible (but canAfford=false)');
  assert(!productNames.includes('Sold Out Item'), 'Zero-stock product hidden');
  assert(!productNames.includes('Hidden Item'), 'Inactive product hidden');

  const mug = catRes.data.products.find((p: any) => p.name === 'Coffee Mug');
  const laptop = catRes.data.products.find((p: any) => p.name === 'Laptop');
  assert(mug.canAfford === true, 'Coffee Mug: canAfford=true');
  assert(laptop.canAfford === false, 'Laptop: canAfford=false');

  // ──────────────────────────────────
  // STEP 2.4: Redemption QR generation
  // ──────────────────────────────────
  console.log('\nSTEP 2.4: Redemption QR generation');

  const redeemRes = await post(base, '/api/consumer/redeem', { productId: mug.id, assetTypeId: asset.id }, consumerToken);
  assert(redeemRes.status === 200, `Redeem endpoint (${redeemRes.status})`);
  assert(redeemRes.data.success === true, 'Redemption initiated');
  assert(!!redeemRes.data.token, `Token generated (${redeemRes.data.token?.length} chars)`);
  assert(!!redeemRes.data.expiresAt, `Expires at: ${redeemRes.data.expiresAt}`);
  assert(!!redeemRes.data.tokenId, 'Token ID returned');

  // Balance reduced
  const balAfterRedeem = await get(base, '/api/consumer/balance', consumerToken);
  const expectedBal = Number(balRes.data.balance) - 100;
  assert(Number(balAfterRedeem.data.balance) === expectedBal, `Balance reduced: ${balAfterRedeem.data.balance} (expected ${expectedBal})`);

  // PENDING_REDEMPTION in ledger
  const pendingEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_PENDING' },
  });
  assert(pendingEntries.length === 2, `2 PENDING_REDEMPTION entries (${pendingEntries.length})`);

  // ──────────────────────────────────
  // STEP 2.5: Cashier scans QR → processes redemption
  // ──────────────────────────────────
  console.log('\nSTEP 2.5: Cashier scans QR');

  const cashierToken = issueStaffTokens({ staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff' }).accessToken;

  const scanRes = await post(base, '/api/merchant/scan-redemption', { token: redeemRes.data.token }, cashierToken);
  assert(scanRes.status === 200, `Scan endpoint (${scanRes.status})`);
  assert(scanRes.data.success === true, 'Scan succeeded');
  assert(scanRes.data.productName === 'Coffee Mug', `Product: ${scanRes.data.productName}`);

  // REDEMPTION_CONFIRMED in ledger
  const confirmedEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED' },
  });
  assert(confirmedEntries.length === 2, `2 REDEMPTION_CONFIRMED entries (${confirmedEntries.length})`);

  // Product stock decremented
  const mugAfter = await prisma.product.findFirst({ where: { tenantId: tenant.id, name: 'Coffee Mug' } });
  assert(mugAfter!.stock === 4, `Stock decremented: 5 → ${mugAfter!.stock}`);

  // Audit log entry
  const auditEntries = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenant.id}::uuid AND action_type = 'QR_SCAN_SUCCESS'
  `;
  assert(auditEntries.length === 1, `Audit log: QR_SCAN_SUCCESS (${auditEntries.length})`);

  // Scan same QR again → rejected
  const dupScan = await post(base, '/api/merchant/scan-redemption', { token: redeemRes.data.token }, cashierToken);
  assert(dupScan.data.success === false, 'Duplicate scan rejected');

  // ──────────────────────────────────
  // STEP 2.7: Shadow → verified identity upgrade
  // ──────────────────────────────────
  console.log('\nSTEP 2.7: Identity upgrade (shadow → verified)');

  // Cashier looks up consumer
  const lookupRes = await get(base, `/api/merchant/customer-lookup/${encodeURIComponent('+584125550001')}`, cashierToken);
  assert(lookupRes.status === 200, `Lookup endpoint (${lookupRes.status})`);
  assert(lookupRes.data.account.accountType === 'shadow', `Account type: shadow`);

  // Upgrade to verified
  const upgradeRes = await post(base, '/api/merchant/identity-upgrade', { phoneNumber: '+584125550001', cedula: 'V-12345678' }, cashierToken);
  assert(upgradeRes.status === 200, `Upgrade endpoint (${upgradeRes.status})`);
  assert(upgradeRes.data.account.accountType === 'verified', `Account type: verified`);
  assert(upgradeRes.data.account.cedula === 'V-12345678', `Cedula stored`);

  // Duplicate cedula → conflict
  await prisma.account.create({ data: { tenantId: tenant.id, phoneNumber: '+584125550002', accountType: 'shadow' } });
  const dupCedula = await post(base, '/api/merchant/identity-upgrade', { phoneNumber: '+584125550002', cedula: 'V-12345678' }, cashierToken);
  assert(dupCedula.status === 409, `Duplicate cedula → 409 (${dupCedula.status})`);

  // ──────────────────────────────────
  // FRONTEND: All pages exist
  // ──────────────────────────────────
  console.log('\nFRONTEND: All Milestone 2 pages');
  const fs = await import('fs');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx'), 'Consumer main page');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(consumer)/scan/page.tsx'), 'Invoice scan page');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(consumer)/catalog/page.tsx'), 'Product catalog page');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/scanner/page.tsx'), 'Cashier scanner page');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/products/page.tsx'), 'Catalog management page');
  assert(fs.existsSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/customers/page.tsx'), 'Customer lookup page');

  await app.close();
  console.log(`\n=== MILESTONE 2 JOURNEY: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
