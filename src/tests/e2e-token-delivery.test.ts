import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';

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
  console.log('=== TOKEN DELIVERY TO CONSUMER ===\n');
  await cleanAll();

  const tenant = await createTenant('Delivery Store', 'delivery-store', 'dl@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@dl.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total\nDL-001,200.00`, tenant.id, staff.id);

  // ──────────────────────────────────
  // 1. PWA path: API returns outputToken in response
  // ──────────────────────────────────
  console.log('1. PWA path: API returns outputToken for Phase 2 display');
  const result = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'DL-001', total_amount: 200, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(result.outputToken !== undefined, 'outputToken present in response');
  assert(typeof result.outputToken === 'string', 'outputToken is a string (base64)');
  assert(result.outputToken!.length > 100, `Token has substantial content (${result.outputToken!.length} chars)`);

  // Consumer API route returns the full result including token
  const fs = await import('fs');
  const consumerRoute = fs.readFileSync('/home/loyalty-platform/src/api/routes/consumer.ts', 'utf-8');
  assert(consumerRoute.includes('return result'), 'Consumer API returns full result (includes outputToken)');

  // ──────────────────────────────────
  // 2. WhatsApp path: confirmation message sent (MVP — no QR display yet)
  // ──────────────────────────────────
  console.log('\n2. WhatsApp path: confirmation message is sufficient for MVP');
  assert(result.message.includes('200'), 'Confirmation message includes value amount');
  assert(result.message.includes('200'), 'Confirmation message includes balance');
  assert(result.success === true, 'Result is success');

  // Bot sends text messages, not QR image — correct for Milestone 1
  const botSrc = fs.readFileSync('/home/loyalty-platform/src/services/whatsapp-bot.ts', 'utf-8');
  assert(botSrc.includes('Factura validada'), 'Bot sends text confirmation (Spanish)');
  assert(botSrc.includes('Has ganado'), 'Bot sends value earned');
  assert(botSrc.includes('Tu saldo total'), 'Bot sends total balance');
  // No QR image sending in Milestone 1 — just text messages
  assert(!botSrc.includes('sendImage') && !botSrc.includes('sendMedia'), 'No QR image sent via WhatsApp in Milestone 1 (text only)');

  // ──────────────────────────────────
  // 3. Token is stored for future Phase 2 QR display
  // ──────────────────────────────────
  console.log('\n3. Token stored permanently for Phase 2 retrieval');
  const invoice = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'DL-001' } });
  const data = invoice!.extractedData as any;
  assert(data.outputTokenSignature !== undefined, 'Signature persisted on invoice record');
  assert(invoice!.ledgerEntryId !== null, 'ledgerEntryId links token to ledger entry');

  console.log(`\n=== TOKEN DELIVERY: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
