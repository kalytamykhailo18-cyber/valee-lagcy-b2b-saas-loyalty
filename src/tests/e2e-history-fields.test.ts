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
import { initiateRedemption, processRedemption } from '../services/redemption.js';
import { writeDoubleEntry } from '../services/ledger.js';
import { issueConsumerTokens, issueStaffTokens } from '../services/auth.js';
import consumerRoutes from '../api/routes/consumer.js';
import merchantRoutes from '../api/routes/merchant.js';
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
  console.log('=== TRANSACTION HISTORY ENTRY FIELDS ===\n');
  await cleanAll();

  const tenant = await createTenant('History Store', 'history-store', 'hs@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@hs.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Create multiple event types in history
  await processCSV(`invoice_number,total\nHF-001,300.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'HF-001', total_amount: 300, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

  // Create a redemption
  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Prize', redemptionCost: '50.00000000', assetTypeId: asset.id, stock: 5, active: true, minLevel: 1 },
  });
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  await processRedemption({ token: redemption.token!, cashierStaffId: staff.id, cashierTenantId: tenant.id });

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

  // Fetch history
  const res = await fetch(`${base}/api/consumer/history`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json() as any;

  assert(res.ok, 'History endpoint returns 200');
  assert(data.entries.length >= 3, `Multiple event types in history (${data.entries.length} entries)`);

  console.log('\nAll history entries:');
  for (const e of data.entries) {
    console.log(`  ${e.entryType === 'CREDIT' ? '+' : '-'}${e.amount} | ${e.eventType} | ${new Date(e.createdAt).toLocaleString('es-VE')} | ${e.merchantName || 'N/A'}`);
  }

  // ──────────────────────────────────
  // Verify each required field on every entry
  // ──────────────────────────────────
  console.log('\nField-by-field check on each entry:');

  for (const entry of data.entries) {
    // 1. Event type (human-readable in frontend)
    assert(typeof entry.eventType === 'string' && entry.eventType.length > 0,
      `eventType present: ${entry.eventType}`);

    // 2. Amount
    assert(typeof entry.amount === 'string' && parseFloat(entry.amount) > 0,
      `amount present: ${entry.amount}`);

    // 3. Credit (+) or Debit (-)
    assert(entry.entryType === 'CREDIT' || entry.entryType === 'DEBIT',
      `entryType is CREDIT or DEBIT: ${entry.entryType}`);

    // 4. Date and time
    assert(typeof entry.createdAt === 'string' && !isNaN(Date.parse(entry.createdAt)),
      `createdAt is valid datetime: ${entry.createdAt}`);

    // 5. Merchant name
    assert(entry.merchantName === 'History Store',
      `merchantName: ${entry.merchantName}`);
  }

  // ──────────────────────────────────
  // Verify frontend renders all 5 fields
  // ──────────────────────────────────
  console.log('\nFrontend rendering:');
  const pageSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx', 'utf-8');

  // 1. Event type → human-readable label
  assert(pageSrc.includes('EVENT_LABELS[entry.eventType]'), 'Renders event type with human-readable label');
  assert(pageSrc.includes("INVOICE_CLAIMED: 'Factura validada'"), 'INVOICE_CLAIMED → "Factura validada"');
  assert(pageSrc.includes("REDEMPTION_PENDING: 'Canje pendiente'"), 'REDEMPTION_PENDING → "Canje pendiente"');
  assert(pageSrc.includes("REDEMPTION_CONFIRMED: 'Canje procesado'"), 'REDEMPTION_CONFIRMED → "Canje procesado"');
  assert(pageSrc.includes("REDEMPTION_EXPIRED: 'Canje expirado'"), 'REDEMPTION_EXPIRED → "Canje expirado"');
  assert(pageSrc.includes("REVERSAL: 'Reverso'"), 'REVERSAL → "Reverso"');
  assert(pageSrc.includes("ADJUSTMENT_MANUAL: 'Ajuste manual'"), 'ADJUSTMENT_MANUAL → "Ajuste manual"');
  assert(pageSrc.includes("TRANSFER_P2P: 'Transferencia'"), 'TRANSFER_P2P → "Transferencia"');

  // 2. Amount
  assert(pageSrc.includes('parseFloat(entry.amount).toLocaleString()'), 'Amount formatted with locale');

  // 3. Credit/Debit direction
  assert(pageSrc.includes("'text-green-600'") && pageSrc.includes("'text-red-500'"), 'Green for credit, red for debit');
  assert(pageSrc.includes("'+' : '-'"), '+ prefix for credit, - for debit');

  // 4. Date/time
  assert(pageSrc.includes("toLocaleString('es-VE')"), 'Date formatted in Venezuelan locale');

  // 5. Merchant name
  assert(pageSrc.includes('entry.merchantName'), 'Merchant name rendered');

  await app.close();
  console.log(`\n=== HISTORY FIELDS: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
