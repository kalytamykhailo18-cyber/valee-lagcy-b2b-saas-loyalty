import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { detectConversationState, getStateGreeting, detectSupportIntent, handleSupportIntent, handleIncomingMessage } from '../services/whatsapp-bot.js';
import { getAccountBalance } from '../services/ledger.js';

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
  console.log('=== STEP 4.1: AGENTIC WHATSAPP BOT — DEEP E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Bot Store', 'bot-store', 'bt@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@bt.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total\nBOT-001,200.00`, tenant.id, staff.id);

  // ──────────────────────────────────
  // STATE 1: First-time contact
  // ──────────────────────────────────
  console.log('State 1: First-time contact (no account)');
  const s1 = await detectConversationState('+58412NEW001', tenant.id);
  assert(s1.state === 'first_time', `Detected: ${s1.state}`);

  const g1 = getStateGreeting('first_time', 'Bot Store', '0', '+58412NEW001');
  assert(g1.length >= 3, `${g1.length} messages (welcoming, educational)`);
  assert(g1.some(m => m.includes('Bienvenido')), 'Welcoming tone');
  assert(g1.some(m => m.includes('factura')), 'Instructions to send receipt');
  assert(g1.some(m => m.includes('puntos') || m.includes('bienvenida')), 'Mentions points/bonus');
  assert(g1.some(m => m.includes('valee.app')), 'Includes PWA link');

  // Full handler creates account + welcome bonus
  const msgs1 = await handleIncomingMessage({ phoneNumber: '+58412NEW001', tenantId: tenant.id, messageType: 'text', messageText: 'hola' });
  assert(msgs1.length >= 3, 'Multiple welcome messages sent');
  const acc1 = await prisma.account.findUnique({ where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412NEW001' } } });
  assert(acc1 !== null, 'Shadow account created');
  assert(acc1!.welcomeBonusGranted === true, 'Welcome bonus granted');

  // ──────────────────────────────────
  // STATE 2: Returning user with history
  // ──────────────────────────────────
  console.log('\nState 2: Returning user with history');
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412RET001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'BOT-001', total_amount: 200, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  // Backdate so it's not "active purchase" (>60 min ago)
  const retAcc = await prisma.account.findUnique({ where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412RET001' } } });
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_update`;
  await prisma.$executeRaw`UPDATE ledger_entries SET created_at = NOW() - INTERVAL '2 hours' WHERE account_id = ${retAcc!.id}::uuid`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_update`;

  const s2 = await detectConversationState('+58412RET001', tenant.id);
  assert(s2.state === 'returning_with_history', `Detected: ${s2.state}`);

  const g2 = getStateGreeting('returning_with_history', 'Bot Store', '200', '+58412RET001');
  assert(g2.some(m => m.includes('Hola de nuevo') || m.includes('saldo')), 'Familiar greeting with balance');
  assert(g2.some(m => m.includes('200')), 'Shows current balance');

  // ──────────────────────────────────
  // STATE 3: Active purchase context (<60 min)
  // ──────────────────────────────────
  console.log('\nState 3: Active purchase context');
  // Create a consumer with recent activity (not backdated)
  await processCSV(`invoice_number,total\nBOT-002,100.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412ACT001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'BOT-002', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const s3 = await detectConversationState('+58412ACT001', tenant.id);
  assert(s3.state === 'active_purchase', `Detected: ${s3.state}`);

  const g3 = getStateGreeting('active_purchase', 'Bot Store', '100', '+58412ACT001');
  assert(g3.some(m => m.includes('Acabas de visitar') || m.includes('Bot Store')), 'Acknowledges active context');

  // ──────────────────────────────────
  // STATE 4: Registered but never scanned
  // ──────────────────────────────────
  console.log('\nState 4: Registered, never scanned');
  await findOrCreateConsumerAccount(tenant.id, '+58412NEVER01');

  const s4 = await detectConversationState('+58412NEVER01', tenant.id);
  assert(s4.state === 'registered_never_scanned', `Detected: ${s4.state}`);

  const g4 = getStateGreeting('registered_never_scanned', 'Bot Store', '0', '+58412NEVER01');
  assert(g4.some(m => m.includes('no has ganado')), 'Re-educates user');
  assert(g4.some(m => m.includes('factura')), 'Explains how to earn');

  // ──────────────────────────────────
  // 5 SUPPORT INTENTS
  // ──────────────────────────────────
  console.log('\nSupport intents');

  // 1. Balance query
  assert(detectSupportIntent('cual es mi saldo') === 'balance_query', 'Intent: balance_query');
  const balResp = await handleSupportIntent('balance_query', '+58412RET001', tenant.id, retAcc!.id);
  assert(balResp[0].includes('200'), 'Balance response shows amount');

  // 2. Receipt status
  assert(detectSupportIntent('que paso con mi factura') === 'receipt_status', 'Intent: receipt_status');
  const recResp = await handleSupportIntent('receipt_status', '+58412RET001', tenant.id, retAcc!.id);
  assert(recResp.some(m => m.includes('BOT-001') || m.includes('factura')), 'Shows receipt info');

  // 3. How to redeem
  assert(detectSupportIntent('quiero canjear mis puntos') === 'how_to_redeem', 'Intent: how_to_redeem');
  const redResp = await handleSupportIntent('how_to_redeem', '+58412RET001', tenant.id, retAcc!.id);
  assert(redResp.length >= 3, 'Step-by-step redeem instructions');

  // 4. Report problem
  assert(detectSupportIntent('tengo un problema con mi compra') === 'report_problem', 'Intent: report_problem');
  const probResp = await handleSupportIntent('report_problem', '+58412RET001', tenant.id, retAcc!.id);
  assert(probResp.some(m => m.includes('Lamentamos') || m.includes('problema')), 'Empathetic response');

  // 5. Unknown → fallback
  assert(detectSupportIntent('xyzzy random gibberish') === 'unknown', 'Intent: unknown');
  const unkResp = await handleSupportIntent('unknown', '+58412RET001', tenant.id, retAcc!.id);
  assert(unkResp.some(m => m.includes('No entendí') || m.includes('opciones')), 'Fallback lists options');
  assert(unkResp.some(m => m.includes('saldo')), 'Fallback mentions balance option');
  assert(unkResp.some(m => m.includes('factura')), 'Fallback mentions receipt option');
  assert(unkResp.some(m => m.includes('canjear')), 'Fallback mentions redeem option');

  // ──────────────────────────────────
  // ALL MESSAGES IN SPANISH
  // ──────────────────────────────────
  console.log('\nAll messages in Spanish');
  const allMessages = [...g1, ...g2, ...g3, ...g4, ...balResp, ...recResp, ...redResp, ...probResp, ...unkResp];
  // Check no English-only messages
  // At least 90% of messages should contain Spanish words (some may be emoji-only or short)
  const spanishCount = allMessages.filter(m =>
    /[áéíóúñ¿¡]|Hola|Bienvenido|factura|puntos|saldo|canjear|comercio|Lamentamos|entend|opciones|problema|tu|que|por|para|con|del/.test(m)
  ).length;
  assert(spanishCount >= allMessages.length * 0.9, `${spanishCount}/${allMessages.length} messages in Spanish`);

  console.log(`\n=== STEP 4.1: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
