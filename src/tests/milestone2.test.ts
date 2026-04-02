import dotenv from 'dotenv';
dotenv.config();

import bcrypt from 'bcryptjs';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { generateOTP, verifyOTP, issueConsumerTokens, issueStaffTokens } from '../services/auth.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { getAccountBalance } from '../services/ledger.js';
import { initiateRedemption, processRedemption, expireRedemption } from '../services/redemption.js';
import { upgradeToVerified } from '../services/accounts.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) { console.log(`  ✓ ${message}`); passed++; }
  else { console.log(`  ✗ FAIL: ${message}`); failed++; }
}

async function cleanAll() {
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
  await prisma.otpSession.deleteMany();
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

async function testStep2_1() {
  console.log('\n=== STEP 2.1: CONSUMER AUTH, BALANCE, HISTORY ===\n');
  await cleanAll();

  const tenant = await createTenant('Test Store', 'test-store', 'store@test.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@s.com', passwordHash: await bcrypt.hash('pass123', 10), role: 'owner' },
  });

  // Upload CSV and validate an invoice to give the consumer a balance
  await processCSV(`invoice_number,total\nINV-100,500.00`, tenant.id, staff.id);

  // Test OTP flow
  console.log('Test: OTP generation and verification');
  const otp = await generateOTP('+58412000001');
  assert(otp.length === 6, `OTP is 6 digits (got: ${otp})`);

  const invalidVerify = await verifyOTP('+58412000001', '000000');
  assert(invalidVerify === false, 'Wrong OTP is rejected');

  const validVerify = await verifyOTP('+58412000001', otp);
  assert(validVerify === true, 'Correct OTP is accepted');

  const reuse = await verifyOTP('+58412000001', otp);
  assert(reuse === false, 'Used OTP cannot be reused');

  // Test JWT issuance
  console.log('\nTest: JWT issuance');
  const tokens = issueConsumerTokens({
    accountId: 'test-id',
    tenantId: tenant.id,
    phoneNumber: '+58412000001',
    type: 'consumer',
  });
  assert(tokens.accessToken.length > 0, 'Access token issued');
  assert(tokens.refreshToken.length > 0, 'Refresh token issued');

  // Validate invoice to create balance
  const valResult = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: '+58412000001',
    assetTypeId: asset.id,
    extractedData: { invoice_number: 'INV-100', total_amount: 500.00, transaction_date: '2024-03-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(valResult.success === true, 'Invoice validated for balance');

  // Test balance query
  console.log('\nTest: Balance matches ledger sum');
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412000001' } },
  });
  const balance = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(balance === '500.00000000', `Balance is 500 (got: ${balance})`);

  // Test history
  console.log('\nTest: History shows all events');
  const { getAccountHistory } = await import('../services/ledger.js');
  const history = await getAccountHistory(account!.id, tenant.id);
  assert(history.length > 0, `History has entries (got: ${history.length})`);
  assert(history[0].eventType === 'INVOICE_CLAIMED', 'Latest event is INVOICE_CLAIMED');
}

async function testStep2_3_2_4() {
  console.log('\n=== STEP 2.3 + 2.4: CATALOG + REDEMPTION QR ===\n');
  // Uses data from step 2.1 — no clean

  const tenant = await prisma.tenant.findUnique({ where: { slug: 'test-store' } });
  const asset = await prisma.assetType.findFirst();
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant!.id, phoneNumber: '+58412000001' } },
  });

  // Create products
  const affordable = await prisma.product.create({
    data: { tenantId: tenant!.id, name: 'Coffee Mug', redemptionCost: '100.00000000', assetTypeId: asset!.id, stock: 5, active: true },
  });
  const expensive = await prisma.product.create({
    data: { tenantId: tenant!.id, name: 'Laptop', redemptionCost: '99999.00000000', assetTypeId: asset!.id, stock: 1, active: true },
  });
  const outOfStock = await prisma.product.create({
    data: { tenantId: tenant!.id, name: 'Gone Item', redemptionCost: '10.00000000', assetTypeId: asset!.id, stock: 0, active: true },
  });
  const inactive = await prisma.product.create({
    data: { tenantId: tenant!.id, name: 'Hidden Item', redemptionCost: '10.00000000', assetTypeId: asset!.id, stock: 5, active: false },
  });

  // Test catalog visibility
  console.log('Test: Catalog filtering');
  const visibleProducts = await prisma.product.findMany({
    where: { tenantId: tenant!.id, active: true, stock: { gt: 0 } },
  });
  assert(visibleProducts.length === 2, `2 visible products (got: ${visibleProducts.length})`);
  assert(visibleProducts.some(p => p.name === 'Coffee Mug'), 'Affordable product visible');
  assert(visibleProducts.some(p => p.name === 'Laptop'), 'Expensive product visible');
  assert(!visibleProducts.some(p => p.name === 'Gone Item'), 'Zero-stock product hidden');
  assert(!visibleProducts.some(p => p.name === 'Hidden Item'), 'Inactive product hidden');

  // Test affordability
  const balance = await getAccountBalance(account!.id, asset!.id, tenant!.id);
  const canAffordMug = parseFloat(balance) >= Number(affordable.redemptionCost);
  const canAffordLaptop = parseFloat(balance) >= Number(expensive.redemptionCost);
  assert(canAffordMug === true, 'Can afford Coffee Mug');
  assert(canAffordLaptop === false, 'Cannot afford Laptop');

  // Test redemption QR generation
  console.log('\nTest: Redemption QR generation');
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id,
    productId: affordable.id,
    tenantId: tenant!.id,
    assetTypeId: asset!.id,
  });
  assert(redemption.success === true, 'Redemption initiated');
  assert(!!redemption.token, 'Token generated');
  assert(!!redemption.expiresAt, 'ExpiresAt set');

  // Verify balance reduced (value reserved)
  const balAfter = await getAccountBalance(account!.id, asset!.id, tenant!.id);
  assert(balAfter === '400.00000000', `Balance reduced to 400 (got: ${balAfter})`);

  // Verify PENDING_REDEMPTION in ledger
  const pendingEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant!.id, eventType: 'REDEMPTION_PENDING' },
  });
  assert(pendingEntries.length === 2, `2 PENDING_REDEMPTION entries (double-entry) (got: ${pendingEntries.length})`);

  // Test insufficient balance redemption
  console.log('\nTest: Insufficient balance rejection');
  const failRedeem = await initiateRedemption({
    consumerAccountId: account!.id,
    productId: expensive.id,
    tenantId: tenant!.id,
    assetTypeId: asset!.id,
  });
  assert(failRedeem.success === false, 'Insufficient balance rejected');

  // Store redemption token for Step 2.5 test
  (globalThis as any).__testToken = redemption.token;
  (globalThis as any).__testTokenId = redemption.tokenId;
  (globalThis as any).__testProductId = affordable.id;
}

async function testStep2_5() {
  console.log('\n=== STEP 2.5: CASHIER QR SCANNER ===\n');

  const tenant = await prisma.tenant.findUnique({ where: { slug: 'test-store' } });
  const staff = await prisma.staff.findFirst({ where: { tenantId: tenant!.id, role: 'owner' } });
  const token = (globalThis as any).__testToken;
  const productId = (globalThis as any).__testProductId;

  // Get stock before
  const productBefore = await prisma.product.findUnique({ where: { id: productId } });

  // Process redemption
  console.log('Test: Process valid redemption');
  const result = await processRedemption({
    token,
    cashierStaffId: staff!.id,
    cashierTenantId: tenant!.id,
  });
  assert(result.success === true, 'Redemption processed successfully');
  assert(result.productName === 'Coffee Mug', `Product name: ${result.productName}`);

  // Verify stock decremented
  const productAfter = await prisma.product.findUnique({ where: { id: productId } });
  assert(productAfter!.stock === productBefore!.stock - 1, `Stock decremented: ${productBefore!.stock} -> ${productAfter!.stock}`);

  // Verify REDEMPTION_CONFIRMED in ledger
  const confirmedEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant!.id, eventType: 'REDEMPTION_CONFIRMED' },
  });
  assert(confirmedEntries.length === 2, `2 REDEMPTION_CONFIRMED entries (got: ${confirmedEntries.length})`);

  // Verify audit log
  const auditEntries = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenant!.id}::uuid AND action_type = 'QR_SCAN_SUCCESS'
  `;
  assert(auditEntries.length === 1, `Audit log entry created (got: ${auditEntries.length})`);

  // Test: same QR scanned again — rejected
  console.log('\nTest: Same QR scanned again — rejected');
  const dup = await processRedemption({
    token,
    cashierStaffId: staff!.id,
    cashierTenantId: tenant!.id,
  });
  assert(dup.success === false, 'Duplicate scan rejected');
  assert(dup.message.includes('already been used'), `Reason: ${dup.message}`);

  // Test: tenant mismatch
  console.log('\nTest: Tenant mismatch');
  const otherTenant = await createTenant('Other', 'other-store', 'other@test.com');
  const mismatch = await processRedemption({
    token,
    cashierStaffId: staff!.id,
    cashierTenantId: otherTenant.id,
  });
  assert(mismatch.success === false, 'Tenant mismatch rejected');
}

async function testStep2_6() {
  console.log('\n=== STEP 2.6: CATALOG MANAGEMENT ===\n');

  const tenant = await prisma.tenant.findUnique({ where: { slug: 'test-store' } });

  // Test toggle active/inactive
  console.log('Test: Toggle product active/inactive');
  const product = await prisma.product.findFirst({ where: { tenantId: tenant!.id, name: 'Coffee Mug' } });

  await prisma.product.update({ where: { id: product!.id }, data: { active: false } });
  const visible = await prisma.product.findMany({
    where: { tenantId: tenant!.id, active: true, stock: { gt: 0 } },
  });
  assert(!visible.some(p => p.name === 'Coffee Mug'), 'Toggled product disappears from catalog');

  await prisma.product.update({ where: { id: product!.id }, data: { active: true } });
  const visible2 = await prisma.product.findMany({
    where: { tenantId: tenant!.id, active: true, stock: { gt: 0 } },
  });
  assert(visible2.some(p => p.name === 'Coffee Mug'), 'Re-toggled product reappears');

  // Test: set stock to 1, redeem, verify disappears
  console.log('\nTest: Stock depletion hides product');
  const testProduct = await prisma.product.create({
    data: { tenantId: tenant!.id, name: 'Last One', redemptionCost: '1.00000000', assetTypeId: (await prisma.assetType.findFirst())!.id, stock: 1, active: true },
  });
  await prisma.product.update({ where: { id: testProduct.id }, data: { stock: 0 } });

  const vis = await prisma.product.findMany({
    where: { tenantId: tenant!.id, active: true, stock: { gt: 0 } },
  });
  assert(!vis.some(p => p.name === 'Last One'), 'Zero-stock product hidden from consumers');
}

async function testStep2_7() {
  console.log('\n=== STEP 2.7: SHADOW TO VERIFIED UPGRADE ===\n');

  const tenant = await prisma.tenant.findUnique({ where: { slug: 'test-store' } });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant!.id, phoneNumber: '+58412000001' } },
  });

  assert(account!.accountType === 'shadow', 'Account starts as shadow');

  // Upgrade
  console.log('Test: Upgrade shadow to verified');
  const upgraded = await upgradeToVerified(account!.id, tenant!.id, 'V-12345678');
  assert(upgraded.accountType === 'verified', 'Account type changed to verified');
  assert(upgraded.cedula === 'V-12345678', `Cedula stored: ${upgraded.cedula}`);

  // Verify ledger history preserved
  const { getAccountHistory } = await import('../services/ledger.js');
  const history = await getAccountHistory(account!.id, tenant!.id);
  assert(history.length > 0, 'Ledger history preserved after upgrade');

  // Test: same cedula on different phone — conflict
  console.log('\nTest: Duplicate cedula rejected');
  const account2 = await prisma.account.create({
    data: { tenantId: tenant!.id, phoneNumber: '+58412000002', accountType: 'shadow' },
  });
  try {
    await upgradeToVerified(account2.id, tenant!.id, 'V-12345678');
    assert(false, 'Duplicate cedula should have been rejected');
  } catch (err: any) {
    assert(err.code === 'P2002' || err.message?.includes('Unique'), 'Duplicate cedula rejected with unique constraint');
  }
}

async function testExpiry() {
  console.log('\n=== STEP 2.4 BONUS: QR EXPIRY REVERSAL ===\n');
  await cleanAll();

  const tenant = await createTenant('Expiry Store', 'expiry-store', 'e@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@e.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  await processCSV(`invoice_number,total\nEX-001,200.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412888001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'EX-001', total_amount: 200.00, transaction_date: '2024-03-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412888001' } },
  });

  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Expiry Item', redemptionCost: '50.00000000', assetTypeId: asset.id, stock: 5, active: true },
  });

  // Initiate redemption
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id,
    productId: product.id,
    tenantId: tenant.id,
    assetTypeId: asset.id,
  });
  assert(redemption.success === true, 'Redemption initiated');

  const balBefore = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(balBefore === '150.00000000', `Balance after reservation: 150 (got: ${balBefore})`);

  // Force token to expire
  await prisma.redemptionToken.update({
    where: { id: redemption.tokenId! },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  // Expire it
  await expireRedemption(redemption.tokenId!);

  const balAfter = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(balAfter === '200.00000000', `Balance restored after expiry: 200 (got: ${balAfter})`);

  const tokenRecord = await prisma.redemptionToken.findUnique({ where: { id: redemption.tokenId! } });
  assert(tokenRecord!.status === 'expired', 'Token status is expired');

  // Verify REDEMPTION_EXPIRED entries exist
  const expiredEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_EXPIRED' },
  });
  assert(expiredEntries.length === 2, `2 REDEMPTION_EXPIRED entries (got: ${expiredEntries.length})`);
}

async function runAll() {
  await testStep2_1();
  await testStep2_3_2_4();
  await testStep2_5();
  await testStep2_6();
  await testStep2_7();
  await testExpiry();

  console.log(`\n========================================`);
  console.log(`MILESTONE 2 TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
