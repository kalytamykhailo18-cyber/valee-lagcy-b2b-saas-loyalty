import dotenv from 'dotenv'; dotenv.config();
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
  console.log('=== TOKEN FIELD VERIFICATION (implement.md + CLAUDE.md) ===\n');
  await cleanAll();

  const tenant = await createTenant('Field Store', 'field-store', 'f@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@f.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total\nFLD-001,250.00`, tenant.id, staff.id);

  const result = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'FLD-001', total_amount: 250, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  assert(result.outputToken !== undefined, 'Token generated on validation');

  // Decode the raw token to inspect structure
  const decoded = JSON.parse(Buffer.from(result.outputToken!, 'base64').toString('utf-8'));

  console.log('Raw token structure:');
  console.log('  payload:', JSON.stringify(decoded.payload, null, 2));
  console.log('  signature:', decoded.signature.slice(0, 16) + '...');

  // ──────────────────────────────────
  // implement.md fields:
  // "the ledger entry ID, the consumer's account ID, the amount of value assigned,
  //  the timestamp, and a cryptographic signature"
  // ──────────────────────────────────
  console.log('\nimlement.md required fields:');
  assert(typeof decoded.payload.ledgerEntryId === 'string' && decoded.payload.ledgerEntryId.length === 36,
    `ledgerEntryId: UUID (${decoded.payload.ledgerEntryId.slice(0,8)}...)`);
  assert(typeof decoded.payload.consumerAccountId === 'string' && decoded.payload.consumerAccountId.length === 36,
    `consumerAccountId: UUID (${decoded.payload.consumerAccountId.slice(0,8)}...)`);
  assert(decoded.payload.valueAssigned === '250.00000000',
    `valueAssigned: ${decoded.payload.valueAssigned}`);
  assert(typeof decoded.payload.timestamp === 'string' && decoded.payload.timestamp.includes('T'),
    `timestamp: ISO format (${decoded.payload.timestamp})`);
  assert(typeof decoded.signature === 'string' && decoded.signature.length === 64,
    `signature: 64 hex chars HMAC-SHA256`);

  // ──────────────────────────────────
  // CLAUDE.md additional field:
  // "ledger entry ID, consumer account ID, value assigned, tenant ID, and timestamp"
  // ──────────────────────────────────
  console.log('\nCLAUDE.md additional field:');
  assert(decoded.payload.tenantId === tenant.id,
    `tenantId: ${decoded.payload.tenantId.slice(0,8)}... (matches tenant)`);

  // ──────────────────────────────────
  // Signature proves platform generated it
  // ──────────────────────────────────
  console.log('\nSignature verification:');
  const v = verifyOutputToken(result.outputToken!);
  assert(v.valid === true, 'HMAC signature is valid (platform generated)');

  // Modify one field → signature invalid
  const fakeToken = Buffer.from(JSON.stringify({
    payload: { ...decoded.payload, valueAssigned: '999.00000000' },
    signature: decoded.signature,
  })).toString('base64');
  const fakeV = verifyOutputToken(fakeToken);
  assert(fakeV.valid === false, 'Modified payload → signature invalid (tamper-proof)');

  // ──────────────────────────────────
  // Linked to specific ledger entry
  // ──────────────────────────────────
  console.log('\nLinked to ledger entry:');
  const entry = await prisma.ledgerEntry.findUnique({ where: { id: decoded.payload.ledgerEntryId } });
  assert(entry !== null, 'Ledger entry exists');
  assert(entry!.eventType === 'INVOICE_CLAIMED', `Event: ${entry!.eventType}`);
  assert(entry!.referenceId === 'FLD-001', `Reference: ${entry!.referenceId}`);
  assert(Number(entry!.amount) === 250, `Amount: ${entry!.amount}`);
  assert(entry!.tenantId === tenant.id, 'Same tenant');

  // ──────────────────────────────────
  // HMAC_SECRET from .env
  // ──────────────────────────────────
  console.log('\n.env:');
  assert(typeof process.env.HMAC_SECRET === 'string' && process.env.HMAC_SECRET.length > 0, 'HMAC_SECRET from .env');

  console.log(`\n=== TOKEN FIELDS: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
