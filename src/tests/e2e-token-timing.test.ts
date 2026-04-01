import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { verifyOutputToken, verifyAndResolveLedgerEntry } from '../services/qr-token.js';
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
  console.log('=== TOKEN TIMING + PERMANENT ATTACHMENT ===\n');
  await cleanAll();

  const tenant = await createTenant('Timing Store', 'timing-store', 'tm@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@tm.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total\nTIME-001,100.00`, tenant.id, staff.id);

  // ──────────────────────────────────
  // 1. Code ordering: token generated IMMEDIATELY after writeDoubleEntry
  // ──────────────────────────────────
  console.log('1. Code ordering: token generated immediately after INVOICE_CLAIMED');
  const src = fs.readFileSync('/home/loyalty-platform/src/services/invoice-validation.ts', 'utf-8');

  // Find the positions of key operations
  const writeDoubleEntryPos = src.indexOf("writeDoubleEntry({");
  const invoiceClaimedPos = src.indexOf("'INVOICE_CLAIMED'", writeDoubleEntryPos);
  const invoiceUpdatePos = src.indexOf("status: 'claimed'", invoiceClaimedPos);
  const generateTokenPos = src.indexOf("generateOutputToken(", invoiceUpdatePos);
  const storeTokenPos = src.indexOf("outputTokenSignature", generateTokenPos);
  const getBalancePos = src.indexOf("getAccountBalance(", storeTokenPos);

  assert(writeDoubleEntryPos > 0, 'writeDoubleEntry call exists');
  assert(invoiceClaimedPos > writeDoubleEntryPos, 'INVOICE_CLAIMED event type set');
  assert(invoiceUpdatePos > invoiceClaimedPos, 'Invoice marked claimed after ledger write');
  assert(generateTokenPos > invoiceUpdatePos, 'generateOutputToken called after invoice claimed');
  assert(storeTokenPos > generateTokenPos, 'Token signature stored after generation');
  assert(getBalancePos > storeTokenPos, 'Balance computed after token stored');

  console.log('  Order: writeDoubleEntry → invoice.claimed → generateOutputToken → store signature → getAccountBalance');

  // ──────────────────────────────────
  // 2. Token is permanently stored — survives across queries
  // ──────────────────────────────────
  console.log('\n2. Token permanently stored on invoice record');
  const result = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'TIME-001', total_amount: 100, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  // Read the invoice fresh from DB
  const invoice = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: 'TIME-001' },
  });
  const storedData = invoice!.extractedData as any;
  assert(storedData.outputTokenSignature !== undefined, 'Token signature persisted in DB');
  assert(storedData.outputTokenSignature.length === 64, `64 hex chars (got ${storedData.outputTokenSignature.length})`);

  // ──────────────────────────────────
  // 3. Token linked to the ledger entry — retrievable later
  // ──────────────────────────────────
  console.log('\n3. Token linked to ledger entry — retrievable anytime');

  // The token payload contains ledgerEntryId
  const v = verifyOutputToken(result.outputToken!);
  const ledgerEntryId = v.payload!.ledgerEntryId;

  // Invoice record also links to the same ledger entry
  assert(invoice!.ledgerEntryId === ledgerEntryId, `Invoice.ledgerEntryId matches token.ledgerEntryId`);

  // Can resolve the token to the ledger entry at any time
  const resolved = await verifyAndResolveLedgerEntry(result.outputToken!);
  assert(resolved.valid === true, 'Token resolves to ledger entry');
  assert(resolved.ledgerEntry!.id === ledgerEntryId, 'Same ledger entry');

  // ──────────────────────────────────
  // 4. Attachment is permanent — ledger entry immutable, invoice token persists
  // ──────────────────────────────────
  console.log('\n4. Attachment is permanent');

  // Ledger entry cannot be modified (trigger blocks it)
  try {
    await prisma.$executeRaw`UPDATE ledger_entries SET amount = 999 WHERE id = ${ledgerEntryId}::uuid`;
    assert(false, 'Ledger UPDATE should be blocked');
  } catch (err: any) {
    assert(err.message.includes('immutable'), 'Ledger entry is immutable — token reference is permanent');
  }

  // Invoice token field persists
  const invoiceAgain = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: 'TIME-001' },
  });
  assert((invoiceAgain!.extractedData as any).outputTokenSignature === storedData.outputTokenSignature,
    'Token signature unchanged on re-read (permanent)');

  // Token still valid after re-read
  const resolved2 = await verifyAndResolveLedgerEntry(result.outputToken!);
  assert(resolved2.valid === true, 'Token still resolves after re-read');

  console.log(`\n=== TOKEN TIMING: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
