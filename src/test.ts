import dotenv from 'dotenv';
dotenv.config();

import prisma from './db/client.js';
import { writeDoubleEntry, getAccountBalance, verifyHashChain } from './services/ledger.js';
import { createTenant } from './services/tenants.js';
import { findOrCreateConsumerAccount, createSystemAccounts } from './services/accounts.js';
import { createAssetType, setTenantConversionRate, convertToLoyaltyValue, getConversionRate } from './services/assets.js';
import { processCSV } from './services/csv-upload.js';
import { validateInvoice } from './services/invoice-validation.js';
import { generateOutputToken, verifyOutputToken, verifyAndResolveLedgerEntry } from './services/qr-token.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) { console.log(`  ✓ ${message}`); passed++; }
  else { console.log(`  ✗ FAIL: ${message}`); failed++; }
}

async function cleanAll() {
  // Disable triggers for cleanup
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_update`;
  await prisma.$executeRaw`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_no_update`;

  await prisma.recurrenceNotification.deleteMany();
  await prisma.recurrenceRule.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.redemptionToken.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.uploadBatch.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.tenantAssetConfig.deleteMany();
  await prisma.product.deleteMany();
  await prisma.staff.deleteMany();
  await prisma.account.deleteMany();
  await prisma.assetType.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.tenant.deleteMany();

  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_update`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_update`;
}

// ============================================================
// STEP 1.1: IMMUTABLE FINANCIAL LEDGER
// ============================================================

async function testStep1_1() {
  console.log('\n=== STEP 1.1: IMMUTABLE FINANCIAL LEDGER ===\n');
  await cleanAll();

  const tenant = await createTenant('Test Merchant', 'test-1-1', 'test@test.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const consumer = await prisma.account.create({
    data: { tenantId: tenant.id, phoneNumber: '+58412000001', accountType: 'shadow' },
  });

  // Test 1: Double-entry write
  console.log('Test 1: Double-entry write');
  const result = await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.id,
    amount: '100.00000000', assetTypeId: asset.id,
    referenceId: 'INV-001', referenceType: 'invoice',
  });
  assert(!!result.debit, 'Debit entry created');
  assert(!!result.credit, 'Credit entry created');
  assert(result.debit.entryType === 'DEBIT', 'Debit type correct');
  assert(result.credit.entryType === 'CREDIT', 'Credit type correct');
  assert(result.debit.pairedEntryId === result.credit.id, 'Debit points to credit');
  assert(result.credit.pairedEntryId === result.debit.id, 'Credit points to debit');
  assert(Number(result.debit.amount) === 100, 'Debit amount correct');
  assert(Number(result.credit.amount) === 100, 'Credit amount correct');

  // Test 2: UPDATE rejected
  console.log('\nTest 2: Immutability — UPDATE rejected');
  try {
    await prisma.$executeRaw`UPDATE ledger_entries SET amount = 999 WHERE id = ${result.debit.id}::uuid`;
    assert(false, 'UPDATE should have been rejected');
  } catch (err: any) {
    assert(err.message?.includes('immutable') === true, 'UPDATE rejected with immutability error');
  }

  // Test 3: DELETE rejected
  console.log('\nTest 3: Immutability — DELETE rejected');
  try {
    await prisma.$executeRaw`DELETE FROM ledger_entries WHERE id = ${result.debit.id}::uuid`;
    assert(false, 'DELETE should have been rejected');
  } catch (err: any) {
    assert(err.message?.includes('immutable') === true, 'DELETE rejected with immutability error');
  }

  // Test 4: Duplicate reference_id rejected
  console.log('\nTest 4: Duplicate reference_id rejected');
  try {
    await writeDoubleEntry({
      tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
      debitAccountId: sys.pool.id, creditAccountId: consumer.id,
      amount: '50.00000000', assetTypeId: asset.id,
      referenceId: 'INV-001', referenceType: 'invoice',
    });
    assert(false, 'Duplicate should have been rejected');
  } catch (err: any) {
    assert(err.code === 'P2002' || err.message?.includes('Unique'), 'Duplicate reference_id rejected');
  }

  // Test 5: Balance computed from history
  console.log('\nTest 5: Balance computed from history');
  const bal1 = await getAccountBalance(consumer.id, asset.id, tenant.id);
  assert(bal1 === '100.00000000', `Balance is 100 (got: ${bal1})`);

  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.id,
    amount: '50.00000000', assetTypeId: asset.id,
    referenceId: 'INV-002', referenceType: 'invoice',
  });
  const bal2 = await getAccountBalance(consumer.id, asset.id, tenant.id);
  assert(bal2 === '150.00000000', `Balance after 2nd tx is 150 (got: ${bal2})`);

  // Test 6: Hash chain verification
  console.log('\nTest 6: Hash chain integrity');
  const chain = await verifyHashChain(tenant.id);
  assert(chain.valid === true, 'Hash chain is valid');
}

// ============================================================
// STEP 1.2: MULTI-TENANT STRUCTURE
// ============================================================

async function testStep1_2() {
  console.log('\n=== STEP 1.2: MULTI-TENANT STRUCTURE ===\n');
  await cleanAll();

  const tenantA = await createTenant('Merchant A', 'merchant-a', 'a@test.com');
  const tenantB = await createTenant('Merchant B', 'merchant-b', 'b@test.com');
  assert(tenantA.id !== tenantB.id, 'Two distinct tenants');

  const sysA = await createSystemAccounts(tenantA.id);
  await createSystemAccounts(tenantB.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');

  const consA = await findOrCreateConsumerAccount(tenantA.id, '+58412000001');
  const consB = await findOrCreateConsumerAccount(tenantB.id, '+58412000001');
  assert(consA.account.id !== consB.account.id, 'Same phone, separate accounts per tenant');

  await writeDoubleEntry({
    tenantId: tenantA.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sysA.pool.id, creditAccountId: consA.account.id,
    amount: '200.00000000', assetTypeId: asset.id,
    referenceId: 'INV-A-001', referenceType: 'invoice',
  });

  const ledgerA = await prisma.ledgerEntry.findMany({ where: { tenantId: tenantA.id } });
  const ledgerB = await prisma.ledgerEntry.findMany({ where: { tenantId: tenantB.id } });
  assert(ledgerA.length === 2, `Tenant A: 2 entries (got: ${ledgerA.length})`);
  assert(ledgerB.length === 0, `Tenant B: 0 entries (got: ${ledgerB.length})`);

  const balA = await getAccountBalance(consA.account.id, asset.id, tenantA.id);
  const balB = await getAccountBalance(consB.account.id, asset.id, tenantB.id);
  assert(balA === '200.00000000', `Tenant A balance: 200 (got: ${balA})`);
  assert(balB === '0', `Tenant B balance: 0 (got: ${balB})`);
}

// ============================================================
// STEP 1.3: ASSET TYPE SYSTEM
// ============================================================

async function testStep1_3() {
  console.log('\n=== STEP 1.3: ASSET TYPE SYSTEM ===\n');
  await cleanAll();

  const asset = await createAssetType('Loyalty Points', 'points', '1.00000000');
  assert(asset.name === 'Loyalty Points', 'Asset type created');

  const tenantA = await createTenant('A', 'a-asset', 'a@t.com');
  const tenantB = await createTenant('B', 'b-asset', 'b@t.com');

  const rateA = await getConversionRate(tenantA.id, asset.id);
  assert(Number(rateA) === 1, `Default rate A (got: ${rateA})`);

  await setTenantConversionRate(tenantB.id, asset.id, '2.50000000');
  const rateB = await getConversionRate(tenantB.id, asset.id);
  assert(Number(rateB) === 2.5, `Override rate B (got: ${rateB})`);

  const valA = await convertToLoyaltyValue('100.00', tenantA.id, asset.id);
  const valB = await convertToLoyaltyValue('100.00', tenantB.id, asset.id);
  assert(valA === '100.00000000', `$100 @ 1.0 = 100 (got: ${valA})`);
  assert(valB === '250.00000000', `$100 @ 2.5 = 250 (got: ${valB})`);
}

// ============================================================
// STEP 1.4: SHADOW ACCOUNT SYSTEM
// ============================================================

async function testStep1_4() {
  console.log('\n=== STEP 1.4: SHADOW ACCOUNT SYSTEM ===\n');
  await cleanAll();

  const tenantA = await createTenant('A', 'a-shadow', 'a@t.com');
  const tenantB = await createTenant('B', 'b-shadow', 'b@t.com');
  const asset = await createAssetType('P', 'p', '1.00000000');

  const r1 = await findOrCreateConsumerAccount(tenantA.id, '+58412111001');
  assert(r1.created === true, 'Created new account');
  assert(r1.account.accountType === 'shadow', 'Type is shadow');

  const r2 = await findOrCreateConsumerAccount(tenantA.id, '+58412111001');
  assert(r2.created === false, 'Same phone returns existing');
  assert(r2.account.id === r1.account.id, 'Same account ID');

  const r3 = await findOrCreateConsumerAccount(tenantB.id, '+58412111001');
  assert(r3.created === true, 'Different tenant creates new');
  assert(r3.account.id !== r1.account.id, 'Different account ID');

  const bal = await getAccountBalance(r1.account.id, asset.id, tenantA.id);
  assert(bal === '0', `Initial balance is 0 (got: ${bal})`);
}

// ============================================================
// STEP 1.5: MERCHANT CSV UPLOAD
// ============================================================

async function testStep1_5() {
  console.log('\n=== STEP 1.5: MERCHANT CSV UPLOAD ===\n');
  await cleanAll();

  const tenant = await createTenant('Store', 'store-csv', 's@t.com');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@s.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  const csv = `invoice_number,total,date,phone
INV-001,100.00,2024-01-15,+58412001
INV-002,250.50,2024-01-15,+58412002
INV-003,75.00,2024-01-16,
INV-004,320.00,2024-01-16,+58412004
INV-005,45.99,2024-01-17,+58412005
INV-003,75.00,2024-01-16,
,invalid_amount,,`;

  const result = await processCSV(csv, tenant.id, staff.id);
  assert(result.rowsLoaded === 5, `5 loaded (got: ${result.rowsLoaded})`);
  assert(result.rowsSkipped === 1, `1 skipped (got: ${result.rowsSkipped})`);
  assert(result.rowsErrored === 1, `1 errored (got: ${result.rowsErrored})`);

  const invoices = await prisma.invoice.findMany({ where: { tenantId: tenant.id } });
  assert(invoices.length === 5, `5 invoices in DB (got: ${invoices.length})`);

  // Re-upload — all should be skipped
  const r2 = await processCSV(csv, tenant.id, staff.id);
  assert(r2.rowsLoaded === 0, `0 on re-upload (got: ${r2.rowsLoaded})`);
}

// ============================================================
// STEP 1.6: INVOICE VALIDATION PIPELINE
// ============================================================

async function testStep1_6() {
  console.log('\n=== STEP 1.6: INVOICE VALIDATION PIPELINE ===\n');
  await cleanAll();

  const tenant = await createTenant('Store', 'store-val', 's@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@s.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  await processCSV(`invoice_number,total,phone\nINV-100,150.00,+58412999001\nINV-101,200.00,+58412999002\nINV-102,75.50,`, tenant.id, staff.id);

  // Success
  const r1 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412999001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'INV-100', total_amount: 150.00, transaction_date: '2024-03-01', customer_phone: '+58412999001', merchant_name: 'Store', confidence_score: 0.95 },
  });
  assert(r1.success === true, 'Validation succeeded');
  assert(r1.valueAssigned === '150.00000000', `Value: ${r1.valueAssigned}`);

  // Duplicate rejected
  const r2 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412999001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'INV-100', total_amount: 150.00, transaction_date: '2024-03-01', customer_phone: '+58412999001', merchant_name: 'Store', confidence_score: 0.95 },
  });
  assert(r2.success === false, 'Duplicate rejected');

  // Phone mismatch rejected
  const r3 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412999999', assetTypeId: asset.id,
    extractedData: { invoice_number: 'INV-101', total_amount: 200.00, transaction_date: '2024-03-01', customer_phone: '+58412999002', merchant_name: 'Store', confidence_score: 0.95 },
  });
  assert(r3.success === false, 'Phone mismatch rejected');

  // Not found rejected
  const r4 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412999001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'FAKE', total_amount: 100.00, transaction_date: '2024-03-01', customer_phone: '+58412999001', merchant_name: 'Store', confidence_score: 0.95 },
  });
  assert(r4.success === false, 'Non-existent rejected');

  // Low confidence rejected
  const r5 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412999001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'INV-102', total_amount: 75.50, transaction_date: '2024-03-02', customer_phone: null, merchant_name: null, confidence_score: 0.3 },
  });
  assert(r5.success === false, 'Low confidence rejected');

  // No phone on invoice — works
  const r6 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412999003', assetTypeId: asset.id,
    extractedData: { invoice_number: 'INV-102', total_amount: 75.50, transaction_date: '2024-03-02', customer_phone: null, merchant_name: null, confidence_score: 0.9 },
  });
  assert(r6.success === true, 'No phone on invoice — validates');

  // Shadow account auto-created
  const acc = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412999003' } },
  });
  assert(acc?.accountType === 'shadow', 'Shadow account auto-created');
}

// ============================================================
// STEP 1.7: QR OUTPUT TOKEN
// ============================================================

async function testStep1_7() {
  console.log('\n=== STEP 1.7: QR OUTPUT TOKEN GENERATION ===\n');
  await cleanAll();

  const tenant = await createTenant('Store', 'store-qr', 's@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@s.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  await processCSV(`invoice_number,total\nTK-001,500.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412777001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'TK-001', total_amount: 500.00, transaction_date: '2024-03-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const creditEntry = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, referenceId: 'TK-001', entryType: 'CREDIT' },
  });

  const token = generateOutputToken(creditEntry!.id, creditEntry!.accountId, '500.00000000', tenant.id);
  assert(token.token.length > 0, 'Token generated');
  assert(token.signature.length === 64, 'Signature is 64 hex chars');

  const v = verifyOutputToken(token.token);
  assert(v.valid === true, 'Token is valid');

  const tampered = token.token.slice(0, -2) + 'XX';
  const tv = verifyOutputToken(tampered);
  assert(tv.valid === false, 'Tampered token rejected');

  const resolved = await verifyAndResolveLedgerEntry(token.token);
  assert(resolved.valid === true, 'Resolves to ledger entry');
  assert(resolved.ledgerEntry?.eventType === 'INVOICE_CLAIMED', 'Correct event type');
}

// ============================================================
// RUN ALL TESTS
// ============================================================

async function runAll() {
  await testStep1_1();
  await testStep1_2();
  await testStep1_3();
  await testStep1_4();
  await testStep1_5();
  await testStep1_6();
  await testStep1_7();

  console.log(`\n========================================`);
  console.log(`MILESTONE 1 TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
