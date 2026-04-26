import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { verifyOutputToken } from '../services/qr-token.js';

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
  console.log('=== INPUT (INVOICE) → LEDGER → OUTPUT (TOKEN) ===\n');
  await cleanAll();

  const tenant = await createTenant('IO Store', 'io-store', 'io@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@io.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total\nIO-001,400.00`, tenant.id, staff.id);

  const result = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'IO-001', total_amount: 400, transaction_date: '2024-03-01',
      customer_phone: null, merchant_name: 'IO Store', confidence_score: 0.95 },
  });

  // ──────────────────────────────────
  // INPUT SIDE: The invoice
  // ──────────────────────────────────
  console.log('INPUT: Invoice (the entry into the ledger)');
  const invoice = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: 'IO-001' },
  });

  assert(invoice !== null, 'Invoice record exists');
  assert(invoice!.status === 'claimed', 'Invoice status: claimed');
  assert(invoice!.invoiceNumber === 'IO-001', 'Invoice number recorded');
  assert(Number(invoice!.amount) === 400, 'Invoice amount recorded');
  assert(invoice!.source === 'csv_upload', 'Source recorded (csv_upload)');
  assert(invoice!.ledgerEntryId !== null, 'Invoice links to ledger entry');
  assert(invoice!.consumerAccountId !== null, 'Invoice links to consumer account');

  // ──────────────────────────────────
  // LEDGER: The immutable record connecting both ends
  // ──────────────────────────────────
  console.log('\nLEDGER: The immutable record (connects input and output)');
  const entries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: 'IO-001' },
  });

  assert(entries.length === 2, '2 ledger entries (double-entry)');
  const creditEntry = entries.find(e => e.entryType === 'CREDIT')!;

  assert(creditEntry.referenceId === 'IO-001', 'Ledger references the invoice number (input side)');
  assert(creditEntry.referenceType === 'invoice', 'Reference type: invoice');
  assert(creditEntry.eventType === 'INVOICE_CLAIMED', 'Event: INVOICE_CLAIMED');
  assert(creditEntry.id === invoice!.ledgerEntryId, 'Invoice.ledgerEntryId matches the CREDIT entry');

  // ──────────────────────────────────
  // OUTPUT SIDE: The QR token
  // ──────────────────────────────────
  console.log('\nOUTPUT: QR token (the certified output from the ledger)');

  assert(result.outputToken !== undefined, 'Token generated');
  const v = verifyOutputToken(result.outputToken!);
  assert(v.valid === true, 'Token is cryptographically valid');
  assert(v.payload!.ledgerEntryId === creditEntry.id, 'Token.ledgerEntryId matches the CREDIT entry');
  assert(v.payload!.valueAssigned === '400.00000000', 'Token records the value assigned');

  // Token signature stored on the invoice record
  const storedSig = (invoice!.extractedData as any)?.outputTokenSignature;
  assert(storedSig !== undefined, 'Token signature permanently stored on invoice');
  assert(storedSig.length === 64, 'Signature is 64 hex chars (HMAC-SHA256)');

  // ──────────────────────────────────
  // BOTH ENDS CONNECTED VIA THE LEDGER
  // ──────────────────────────────────
  console.log('\nBOTH ENDS: Invoice → Ledger Entry ← Token');

  // Input → Ledger
  assert(invoice!.ledgerEntryId === creditEntry.id, 'Invoice → ledgerEntryId → CREDIT entry');
  // Output → Ledger
  assert(v.payload!.ledgerEntryId === creditEntry.id, 'Token → ledgerEntryId → same CREDIT entry');
  // Both reference the same ledger entry
  assert(invoice!.ledgerEntryId === v.payload!.ledgerEntryId, 'Invoice and Token point to the SAME ledger entry');

  // The ledger entry is immutable — this connection is permanent
  try {
    await prisma.$executeRaw`UPDATE ledger_entries SET amount = 999 WHERE id = ${creditEntry.id}::uuid`;
    assert(false, 'Should be blocked');
  } catch {
    assert(true, 'Ledger entry is immutable — both ends permanently connected');
  }

  console.log(`\n=== INPUT/OUTPUT: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
