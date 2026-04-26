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
import { expireRedemption } from '../services/redemption.js';
import { getAccountBalance } from '../services/ledger.js';
import { issueConsumerTokens } from '../services/auth.js';
import consumerRoutes from '../api/routes/consumer.js';
import { createHmac } from 'crypto';
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

async function test() {
  console.log('=== STEP 2.4: REDEMPTION QR GENERATION — FULL E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Redeem Store', 'redeem-store', 'rd@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@rd.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Give consumer 500 pts
  await processCSV(`invoice_number,total\nRD-001,500.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'RD-001', total_amount: 500, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Test Prize', redemptionCost: '100.00000000', assetTypeId: asset.id, stock: 5, active: true, minLevel: 1 },
  });
  const expensiveProduct = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Too Expensive', redemptionCost: '99999.00000000', assetTypeId: asset.id, stock: 1, active: true, minLevel: 1 },
  });

  // Start server
  const app = Fastify();
  await app.register(cors);
  await app.register(cookie);
  await app.register(consumerRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const token = issueConsumerTokens({
    accountId: account!.id, tenantId: tenant.id, phoneNumber: '+584125550001', type: 'consumer',
  }).accessToken;

  // ──────────────────────────────────
  // FLOW STEP 1-2: Tap Redeem → Confirmation screen
  // ──────────────────────────────────
  console.log('1-2. Frontend: confirmation screen before redeem');
  const catSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/catalog/page.tsx', 'utf-8');
  assert(catSrc.includes('selectedProduct'), 'Confirmation screen state exists');
  assert(catSrc.includes('Confirmar canje'), 'Shows "Confirmar canje" heading');
  assert(catSrc.includes('selectedProduct.name'), 'Shows product name');
  assert(catSrc.includes('selectedProduct.redemptionCost'), 'Shows cost in points');
  assert(catSrc.includes('balanceAfter') || catSrc.includes('balAfter') || catSrc.includes('Saldo despues'), 'Shows remaining balance after');
  assert(catSrc.includes('Confirmar') && catSrc.includes('Cancelar'), 'Has Confirm and Cancel buttons');

  // ──────────────────────────────────
  // FLOW STEP 3a: Final balance check on server
  // ──────────────────────────────────
  console.log('\n3a. Server: final balance check');

  // Insufficient balance → rejected
  const failRes = await fetch(`${base}/api/consumer/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ productId: expensiveProduct.id, assetTypeId: asset.id }),
  });
  const failData = await failRes.json() as any;
  assert(failData.success === false, 'Insufficient balance rejected on server');
  assert(failData.message.includes('Insufficient') || failData.message.includes('insufficient'), `Message: ${failData.message.slice(0, 50)}`);

  // ──────────────────────────────────
  // FLOW STEP 3b: PENDING_REDEMPTION double-entry + signed token
  // ──────────────────────────────────
  console.log('\n3b. Server: PENDING_REDEMPTION + signed token');
  const balBefore = await getAccountBalance(account!.id, asset.id, tenant.id);

  const redeemRes = await fetch(`${base}/api/consumer/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ productId: product.id, assetTypeId: asset.id }),
  });
  const redeemData = await redeemRes.json() as any;

  assert(redeemData.success === true, 'Redemption initiated');
  assert(!!redeemData.token, `Token generated (${redeemData.token?.length} chars)`);
  assert(!!redeemData.tokenId, `Token ID: ${redeemData.tokenId?.slice(0,8)}...`);
  assert(!!redeemData.expiresAt, `Expires at: ${redeemData.expiresAt}`);
  assert(Number(redeemData.amount) === 100, `Amount reserved: ${redeemData.amount}`);

  // Balance reduced (value reserved)
  const balAfter = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(Number(balAfter) === Number(balBefore) - 100, `Balance reduced: ${balBefore} → ${balAfter}`);

  // PENDING_REDEMPTION double-entry in ledger
  const pendingEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_PENDING' },
  });
  assert(pendingEntries.length === 2, `2 PENDING_REDEMPTION entries (got ${pendingEntries.length})`);
  const debit = pendingEntries.find(e => e.entryType === 'DEBIT')!;
  const credit = pendingEntries.find(e => e.entryType === 'CREDIT')!;
  assert(debit.accountId === account!.id, 'DEBIT from consumer (value leaves)');
  assert(credit.accountId === sys.holding.id, 'CREDIT to redemption_holding (value reserved)');

  // Token stored in redemption_tokens table
  const tokenRecord = await prisma.redemptionToken.findUnique({ where: { id: redeemData.tokenId } });
  assert(tokenRecord !== null, 'Token stored in redemption_tokens table');
  assert(tokenRecord!.status === 'pending', 'Token status: pending');

  // Token is cryptographically signed (HMAC-SHA256)
  const decoded = JSON.parse(Buffer.from(redeemData.token, 'base64').toString('utf-8'));
  assert(decoded.signature.length === 64, 'HMAC-SHA256 signature (64 hex chars)');
  assert(decoded.payload.consumerAccountId === account!.id, 'Token contains consumer account ID');
  assert(decoded.payload.productId === product.id, 'Token contains product ID');
  assert(decoded.payload.tenantId === tenant.id, 'Token contains tenant ID');
  assert(Number(decoded.payload.amount) === 100, `Token contains value amount: ${decoded.payload.amount}`);
  assert(!!decoded.payload.createdAt, 'Token contains creation timestamp');
  assert(!!decoded.payload.expiresAt, 'Token contains expiry timestamp');

  // Verify signature
  const hmacSecret = process.env.HMAC_SECRET!;
  const expectedSig = createHmac('sha256', hmacSecret).update(JSON.stringify(decoded.payload)).digest('hex');
  assert(decoded.signature === expectedSig, 'Signature verifies with HMAC_SECRET from .env');

  // TTL from .env
  const ttl = parseInt(process.env.REDEMPTION_TOKEN_TTL_MINUTES || '15');
  assert(ttl === 15, `REDEMPTION_TOKEN_TTL_MINUTES from .env: ${ttl}`);

  // ──────────────────────────────────
  // FLOW STEP 4: Countdown timer in frontend
  // ──────────────────────────────────
  console.log('\n4. Frontend: countdown timer');
  assert(catSrc.includes('CountdownTimer'), 'CountdownTimer component exists');
  assert(catSrc.includes('expiresAt'), 'Uses expiresAt from API response');
  assert(catSrc.includes('Expirado'), 'Shows "Expirado" when expired');

  // ──────────────────────────────────
  // QR EXPIRY: reversal
  // ──────────────────────────────────
  console.log('\n5. QR expiry → REDEMPTION_EXPIRED reversal');

  // Force token to expire
  await prisma.redemptionToken.update({
    where: { id: redeemData.tokenId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await expireRedemption(redeemData.tokenId);

  // Token status changed
  const expiredToken = await prisma.redemptionToken.findUnique({ where: { id: redeemData.tokenId } });
  assert(expiredToken!.status === 'expired', `Token status: expired (got ${expiredToken!.status})`);

  // REDEMPTION_EXPIRED double-entry
  const expiredEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_EXPIRED' },
  });
  assert(expiredEntries.length === 2, `2 REDEMPTION_EXPIRED entries (got ${expiredEntries.length})`);
  const expDebit = expiredEntries.find(e => e.entryType === 'DEBIT')!;
  const expCredit = expiredEntries.find(e => e.entryType === 'CREDIT')!;
  assert(expDebit.accountId === sys.holding.id, 'Expiry DEBIT from holding (releases)');
  assert(expCredit.accountId === account!.id, 'Expiry CREDIT to consumer (value returned)');

  // Balance restored
  const balRestored = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(Number(balRestored) === Number(balBefore), `Balance restored: ${balRestored} (was ${balBefore})`);

  // ──────────────────────────────────
  // SAME QR cannot be used twice
  // ──────────────────────────────────
  console.log('\n6. Expired QR cannot be used');
  const { processRedemption } = await import('../services/redemption.js');
  const expiredScan = await processRedemption({
    token: redeemData.token, cashierStaffId: staff.id, cashierTenantId: tenant.id,
  });
  assert(expiredScan.success === false, 'Expired QR rejected');
  assert(expiredScan.message.includes('expired'), `Reason: ${expiredScan.message}`);

  await app.close();
  console.log(`\n=== STEP 2.4: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
