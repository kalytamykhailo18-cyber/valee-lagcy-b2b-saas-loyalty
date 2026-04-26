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
import { generateOTP } from '../services/auth.js';
import consumerRoutes from '../api/routes/consumer.js';
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
  console.log('=== STEP 2.1: CONSUMER PWA AUTH + BALANCE + HISTORY — DEEP E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Step21 Store', 'step21-store', 's21@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@s21.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total\nS21-001,300.00\nS21-002,200.00`, tenant.id, staff.id);

  // Start server with cookie support
  const app = Fastify();
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(consumerRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  // ──────────────────────────────────
  // 1. OTP AUTH: phone number, no passwords
  // ──────────────────────────────────
  console.log('1. OTP authentication (phone only, no passwords)');

  // Request OTP
  const otpRes = await fetch(`${base}/api/consumer/auth/request-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: '+584125550001', tenantSlug: 'step21-store' }),
  });
  const otpData = await otpRes.json() as any;
  assert(otpRes.ok, `Request OTP: ${otpRes.status}`);

  // Get OTP from DB (production hides it)
  const otp = await generateOTP('+584125550001');
  assert(otp.length === 6, `OTP is 6 digits: ${otp}`);

  // Wrong OTP rejected
  const wrongRes = await fetch(`${base}/api/consumer/auth/verify-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: '+584125550001', otp: '000000', tenantSlug: 'step21-store' }),
  });
  assert(wrongRes.status === 401, `Wrong OTP: 401 (got ${wrongRes.status})`);

  // Correct OTP → JWT issued
  const verifyRes = await fetch(`${base}/api/consumer/auth/verify-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: '+584125550001', otp, tenantSlug: 'step21-store' }),
  });
  const verifyData = await verifyRes.json() as any;
  assert(verifyRes.ok, `Verify OTP: ${verifyRes.status}`);
  assert(!!verifyData.accessToken, 'Access token in response body');
  assert(!!verifyData.refreshToken, 'Refresh token in response body');

  // ──────────────────────────────────
  // 2. HTTP-ONLY COOKIES set
  // ──────────────────────────────────
  console.log('\n2. HTTP-only cookies');
  const setCookieHeaders = verifyRes.headers.getSetCookie();
  assert(setCookieHeaders.length >= 2, `${setCookieHeaders.length} Set-Cookie headers`);

  const accessCookie = setCookieHeaders.find(c => c.startsWith('accessToken='));
  const refreshCookie = setCookieHeaders.find(c => c.startsWith('refreshToken='));
  assert(!!accessCookie, 'accessToken cookie set');
  assert(!!refreshCookie, 'refreshToken cookie set');
  assert(accessCookie!.includes('HttpOnly'), 'accessToken is HttpOnly');
  assert(refreshCookie!.includes('HttpOnly'), 'refreshToken is HttpOnly');
  assert(accessCookie!.includes('Secure'), 'accessToken is Secure');

  const token = verifyData.accessToken;

  // ──────────────────────────────────
  // 3. JWT middleware injects consumer context
  // ──────────────────────────────────
  console.log('\n3. JWT middleware injects consumer context');

  // No auth → 401
  const noAuthRes = await fetch(`${base}/api/consumer/balance`);
  assert(noAuthRes.status === 401, `No auth: 401 (got ${noAuthRes.status})`);

  // With token → works
  const authRes = await fetch(`${base}/api/consumer/balance`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(authRes.ok, `With token: ${authRes.status}`);

  // ──────────────────────────────────
  // 4. BALANCE: live, correct, with asset label
  // ──────────────────────────────────
  console.log('\n4. Balance (live from ledger, correct asset label)');

  // Validate an invoice to give balance
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'S21-001', total_amount: 300, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const balRes = await fetch(`${base}/api/consumer/balance`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const balData = await balRes.json() as any;
  assert(balRes.ok, 'Balance endpoint OK');
  assert(Number(balData.balance) === 300, `Balance: 300 (got ${balData.balance})`);
  assert(balData.unitLabel === 'pts', `Unit label: pts (got ${balData.unitLabel})`);
  assert(!!balData.assetTypeId, 'assetTypeId returned');

  // Validate second invoice → balance updates immediately
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'S21-002', total_amount: 200, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const balRes2 = await fetch(`${base}/api/consumer/balance`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const balData2 = await balRes2.json() as any;
  assert(Number(balData2.balance) === 500, `Updated balance: 500 (got ${balData2.balance})`);

  // ──────────────────────────────────
  // 5. HISTORY: all events, newest first, all fields
  // ──────────────────────────────────
  console.log('\n5. Transaction history');
  const histRes = await fetch(`${base}/api/consumer/history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const histData = await histRes.json() as any;
  assert(histRes.ok, 'History endpoint OK');
  assert(histData.entries.length >= 2, `${histData.entries.length} entries`);

  // Newest first
  const dates = histData.entries.map((e: any) => new Date(e.createdAt).getTime());
  assert(dates[0] >= dates[1], 'Newest first (descending)');

  // Each entry has all required fields
  const entry = histData.entries[0];
  assert(typeof entry.eventType === 'string', `eventType: ${entry.eventType}`);
  assert(typeof entry.amount === 'string', `amount: ${entry.amount}`);
  assert(entry.entryType === 'CREDIT' || entry.entryType === 'DEBIT', `entryType: ${entry.entryType}`);
  assert(typeof entry.createdAt === 'string', `createdAt: ${entry.createdAt}`);
  assert(typeof entry.merchantName === 'string', `merchantName: ${entry.merchantName}`);

  // ──────────────────────────────────
  // 6. ACCOUNT INFO
  // ──────────────────────────────────
  console.log('\n6. Account info');
  const accRes = await fetch(`${base}/api/consumer/account`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accData = await accRes.json() as any;
  assert(accRes.ok, 'Account endpoint OK');
  assert(accData.phoneNumber === '+584125550001', `Phone: ${accData.phoneNumber}`);
  assert(accData.merchantName === 'Step21 Store', `Merchant: ${accData.merchantName}`);

  // ──────────────────────────────────
  // 7. WELCOME CARD (frontend)
  // ──────────────────────────────────
  console.log('\n7. Welcome card (frontend)');
  const pageSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx', 'utf-8');
  assert(pageSrc.includes("!localStorage.getItem('welcomeDismissed')"), 'Checks dismissal state');
  assert(pageSrc.includes('histData.entries.length === 0'), 'Only shows when no history');
  assert(pageSrc.includes('>Hola!</'), 'Greets generically');
  assert(pageSrc.includes('Bienvenido'), 'Explains app purpose');
  assert(pageSrc.includes("localStorage.setItem('welcomeDismissed', 'true')"), 'Persists dismissal permanently');
  assert(pageSrc.includes('animate-fade-in'), 'Animated entrance');

  // ──────────────────────────────────
  // 8. FRONTEND: main screen elements
  // ──────────────────────────────────
  console.log('\n8. Frontend main screen elements');
  assert(pageSrc.includes('account?.phoneNumber'), 'Shows phone number');
  assert(pageSrc.includes('text-4xl font-bold'), 'Balance prominently displayed');
  assert(pageSrc.includes('{unitLabel}'), 'Shows asset label dynamically');
  assert(pageSrc.includes('EVENT_LABELS'), 'Human-readable event labels');
  assert(pageSrc.includes("'text-green-600'"), 'Green for credits');
  assert(pageSrc.includes("'text-red-500'"), 'Red for debits');
  assert(pageSrc.includes("toLocaleString('es-VE')"), 'Venezuelan date format');
  assert(pageSrc.includes('entry.merchantName'), 'Shows merchant name');

  // ──────────────────────────────────
  // 9. REFRESH TOKEN
  // ──────────────────────────────────
  console.log('\n9. Token refresh');
  const refreshRes = await fetch(`${base}/api/consumer/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: verifyData.refreshToken }),
  });
  const refreshData = await refreshRes.json() as any;
  assert(refreshRes.ok, `Refresh: ${refreshRes.status}`);
  assert(!!refreshData.accessToken, 'New access token issued');
  assert(typeof refreshData.accessToken === 'string' && refreshData.accessToken.length > 0, 'New access token is valid');

  // Refresh also sets cookies
  const refreshCookies = refreshRes.headers.getSetCookie();
  assert(refreshCookies.length >= 2, 'Refresh sets new cookies');

  // ──────────────────────────────────
  // 10. OTP SENT VIA WHATSAPP
  // ──────────────────────────────────
  console.log('\n10. OTP delivery');
  const whatsappSrc = fs.readFileSync('/home/loyalty-platform/src/services/whatsapp.ts', 'utf-8');
  assert(whatsappSrc.includes('EVOLUTION_API_URL'), 'OTP sent via Evolution API');
  const consumerSrc = fs.readFileSync('/home/loyalty-platform/src/api/routes/consumer.ts', 'utf-8');
  assert(consumerSrc.includes('sendWhatsAppOTP'), 'OTP endpoint calls sendWhatsAppOTP');

  await app.close();
  console.log(`\n=== STEP 2.1: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
