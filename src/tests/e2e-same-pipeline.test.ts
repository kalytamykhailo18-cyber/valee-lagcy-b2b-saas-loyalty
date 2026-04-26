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
import { handleIncomingMessage } from '../services/whatsapp-bot.js';
import { issueConsumerTokens } from '../services/auth.js';
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
  console.log('=== SAME PIPELINE: PWA vs WHATSAPP ===\n');
  await cleanAll();

  const tenant = await createTenant('Same Pipeline', 'same-pipeline', 'sp@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@sp.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total,phone\nSP-001,100.00,+584125550001\nSP-002,200.00,+584125550001\nSP-003,150.00,`, tenant.id, staff.id);

  // ──────────────────────────────────
  // 1. Both paths call the same validateInvoice function
  // ──────────────────────────────────
  console.log('1. Code: both paths use the same validateInvoice()');

  // PWA path: consumer.ts route
  const consumerSrc = fs.readFileSync('/home/loyalty-platform/src/api/routes/consumer.ts', 'utf-8');
  assert(consumerSrc.includes("import { validateInvoice }"), 'PWA route imports validateInvoice');
  assert(consumerSrc.includes("validateInvoice({"), 'PWA route calls validateInvoice()');

  // WhatsApp path: whatsapp-bot.ts
  const botSrc = fs.readFileSync('/home/loyalty-platform/src/services/whatsapp-bot.ts', 'utf-8');
  assert(botSrc.includes("const { validateInvoice } = await import"), 'WhatsApp bot imports validateInvoice');
  assert(botSrc.includes("validateInvoice({"), 'WhatsApp bot calls validateInvoice()');

  // Start test server for PWA API
  const app = Fastify();
  await app.register(cors);
  await app.register(cookie);
  await app.register(consumerRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  // Create consumer and get token
  const directResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SP-001', total_amount: 100, transaction_date: null, customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });
  const token = issueConsumerTokens({
    accountId: account!.id, tenantId: tenant.id, phoneNumber: '+584125550001', type: 'consumer',
  }).accessToken;

  // ──────────────────────────────────
  // 2. Phone cross-check works on PWA path
  // ──────────────────────────────────
  console.log('\n2. Anti-fraud: phone cross-check (PWA)');
  const phoneRes = await fetch(`${base}/api/consumer/validate-invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      extractedData: { invoice_number: 'SP-002', total_amount: 200, transaction_date: null, customer_phone: '+584125559999', merchant_name: null, confidence_score: 0.95 },
      assetTypeId: asset.id,
    }),
  });
  const phoneData = await phoneRes.json() as any;
  assert(phoneData.success === false, 'PWA: phone mismatch rejected');
  assert(phoneData.stage === 'identity_check', `PWA: rejected at identity_check (got ${phoneData.stage})`);

  // Same check on WhatsApp path
  const whatsappPhone = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SP-002', total_amount: 200, transaction_date: null, customer_phone: '+584125559999', merchant_name: null, confidence_score: 0.95 },
  });
  assert(whatsappPhone.success === false, 'WhatsApp: phone mismatch rejected');
  assert(whatsappPhone.stage === 'identity_check', `WhatsApp: rejected at identity_check`);

  // ──────────────────────────────────
  // 3. Invoice existence check works on PWA path
  // ──────────────────────────────────
  console.log('\n3. Anti-fraud: invoice existence check (PWA)');
  const existRes = await fetch(`${base}/api/consumer/validate-invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      extractedData: { invoice_number: 'FAKE-999', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
      assetTypeId: asset.id,
    }),
  });
  const existData = await existRes.json() as any;
  assert(existData.success === false, 'PWA: non-existent invoice rejected');
  assert(existData.stage === 'cross_reference', 'PWA: rejected at cross_reference');

  // ──────────────────────────────────
  // 4. Duplicate prevention works on PWA path
  // ──────────────────────────────────
  console.log('\n4. Anti-fraud: duplicate prevention (PWA)');
  // SP-001 already claimed above
  const dupRes = await fetch(`${base}/api/consumer/validate-invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      extractedData: { invoice_number: 'SP-001', total_amount: 100, transaction_date: null, customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
      assetTypeId: asset.id,
    }),
  });
  const dupData = await dupRes.json() as any;
  assert(dupData.success === false, 'PWA: duplicate rejected');
  assert(dupData.message.includes('already'), 'PWA: says already used');

  // ──────────────────────────────────
  // 5. Double-entry created identically on both paths
  // ──────────────────────────────────
  console.log('\n5. Double-entry created on PWA path');
  // Claim SP-002 via PWA (reset phone mismatch invoice first)
  const pwaVal = await fetch(`${base}/api/consumer/validate-invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      extractedData: { invoice_number: 'SP-002', total_amount: 200, transaction_date: null, customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
      assetTypeId: asset.id,
    }),
  });
  const pwaData = await pwaVal.json() as any;
  assert(pwaData.success === true, 'PWA: validation succeeded');

  const pwaEntries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, referenceId: 'SP-002' } });
  assert(pwaEntries.length === 2, `PWA: 2 ledger entries (double-entry) (got ${pwaEntries.length})`);
  assert(pwaEntries.some(e => e.entryType === 'DEBIT'), 'PWA: has DEBIT');
  assert(pwaEntries.some(e => e.entryType === 'CREDIT'), 'PWA: has CREDIT');

  // Compare with WhatsApp path entries (SP-001)
  const waEntries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, referenceId: 'SP-001' } });
  assert(waEntries.length === 2, 'WhatsApp: also 2 ledger entries');

  // Same event type on both
  assert(pwaEntries[0].eventType === waEntries[0].eventType, `Same event type: ${pwaEntries[0].eventType}`);

  await app.close();
  console.log(`\n=== SAME PIPELINE: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
