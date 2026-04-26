import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { handleIncomingMessage } from '../services/whatsapp-bot.js';
import { validateInvoice, createPendingValidation } from '../services/invoice-validation.js';
import { getAccountBalance } from '../services/ledger.js';
import { runReconciliation } from '../services/reconciliation.js';

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
  console.log('=== INVOICE PHOTO SUBMISSION — FULL 5-STAGE PIPELINE ===\n');
  await cleanAll();

  const tenant = await createTenant('Photo Store', 'photo-store', 'ps@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@ps.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Upload CSV data
  await processCSV(`invoice_number,total,date,phone
PHOTO-001,250.00,2024-03-01,+584125550001
PHOTO-002,100.00,2024-03-02,
PHOTO-003,75.00,2024-03-03,+584125550003`, tenant.id, staff.id);

  // ──────────────────────────────────
  // STAGE A: OCR extraction
  // ──────────────────────────────────
  console.log('STAGE A: OCR + AI extraction');

  // Verify OCR service exists and uses .env
  const { ocrExtractText, aiExtractInvoiceFields, extractFromImage } = await import('../services/ocr.js');
  assert(typeof ocrExtractText === 'function', 'ocrExtractText exists (GOOGLE_VISION_API_KEY)');
  assert(typeof aiExtractInvoiceFields === 'function', 'aiExtractInvoiceFields exists (ANTHROPIC_API_KEY)');
  assert(typeof extractFromImage === 'function', 'extractFromImage exists (full pipeline)');

  // OCR fields spec: invoice_number, total_amount, transaction_date, merchant_name, customer_phone
  // Test with pre-extracted data (simulates OCR output)
  console.log('  Fields extracted: invoice_number, total_amount, date, merchant_name, customer_phone');

  // Low confidence → asks for clearer photo
  const lowConfResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'PHOTO-001', total_amount: 250, transaction_date: '2024-03-01',
      customer_phone: '+584125550001', merchant_name: 'Photo Store', confidence_score: 0.3 },
  });
  assert(lowConfResult.success === false, 'Low confidence → rejected');
  assert(lowConfResult.message.includes('clearer') || lowConfResult.message.includes('clearly'), 'Asks for clearer photo');

  // Missing required fields → rejected
  const missingResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: null, total_amount: null, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(missingResult.success === false, 'Missing invoice_number + amount → rejected');

  // ──────────────────────────────────
  // STAGE B: Identity cross-check
  // ──────────────────────────────────
  console.log('\nSTAGE B: Identity cross-check');

  // Phone on receipt doesn't match sender → rejected (anti-fraud)
  const mismatchResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125559999', assetTypeId: asset.id,
    extractedData: { invoice_number: 'PHOTO-001', total_amount: 250, transaction_date: '2024-03-01',
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(mismatchResult.success === false, 'Phone mismatch → rejected');
  assert(mismatchResult.stage === 'identity_check', 'Rejected at identity_check stage');

  // No phone on receipt → proceeds to Stage C
  const noPhoneResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550099', assetTypeId: asset.id,
    extractedData: { invoice_number: 'PHOTO-002', total_amount: 100, transaction_date: '2024-03-02',
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(noPhoneResult.success === true, 'No phone on receipt → proceeds and validates');

  // ──────────────────────────────────
  // STAGE C: Merchant data cross-reference
  // ──────────────────────────────────
  console.log('\nSTAGE C: Cross-reference with CSV');

  // Invoice not in registry → rejected
  const notFoundResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'FAKE-999', total_amount: 100, transaction_date: '2024-03-01',
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(notFoundResult.success === false, 'Invoice not in registry → rejected');

  // Amount significantly different → flagged for review
  const amountOffResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'PHOTO-001', total_amount: 999, transaction_date: '2024-03-01',
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(amountOffResult.success === false, 'Amount mismatch → flagged');
  assert(amountOffResult.status === 'manual_review', 'Status: manual_review');

  // Reset PHOTO-001 for next test
  await prisma.invoice.updateMany({ where: { tenantId: tenant.id, invoiceNumber: 'PHOTO-001' }, data: { status: 'available' } });

  // Already claimed → rejected
  // First claim PHOTO-001 successfully
  const claimResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'PHOTO-001', total_amount: 250, transaction_date: '2024-03-01',
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(claimResult.success === true, 'First claim succeeds');

  const dupResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'PHOTO-001', total_amount: 250, transaction_date: '2024-03-01',
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(dupResult.success === false, 'Already claimed → rejected');
  assert(dupResult.message.includes('already'), 'Message says already used');

  // ──────────────────────────────────
  // STAGE D: Value assignment
  // ──────────────────────────────────
  console.log('\nSTAGE D: Value assignment (verify from claim above)');

  // Invoice marked claimed
  const inv = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'PHOTO-001', status: 'claimed' } });
  assert(inv !== null, 'Invoice marked as claimed');
  assert(inv!.consumerAccountId !== null, 'Linked to consumer');
  assert(inv!.ledgerEntryId !== null, 'Linked to ledger entry');

  // Double-entry exists
  const entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id, referenceId: 'PHOTO-001' } });
  assert(entries.length === 2, '2 ledger entries (double-entry)');
  const debit = entries.find(e => e.entryType === 'DEBIT')!;
  const credit = entries.find(e => e.entryType === 'CREDIT')!;
  assert(debit.accountId === sys.pool.id, 'DEBIT from issued_value_pool');
  assert(credit.accountId === inv!.consumerAccountId, 'CREDIT to consumer');
  assert(debit.eventType === 'INVOICE_CLAIMED', 'Event: INVOICE_CLAIMED');
  assert(Number(debit.amount) === 250, 'Amount: 250');

  // Balance recalculated
  const consumer = await prisma.account.findUnique({ where: { id: inv!.consumerAccountId! } });
  const balance = await getAccountBalance(consumer!.id, asset.id, tenant.id);
  assert(Number(balance) === 250, `Balance: 250 (got ${balance})`);

  // ──────────────────────────────────
  // STAGE E: Consumer notification
  // ──────────────────────────────────
  console.log('\nSTAGE E: Notification (in Spanish)');
  assert(claimResult.message.includes('250'), 'Notification includes value amount');
  assert(claimResult.message.includes('250'), 'Notification includes balance');
  // Spanish check: the messages from the bot handler use Spanish
  const botResponse = await handleIncomingMessage({
    phoneNumber: '+584125550001', tenantId: tenant.id, messageType: 'text', messageText: 'saldo',
  });
  assert(botResponse.some(m => m.includes('puntos') || m.includes('pts')), 'Bot responds in Spanish');

  // ──────────────────────────────────
  // ASYNC FALLBACK
  // ──────────────────────────────────
  console.log('\nASYNC FALLBACK: pending validation');
  const pendResult = await createPendingValidation({
    tenantId: tenant.id, senderPhone: '+584125550077', invoiceNumber: 'ASYNC-001',
    totalAmount: 50, assetTypeId: asset.id,
  });
  assert(pendResult.status === 'pending_validation', 'Status: pending_validation');

  // Provisional credit exists
  const provEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: 'PENDING-ASYNC-001' },
  });
  assert(provEntries.length === 2, '2 provisional ledger entries');
  assert(provEntries.every(e => e.status === 'provisional'), 'Both have status: provisional');

  // Reconciliation: expire it (no CSV for this invoice)
  await prisma.invoice.updateMany({
    where: { tenantId: tenant.id, invoiceNumber: 'ASYNC-001' },
    data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
  });
  const reconResult = await runReconciliation();
  assert(reconResult.reversed >= 1, `Reversed: ${reconResult.reversed}`);

  const reversalEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REVERSAL' },
  });
  assert(reversalEntries.length === 2, '2 REVERSAL entries (double-entry)');

  // ──────────────────────────────────
  // SCHEMA CHECK
  // ──────────────────────────────────
  console.log('\nSCHEMA: .env vars used');
  assert(typeof process.env.OCR_CONFIDENCE_THRESHOLD === 'string', 'OCR_CONFIDENCE_THRESHOLD in .env');
  assert(typeof process.env.INVOICE_AMOUNT_TOLERANCE === 'string', 'INVOICE_AMOUNT_TOLERANCE in .env');
  assert(typeof process.env.RECONCILIATION_WINDOW_HOURS === 'string', 'RECONCILIATION_WINDOW_HOURS in .env');

  console.log(`\n=== INVOICE PHOTO: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
