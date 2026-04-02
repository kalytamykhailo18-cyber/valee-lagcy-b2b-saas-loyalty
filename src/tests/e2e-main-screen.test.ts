import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import cors from '@fastify/cors';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { generateOTP, issueConsumerTokens } from '../services/auth.js';
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

async function get(base: string, path: string, token: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, data: await res.json() as any };
}

async function test() {
  console.log('=== MAIN SCREEN: NAME/PHONE + BALANCE + HISTORY ===\n');
  await cleanAll();

  const tenant = await createTenant('Main Screen Store', 'main-screen', 'ms@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@ms.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Create some history
  await processCSV(`invoice_number,total\nMS-001,120.00\nMS-002,80.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'MS-001', total_amount: 120, transaction_date: '2024-03-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'MS-002', total_amount: 80, transaction_date: '2024-03-02', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

  const app = Fastify();
  await app.register(cors);
  await app.register(consumerRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const token = issueConsumerTokens({
    accountId: account!.id, tenantId: tenant.id, phoneNumber: '+584125550001', type: 'consumer',
  }).accessToken;

  // ──────────────────────────────────
  // 1. Consumer identifier (phone number since no name)
  // ──────────────────────────────────
  console.log('1. Consumer identifier');
  const accRes = await get(base, '/api/consumer/account', token);
  assert(accRes.status === 200, 'Account endpoint works');
  assert(accRes.data.phoneNumber === '+584125550001', `Shows phone number: ${accRes.data.phoneNumber}`);
  assert(accRes.data.merchantName === 'Main Screen Store', `Merchant name: ${accRes.data.merchantName}`);

  // Frontend shows phone number
  const pageSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx', 'utf-8');
  assert(pageSrc.includes('account?.phoneNumber'), 'Frontend displays phone number');

  // ──────────────────────────────────
  // 2. Balance prominently displayed with correct label
  // ──────────────────────────────────
  console.log('\n2. Balance with correct asset label');
  const balRes = await get(base, '/api/consumer/balance', token);
  assert(balRes.status === 200, 'Balance endpoint works');

  // 120 + 80 = 200 (welcome bonus only via WhatsApp bot, not direct validation)
  const expectedBal = 200;
  assert(Number(balRes.data.balance) === expectedBal, `Balance: ${balRes.data.balance} (expected ${expectedBal})`);
  assert(balRes.data.unitLabel === 'pts', `Unit label: ${balRes.data.unitLabel}`);
  assert(!!balRes.data.assetTypeId, 'Asset type ID returned');

  // Frontend: balance prominently displayed
  assert(pageSrc.includes('text-4xl font-bold'), 'Balance in large text (text-4xl font-bold)');
  assert(pageSrc.includes('Tu saldo'), 'Label: "Tu saldo"');
  assert(pageSrc.includes('{unitLabel}'), 'Shows unit label dynamically');

  // ──────────────────────────────────
  // 3. Transaction history — all events, newest first
  // ──────────────────────────────────
  console.log('\n3. Transaction history');
  const histRes = await get(base, '/api/consumer/history', token);
  assert(histRes.status === 200, 'History endpoint works');
  assert(histRes.data.entries.length >= 2, `Has entries (${histRes.data.entries.length})`);

  // Check each entry has required fields
  const entry = histRes.data.entries[0];
  assert(!!entry.eventType, `eventType: ${entry.eventType}`);
  assert(!!entry.amount, `amount: ${entry.amount}`);
  assert(!!entry.entryType, `entryType (CREDIT/DEBIT): ${entry.entryType}`);
  assert(!!entry.createdAt, `createdAt: ${entry.createdAt}`);
  assert(entry.merchantName === 'Main Screen Store', `merchantName: ${entry.merchantName}`);

  // Newest first (descending order)
  if (histRes.data.entries.length >= 2) {
    const first = new Date(histRes.data.entries[0].createdAt).getTime();
    const second = new Date(histRes.data.entries[1].createdAt).getTime();
    assert(first >= second, 'Ordered newest first (descending)');
  }

  // Frontend renders each entry with required fields
  assert(pageSrc.includes('EVENT_LABELS[entry.eventType]'), 'Shows event type in human-readable form');
  assert(pageSrc.includes("entry.entryType === 'CREDIT' ? '+' : '-'"), 'Shows + for credit, - for debit');
  assert(pageSrc.includes('entry.amount'), 'Shows amount');
  assert(pageSrc.includes('entry.createdAt'), 'Shows date/time');
  assert(pageSrc.includes('entry.merchantName'), 'Shows merchant name');

  // Event type labels in Spanish
  assert(pageSrc.includes("INVOICE_CLAIMED: 'Factura validada'"), 'Invoice claimed in Spanish');
  assert(pageSrc.includes("REDEMPTION_CONFIRMED: 'Canje procesado'"), 'Redemption in Spanish');

  // ──────────────────────────────────
  // 4. Balance is always live (fetched fresh)
  // ──────────────────────────────────
  console.log('\n4. Balance always live (fresh from ledger)');
  // The API always computes balance from SUM — no cached value
  const ledgerSrc = fs.readFileSync('/home/loyalty-platform/src/services/ledger.ts', 'utf-8');
  assert(ledgerSrc.includes('SUM(CASE WHEN entry_type'), 'Balance computed from ledger SUM on every call');
  assert(!ledgerSrc.includes('balance_cache') && !ledgerSrc.includes('cachedBalance'), 'No cached balance');

  // Frontend fetches on every load
  assert(pageSrc.includes('api.getBalance()'), 'Calls getBalance() on load');
  assert(pageSrc.includes('api.getHistory()'), 'Calls getHistory() on load');

  await app.close();
  console.log(`\n=== MAIN SCREEN: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
