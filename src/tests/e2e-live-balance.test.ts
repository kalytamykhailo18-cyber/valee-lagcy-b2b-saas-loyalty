import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import cors from '@fastify/cors';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { writeDoubleEntry, getAccountBalance } from '../services/ledger.js';
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
  console.log('=== LIVE BALANCE: ALWAYS FRESH, NEVER CACHED ===\n');
  await cleanAll();

  const tenant = await createTenant('Live Store', 'live-store', 'ls@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@ls.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  await processCSV(`invoice_number,total\nLIVE-001,100.00\nLIVE-002,200.00\nLIVE-003,50.00`, tenant.id, staff.id);

  // Create consumer via first validation
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'LIVE-001', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

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

  async function fetchBalance(): Promise<number> {
    const res = await fetch(`${base}/api/consumer/balance`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json() as any;
    return Number(data.balance);
  }

  async function fetchHistoryCount(): Promise<number> {
    const res = await fetch(`${base}/api/consumer/history`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json() as any;
    return data.entries.length;
  }

  // ──────────────────────────────────
  // 1. Initial state
  // ──────────────────────────────────
  console.log('1. Initial state after first invoice');
  const bal1 = await fetchBalance();
  const hist1 = await fetchHistoryCount();
  assert(bal1 === 100, `Balance: 100 (got ${bal1})`);
  assert(hist1 === 1, `History: 1 entry (got ${hist1})`);

  // ──────────────────────────────────
  // 2. Validate second invoice → balance updates immediately
  // ──────────────────────────────────
  console.log('\n2. Second invoice → balance updates on next fetch');
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'LIVE-002', total_amount: 200, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const bal2 = await fetchBalance();
  const hist2 = await fetchHistoryCount();
  assert(bal2 === 300, `Balance: 300 (got ${bal2})`);
  assert(hist2 === 2, `History: 2 entries (got ${hist2})`);

  // ──────────────────────────────────
  // 3. Third invoice → updates again
  // ──────────────────────────────────
  console.log('\n3. Third invoice → updates again');
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'LIVE-003', total_amount: 50, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const bal3 = await fetchBalance();
  const hist3 = await fetchHistoryCount();
  assert(bal3 === 350, `Balance: 350 (got ${bal3})`);
  assert(hist3 === 3, `History: 3 entries (got ${hist3})`);

  // ──────────────────────────────────
  // 4. Manual adjustment → reflected immediately
  // ──────────────────────────────────
  console.log('\n4. Manual adjustment → balance reflects immediately');
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: account!.id, creditAccountId: sys.pool.id,
    amount: '100.00000000', assetTypeId: asset.id,
    referenceId: 'LIVE-ADJ-001', referenceType: 'manual_adjustment',
    metadata: { reason: 'Test debit' },
  });

  const bal4 = await fetchBalance();
  assert(bal4 === 250, `Balance after -100 adjustment: 250 (got ${bal4})`);

  // ──────────────────────────────────
  // 5. Multiple rapid fetches → always same correct value (no stale cache)
  // ──────────────────────────────────
  console.log('\n5. Multiple rapid fetches → always consistent');
  const results = await Promise.all([fetchBalance(), fetchBalance(), fetchBalance()]);
  assert(results.every(b => b === 250), `3 parallel fetches all return 250: [${results}]`);

  // ──────────────────────────────────
  // 6. No balance column, no cache in code
  // ──────────────────────────────────
  console.log('\n6. No stored balance, no cache');

  // No balance column in DB
  const balCol = await prisma.$queryRaw<any[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name ILIKE '%balance%'
  `;
  assert(balCol.length === 0, `No "balance" column in any table (${balCol.length})`);

  // API always calls getAccountBalance which does SUM
  const ledgerSrc = fs.readFileSync('/home/loyalty-platform/src/services/ledger.ts', 'utf-8');
  assert(ledgerSrc.includes('SUM(CASE WHEN entry_type'), 'getAccountBalance runs SUM on every call');

  // No cache mechanism
  assert(!ledgerSrc.includes('cache'), 'No cache in ledger service');

  // Frontend fetches fresh on load
  const pageSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx', 'utf-8');
  assert(pageSrc.includes('api.getBalance()'), 'Frontend calls getBalance() on load');
  assert(pageSrc.includes('api.getHistory()'), 'Frontend calls getHistory() on load');

  await app.close();
  console.log(`\n=== LIVE BALANCE: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
