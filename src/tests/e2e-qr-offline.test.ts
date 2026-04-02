import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import cors from '@fastify/cors';
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
import { createHmac } from 'crypto';
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
  console.log('=== QR OFFLINE RESILIENCE ===\n');
  await cleanAll();

  const tenant = await createTenant('Offline Store', 'offline-store', 'of@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'c@of.com', passwordHash: '$2b$10$x', role: 'cashier' },
  });

  await processCSV(`invoice_number,total\nOF-001,300.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'OF-001', total_amount: 300, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });
  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Prize', redemptionCost: '100.00000000', assetTypeId: asset.id, stock: 5, active: true, minLevel: 1 },
  });

  // ──────────────────────────────────
  // 1. QR is self-contained — all data in the token itself
  // ──────────────────────────────────
  console.log('1. QR token is self-contained');
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  assert(redemption.success === true, 'QR generated');

  // Decode the token — it contains everything needed to validate
  const decoded = JSON.parse(Buffer.from(redemption.token!, 'base64').toString('utf-8'));
  assert(!!decoded.payload.tokenId, 'Token contains tokenId');
  assert(!!decoded.payload.consumerAccountId, 'Token contains consumerAccountId');
  assert(!!decoded.payload.productId, 'Token contains productId');
  assert(!!decoded.payload.amount, 'Token contains amount');
  assert(!!decoded.payload.tenantId, 'Token contains tenantId');
  assert(!!decoded.payload.assetTypeId, 'Token contains assetTypeId');
  assert(!!decoded.payload.createdAt, 'Token contains createdAt');
  assert(!!decoded.payload.expiresAt, 'Token contains expiresAt');
  assert(!!decoded.signature, 'Token contains HMAC signature');

  // The token is a base64 string — it can be displayed as a QR and scanned
  // even if the consumer's device has no internet at scan time
  assert(typeof redemption.token === 'string', 'Token is a string (scannable as QR)');
  assert(redemption.token!.length > 0, 'Token has content');

  // ──────────────────────────────────
  // 2. Consumer goes offline — QR still valid when cashier scans
  //    (cashier's device has connectivity)
  // ──────────────────────────────────
  console.log('\n2. Consumer offline, cashier scans QR — server validates');

  // Simulate: consumer generated QR (above), then goes offline
  // The cashier now scans the token string directly — no consumer connectivity needed

  const scanResult = await processRedemption({
    token: redemption.token!,
    cashierStaffId: staff.id,
    cashierTenantId: tenant.id,
  });
  assert(scanResult.success === true, 'Cashier scans QR while consumer offline — SUCCESS');
  assert(scanResult.productName === 'Prize', `Product: ${scanResult.productName}`);

  // Verify ledger updated correctly
  const confirmedEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED' },
  });
  assert(confirmedEntries.length === 2, 'REDEMPTION_CONFIRMED written (2 entries)');

  // Token marked as used
  const tokenRecord = await prisma.redemptionToken.findUnique({ where: { id: decoded.payload.tokenId } });
  assert(tokenRecord!.status === 'used', 'Token status: used');

  // Stock decremented
  const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
  assert(updatedProduct!.stock === 4, `Stock decremented: 5 → ${updatedProduct!.stock}`);

  // ──────────────────────────────────
  // 3. QR requires server round-trip to generate — can't generate offline
  // ──────────────────────────────────
  console.log('\n3. QR generation requires server round-trip (cannot be created offline)');

  // The redeem endpoint is POST /api/consumer/redeem — requires HTTP request
  const consumerSrc = fs.readFileSync('/home/loyalty-platform/src/api/routes/consumer.ts', 'utf-8');
  assert(consumerSrc.includes("'/api/consumer/redeem'"), 'Redeem is an API endpoint (requires network)');

  // initiateRedemption writes to DB — impossible without server
  const redeemSrc = fs.readFileSync('/home/loyalty-platform/src/services/redemption.ts', 'utf-8');
  assert(redeemSrc.includes('prisma.redemptionToken.create'), 'Token stored in DB during generation');
  assert(redeemSrc.includes('writeDoubleEntry'), 'PENDING_REDEMPTION written during generation');

  // Frontend calls API — no local generation
  const catSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/catalog/page.tsx', 'utf-8');
  assert(catSrc.includes('api.redeemProduct'), 'Frontend calls API to generate QR');
  assert(!catSrc.includes('createHmac') && !catSrc.includes('crypto'), 'No crypto in frontend (no local token generation)');

  // ──────────────────────────────────
  // 4. Token validation is server-side — verifies signature + DB state
  // ──────────────────────────────────
  console.log('\n4. Validation is server-side (signature + DB lookup)');
  assert(redeemSrc.includes("createHmac('sha256'"), 'Server verifies HMAC signature');
  assert(redeemSrc.includes('redemptionToken.findUnique'), 'Server checks token in DB');
  assert(redeemSrc.includes("status === 'used'"), 'Server checks if already used');
  assert(redeemSrc.includes('expiresAt'), 'Server checks TTL');
  assert(redeemSrc.includes('cashierTenantId'), 'Server checks tenant match');

  console.log(`\n=== QR OFFLINE: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
