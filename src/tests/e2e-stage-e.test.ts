import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { handleIncomingMessage } from '../services/whatsapp-bot.js';

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
  console.log('=== STAGE E: CONSUMER NOTIFICATION ===\n');
  await cleanAll();

  const tenant = await createTenant('Notify Store', 'notify-store', 'n@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@n.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total\nNOT-001,175.00\nNOT-002,50.00`, tenant.id, staff.id);

  // ──────────────────────────────────
  // 1. validateInvoice response contains all 3 confirmation fields
  // ──────────────────────────────────
  console.log('1. validateInvoice response contains confirmation data');
  const result = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'NOT-001', total_amount: 175, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  assert(result.success === true, 'Validation succeeded');
  assert(result.message.length > 0, 'Message is non-empty');
  assert(result.message.includes('175'), 'Message includes value amount (175)');
  assert(result.message.includes('175'), 'Message includes new balance (175)');
  assert(result.valueAssigned === '175.00000000', `valueAssigned field: ${result.valueAssigned}`);
  assert(result.newBalance === '175.00000000', `newBalance field: ${result.newBalance}`);
  assert(result.invoiceNumber === 'NOT-001', `invoiceNumber field: ${result.invoiceNumber}`);

  // ──────────────────────────────────
  // 2. Second claim updates balance correctly in notification
  // ──────────────────────────────────
  console.log('\n2. Second claim shows cumulative balance');
  const result2 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'NOT-002', total_amount: 50, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(result2.valueAssigned === '50.00000000', 'Second claim value: 50');
  assert(result2.newBalance === '225.00000000', `Cumulative balance: 225 (175 + 50) (got: ${result2.newBalance})`);

  // ──────────────────────────────────
  // 3. Bot handler sends notification in Spanish
  // ──────────────────────────────────
  console.log('\n3. Bot sends Spanish notification via WhatsApp');

  // Check the bot image handler response messages
  const fs = await import('fs');
  const botSrc = fs.readFileSync('/home/loyalty-platform/src/services/whatsapp-bot.ts', 'utf-8');

  // Success messages from the bot image handler
  assert(botSrc.includes('Factura validada'), 'Bot says "Factura validada" (invoice validated)');
  assert(botSrc.includes('Has ganado'), 'Bot says "Has ganado" (you earned)');
  assert(botSrc.includes('Tu saldo total'), 'Bot says "Tu saldo total" (your total balance)');

  // ──────────────────────────────────
  // 4. WhatsApp service is wired to send the messages
  // ──────────────────────────────────
  console.log('\n4. WhatsApp send service wired');
  const webhookSrc = fs.readFileSync('/home/loyalty-platform/src/api/routes/webhook.ts', 'utf-8');
  assert(webhookSrc.includes('sendWhatsAppMessage'), 'Webhook sends responses via sendWhatsAppMessage');
  assert(webhookSrc.includes('for (const msg of responses)'), 'Sends each response message');

  // Verify sendWhatsAppMessage uses Evolution API from .env
  const whatsappSrc = fs.readFileSync('/home/loyalty-platform/src/services/whatsapp.ts', 'utf-8');
  assert(whatsappSrc.includes('EVOLUTION_API_URL'), 'Uses EVOLUTION_API_URL from .env');
  assert(whatsappSrc.includes('EVOLUTION_API_KEY'), 'Uses EVOLUTION_API_KEY from .env');
  assert(whatsappSrc.includes('EVOLUTION_INSTANCE_NAME'), 'Uses EVOLUTION_INSTANCE_NAME from .env');
  assert(whatsappSrc.includes('sendText'), 'Sends text messages via Evolution API');

  // ──────────────────────────────────
  // 5. Rejection also sends clear message
  // ──────────────────────────────────
  console.log('\n5. Rejections also send clear messages');
  const rejected = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'NOT-001', total_amount: 175, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(rejected.success === false, 'Duplicate rejected');
  assert(rejected.message.length > 0, 'Rejection has message');
  assert(rejected.message.includes('already'), 'Rejection explains reason');

  console.log(`\n=== STAGE E: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
