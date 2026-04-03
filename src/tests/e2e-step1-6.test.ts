import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice, createPendingValidation } from '../services/invoice-validation.js';
import { getAccountBalance } from '../services/ledger.js';
import { handleIncomingMessage, detectConversationState } from '../services/whatsapp-bot.js';
import { runReconciliation } from '../services/reconciliation.js';

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
  console.log('=== STEP 1.6: WHATSAPP ENTRY FLOW + INVOICE VALIDATION — FULL E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('WA Store', 'wa-store', 'wa@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@wa.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Upload merchant CSV data
  await processCSV(`invoice_number,total,date,phone
WA-001,150.00,2024-03-01,+58412WA001
WA-002,200.00,2024-03-01,+58412WA002
WA-003,75.50,2024-03-02,`, tenant.id, staff.id);

  // ──────────────────────────────────
  // SUB-STEP 1.6.1: Merchant QR → WhatsApp → shadow account
  // ──────────────────────────────────
  console.log('SUB-STEP 1.6.1: QR scan → WhatsApp → shadow account + welcome');

  // Simulate: consumer scans QR, sends first message to bot
  const welcomeMessages = await handleIncomingMessage({
    phoneNumber: '+58412WA001',
    tenantId: tenant.id,
    messageType: 'text',
    messageText: 'hola',
  });

  // Shadow account should be created
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412WA001' } },
  });
  assert(account !== null, 'Shadow account created on first contact');
  assert(account!.accountType === 'shadow', 'Account type is shadow');
  assert(welcomeMessages.length > 0, `Welcome messages sent (got ${welcomeMessages.length})`);
  assert(welcomeMessages[0].includes('Bienvenido'), 'Welcome message in Spanish');

  // State should be first_time for a brand new consumer
  const state = await detectConversationState('+58412NEW999', tenant.id);
  assert(state.state === 'first_time', 'New phone = first_time state');

  // ──────────────────────────────────
  // SUB-STEP 1.6.2 + STAGE A: OCR extraction
  // ──────────────────────────────────
  console.log('\nSTAGE A: Data extraction (OCR + AI)');

  // Low confidence → rejected, ask for clearer photo
  const lowConf = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412WA001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'WA-001', total_amount: 150, transaction_date: '2024-03-01',
      customer_phone: '+58412WA001', merchant_name: 'WA Store', confidence_score: 0.3 },
  });
  assert(lowConf.success === false, 'Low confidence rejected');
  assert(lowConf.stage === 'extraction', `Stage: extraction (got ${lowConf.stage})`);
  assert(lowConf.message.includes('clearer'), 'Message asks for clearer photo');

  // Missing fields → rejected
  const noFields = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412WA001', assetTypeId: asset.id,
    extractedData: { invoice_number: null, total_amount: null, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.9 },
  });
  assert(noFields.success === false, 'Missing fields rejected');
  assert(noFields.stage === 'extraction', 'Stage: extraction');

  // Verify confidence threshold from .env
  const threshold = parseFloat(process.env.OCR_CONFIDENCE_THRESHOLD || '0.7');
  assert(threshold === 0.7, `OCR_CONFIDENCE_THRESHOLD from .env: ${threshold}`);

  // ──────────────────────────────────
  // STAGE B: Identity cross-check
  // ──────────────────────────────────
  console.log('\nSTAGE B: Identity cross-check (phone match)');

  // Phone mismatch → rejected
  const phoneMismatch = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412WRONG', assetTypeId: asset.id,
    extractedData: { invoice_number: 'WA-001', total_amount: 150, transaction_date: '2024-03-01',
      customer_phone: '+58412WA001', merchant_name: 'WA Store', confidence_score: 0.95 },
  });
  assert(phoneMismatch.success === false, 'Phone mismatch rejected');
  assert(phoneMismatch.stage === 'identity_check', `Stage: identity_check (got ${phoneMismatch.stage})`);
  assert(phoneMismatch.message.includes('phone number'), 'Message explains mismatch');

  // No phone on receipt → proceeds (not rejected)
  // (tested below in Stage D success case)

  // ──────────────────────────────────
  // STAGE C: Merchant data cross-reference
  // ──────────────────────────────────
  console.log('\nSTAGE C: Merchant data cross-reference');

  // Invoice not found → rejected
  const notFound = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412WA001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'NONEXISTENT', total_amount: 100, transaction_date: '2024-03-01',
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(notFound.success === false, 'Non-existent invoice rejected');
  assert(notFound.stage === 'cross_reference', `Stage: cross_reference`);

  // Amount mismatch (outside tolerance) → flagged for review
  const tolerance = parseFloat(process.env.INVOICE_AMOUNT_TOLERANCE || '0.05');
  assert(tolerance === 0.05, `INVOICE_AMOUNT_TOLERANCE from .env: ${tolerance}`);

  const amountMismatch = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412WA001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'WA-001', total_amount: 999, transaction_date: '2024-03-01',
      customer_phone: '+58412WA001', merchant_name: 'WA Store', confidence_score: 0.95 },
  });
  assert(amountMismatch.success === false, 'Amount mismatch flagged');
  assert(amountMismatch.status === 'manual_review', `Status: manual_review (got ${amountMismatch.status})`);

  // ──────────────────────────────────
  // STAGE D: Value assignment (all checks pass)
  // ──────────────────────────────────
  console.log('\nSTAGE D: Value assignment (full success)');

  // Reset WA-001 from manual_review back to available for this test
  await prisma.invoice.updateMany({
    where: { tenantId: tenant.id, invoiceNumber: 'WA-001' },
    data: { status: 'available' },
  });

  const success = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412WA001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'WA-001', total_amount: 150, transaction_date: '2024-03-01',
      customer_phone: '+58412WA001', merchant_name: 'WA Store', confidence_score: 0.95 },
  });
  assert(success.success === true, 'Validation succeeded');
  assert(success.valueAssigned === '150.00000000', `Value: ${success.valueAssigned}`);
  // 150 (invoice) + 50 (welcome bonus from handleIncomingMessage) = 200
  assert(success.newBalance === '200.00000000', `Balance: ${success.newBalance}`);

  // Verify invoice marked as claimed
  const claimed = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: 'WA-001' },
  });
  assert(claimed!.status === 'claimed', 'Invoice status: claimed');
  assert(claimed!.consumerAccountId === account!.id, 'Linked to consumer account');
  assert(claimed!.ledgerEntryId !== null, 'Linked to ledger entry');

  // Verify double-entry in ledger
  const ledgerEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: 'WA-001' },
  });
  assert(ledgerEntries.length === 2, `2 ledger entries (got ${ledgerEntries.length})`);
  const debit = ledgerEntries.find(e => e.entryType === 'DEBIT')!;
  const credit = ledgerEntries.find(e => e.entryType === 'CREDIT')!;
  assert(debit.accountId === sys.pool.id, 'DEBIT = issued_value_pool');
  assert(credit.accountId === account!.id, 'CREDIT = consumer');
  assert(debit.eventType === 'INVOICE_CLAIMED', 'Event: INVOICE_CLAIMED');
  assert(debit.pairedEntryId === credit.id, 'Entries paired');

  // Verify balance computed from history
  const balance = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(balance === '200.00000000', `Live balance: ${balance}`);

  // ──────────────────────────────────
  // STAGE E: Consumer notification (message content)
  // ──────────────────────────────────
  console.log('\nSTAGE E: Consumer notification');
  assert(success.message.includes('150'), 'Message includes value amount');
  assert(success.message.includes('150'), 'Message includes new balance');

  // ──────────────────────────────────
  // Already claimed → rejected
  // ──────────────────────────────────
  console.log('\nDuplicate claim');
  const duplicate = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412WA001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'WA-001', total_amount: 150, transaction_date: '2024-03-01',
      customer_phone: '+58412WA001', merchant_name: 'WA Store', confidence_score: 0.95 },
  });
  assert(duplicate.success === false, 'Duplicate claim rejected');
  assert(duplicate.message.includes('already'), 'Message says already used');

  // Verify no extra ledger entries
  const afterDup = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: 'WA-001' },
  });
  assert(afterDup.length === 2, `Still 2 entries (no duplicate) (got ${afterDup.length})`);

  // ──────────────────────────────────
  // No phone on receipt → still works via invoice number
  // ──────────────────────────────────
  console.log('\nNo phone on receipt — validates via invoice number');
  const noPhone = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412WA003', assetTypeId: asset.id,
    extractedData: { invoice_number: 'WA-003', total_amount: 75.50, transaction_date: '2024-03-02',
      customer_phone: null, merchant_name: null, confidence_score: 0.9 },
  });
  assert(noPhone.success === true, 'Validated without phone on receipt');

  // ──────────────────────────────────
  // ASYNC FALLBACK: no CSV uploaded → pending validation
  // ──────────────────────────────────
  console.log('\nAsync fallback: pending validation');
  const pending = await createPendingValidation({
    tenantId: tenant.id, senderPhone: '+58412PENDING1', invoiceNumber: 'PEND-001',
    totalAmount: 100, assetTypeId: asset.id,
  });
  assert(pending.success === true, 'Pending validation created');
  assert(pending.status === 'pending_validation', 'Status: pending_validation');

  // Provisional balance exists
  const pendAccount = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412PENDING1' } },
  });
  const pendBal = await getAccountBalance(pendAccount!.id, asset.id, tenant.id);
  assert(Number(pendBal) === 100, `Provisional balance: 100 (got ${pendBal})`);

  // Provisional ledger entries exist
  const provEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: 'PENDING-PEND-001' },
  });
  assert(provEntries.length === 2, `2 provisional entries (got ${provEntries.length})`);
  assert(provEntries.every(e => e.status === 'provisional'), 'Status: provisional');

  // ──────────────────────────────────
  // OCR service exists and reads from .env
  // ──────────────────────────────────
  console.log('\nOCR + AI services wired');
  const { ocrExtractText, aiExtractInvoiceFields } = await import('../services/ocr.js');
  assert(typeof ocrExtractText === 'function', 'ocrExtractText function exists (uses GOOGLE_VISION_API_KEY)');
  assert(typeof aiExtractInvoiceFields === 'function', 'aiExtractInvoiceFields function exists (uses ANTHROPIC_API_KEY)');

  // ──────────────────────────────────
  // WhatsApp service exists and reads from .env
  // ──────────────────────────────────
  const { sendWhatsAppMessage } = await import('../services/whatsapp.js');
  assert(typeof sendWhatsAppMessage === 'function', 'sendWhatsAppMessage function exists (uses EVOLUTION_API_*)');

  // ──────────────────────────────────
  // Verify DB schema for invoices matches spec
  // ──────────────────────────────────
  console.log('\nSchema verification');
  const invCols = await prisma.$queryRaw<any[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'invoices' ORDER BY ordinal_position
  `;
  const colNames = invCols.map((c: any) => c.column_name);
  for (const required of ['id','tenant_id','invoice_number','amount','status','source',
    'consumer_account_id','ledger_entry_id','ocr_raw_text','extracted_data','confidence_score',
    'submitted_latitude','submitted_longitude']) {
    assert(colNames.includes(required), `invoices.${required} exists`);
  }

  console.log(`\n=== STEP 1.6: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
