import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { verifyOutputToken, verifyAndResolveLedgerEntry } from '../services/qr-token.js';

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
  console.log('=== STEP 1.7: QR OUTPUT TOKEN — FULL E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Token Store', 'token-store', 'tk@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@tk.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  await processCSV(`invoice_number,total\nTK-001,500.00\nTK-002,300.00`, tenant.id, staff.id);

  // ──────────────────────────────────
  // 1. Successful validation produces a unique signed token
  // ──────────────────────────────────
  console.log('1. Successful validation → token generated');
  const result1 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'TK-001', total_amount: 500, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(result1.success === true, 'Validation succeeded');
  assert(result1.outputToken !== undefined, 'outputToken returned in result');
  assert(result1.outputToken!.length > 0, `Token is non-empty (${result1.outputToken!.length} chars)`);

  // ──────────────────────────────────
  // 2. Token contains correct payload
  // ──────────────────────────────────
  console.log('\n2. Token contains: ledger entry ID, account ID, value, tenant, timestamp');
  const verification = verifyOutputToken(result1.outputToken!);
  assert(verification.valid === true, 'Token is valid (HMAC verified)');
  assert(verification.payload !== undefined, 'Payload decoded');
  assert(verification.payload!.valueAssigned === '500.00000000', `Value: ${verification.payload!.valueAssigned}`);
  assert(verification.payload!.tenantId === tenant.id, 'Correct tenant');
  assert(!!verification.payload!.ledgerEntryId, `Ledger entry ID: ${verification.payload!.ledgerEntryId.slice(0,8)}...`);
  assert(!!verification.payload!.consumerAccountId, `Consumer account ID present`);
  assert(!!verification.payload!.timestamp, `Timestamp: ${verification.payload!.timestamp}`);

  // ──────────────────────────────────
  // 3. Token linked to the specific ledger entry
  // ──────────────────────────────────
  console.log('\n3. Token resolves to the correct ledger entry');
  const resolved = await verifyAndResolveLedgerEntry(result1.outputToken!);
  assert(resolved.valid === true, 'Resolves successfully');
  assert(resolved.ledgerEntry !== undefined, 'Ledger entry found');
  assert(resolved.ledgerEntry!.eventType === 'INVOICE_CLAIMED', `Event: ${resolved.ledgerEntry!.eventType}`);
  assert(resolved.ledgerEntry!.referenceId === 'TK-001', `Reference: ${resolved.ledgerEntry!.referenceId}`);
  assert(Number(resolved.ledgerEntry!.amount) === 500, `Amount: ${resolved.ledgerEntry!.amount}`);

  // ──────────────────────────────────
  // 4. Token signature stored on invoice record
  // ──────────────────────────────────
  console.log('\n4. Token signature stored on invoice');
  const inv = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'TK-001' } });
  const extractedData = inv!.extractedData as any;
  assert(extractedData?.outputTokenSignature !== undefined, 'Signature stored in invoice.extracted_data');
  assert(extractedData.outputTokenSignature.length === 64, `Signature is 64 hex chars (got ${extractedData.outputTokenSignature.length})`);

  // ──────────────────────────────────
  // 5. Tampered token is rejected
  // ──────────────────────────────────
  console.log('\n5. Tampered token → rejected');
  const tampered = result1.outputToken!.slice(0, -3) + 'XXX';
  const tamperedResult = verifyOutputToken(tampered);
  assert(tamperedResult.valid === false, 'Tampered token rejected');
  assert(tamperedResult.reason !== undefined, `Reason: ${tamperedResult.reason}`);

  // ──────────────────────────────────
  // 6. No two validations produce the same token
  // ──────────────────────────────────
  console.log('\n6. Second validation → different token');
  const result2 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550002', assetTypeId: asset.id,
    extractedData: { invoice_number: 'TK-002', total_amount: 300, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(result2.outputToken !== undefined, 'Second validation has token');
  assert(result2.outputToken !== result1.outputToken, 'Tokens are different');

  const v2 = verifyOutputToken(result2.outputToken!);
  assert(v2.payload!.ledgerEntryId !== verification.payload!.ledgerEntryId, 'Different ledger entry IDs');
  assert(v2.payload!.valueAssigned === '300.00000000', 'Second token has correct value');

  // ──────────────────────────────────
  // 7. Token uses HMAC_SECRET from .env
  // ──────────────────────────────────
  console.log('\n7. HMAC_SECRET from .env');
  assert(typeof process.env.HMAC_SECRET === 'string', 'HMAC_SECRET is configured');
  assert(process.env.HMAC_SECRET!.length > 0, 'HMAC_SECRET is non-empty');

  const fs = await import('fs');
  const src = fs.readFileSync('/home/loyalty-platform/src/services/qr-token.ts', 'utf-8');
  assert(src.includes('HMAC_SECRET'), 'qr-token.ts uses HMAC_SECRET from .env');
  assert(src.includes("createHmac('sha256'"), 'Uses HMAC-SHA256');

  // ──────────────────────────────────
  // 8. Failed validations do NOT produce tokens
  // ──────────────────────────────────
  console.log('\n8. Failed validation → no token');
  const failedResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550003', assetTypeId: asset.id,
    extractedData: { invoice_number: 'NONEXISTENT', total_amount: 100, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(failedResult.success === false, 'Validation failed');
  assert(failedResult.outputToken === undefined, 'No token on failure');

  // ──────────────────────────────────
  // 9. Verification endpoint
  // ──────────────────────────────────
  console.log('\n9. Verification endpoint resolves token to ledger');
  const { verifyAndResolveLedgerEntry: verify } = await import('../services/qr-token.js');
  assert(typeof verify === 'function', 'verifyAndResolveLedgerEntry function exists');

  const validResolve = await verify(result1.outputToken!);
  assert(validResolve.valid === true, 'Valid token resolves');

  const invalidResolve = await verify(tampered);
  assert(invalidResolve.valid === false, 'Invalid token does not resolve');

  console.log(`\n=== STEP 1.7: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
