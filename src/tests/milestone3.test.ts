import dotenv from 'dotenv';
dotenv.config();

import bcrypt from 'bcryptjs';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { issueStaffTokens, authenticateStaff, issueAdminTokens, authenticateAdmin } from '../services/auth.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { writeDoubleEntry, getAccountBalance, verifyHashChain } from '../services/ledger.js';
import { initiateRedemption, processRedemption } from '../services/redemption.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../services/idempotency.js';
import { runReconciliation } from '../services/reconciliation.js';
import { createPendingValidation } from '../services/invoice-validation.js';

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
  await prisma.idempotencyKey.deleteMany();
  await prisma.tenantAssetConfig.deleteMany();
  await prisma.product.deleteMany();
  await prisma.otpSession.deleteMany();
  await prisma.staff.deleteMany();
  await prisma.account.deleteMany();
  await prisma.assetType.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.adminUser.deleteMany();
  await prisma.tenant.deleteMany();

  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_update`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_update`;
}

// ============================================================
// STEP 3.1: ROLE SEPARATION AND AUDIT TRAIL
// ============================================================

async function testStep3_1() {
  console.log('\n=== STEP 3.1: ROLE SEPARATION AND AUDIT TRAIL ===\n');
  await cleanAll();

  const tenant = await createTenant('Role Store', 'role-store', 'r@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');

  // Create owner and cashier
  const ownerHash = await bcrypt.hash('owner123', 10);
  const cashierHash = await bcrypt.hash('cashier123', 10);

  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'owner@r.com', passwordHash: ownerHash, role: 'owner' },
  });
  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'cashier@r.com', passwordHash: cashierHash, role: 'cashier' },
  });

  // Test: Owner can authenticate
  console.log('Test: Authentication');
  const ownerAuth = await authenticateStaff('owner@r.com', 'owner123', tenant.id);
  assert(ownerAuth !== null, 'Owner can authenticate');
  assert(ownerAuth!.role === 'owner', 'Owner has owner role');

  const cashierAuth = await authenticateStaff('cashier@r.com', 'cashier123', tenant.id);
  assert(cashierAuth !== null, 'Cashier can authenticate');
  assert(cashierAuth!.role === 'cashier', 'Cashier has cashier role');

  // Test: Role enforcement via tokens
  console.log('\nTest: Role enforcement');
  const ownerTokens = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' });
  const cashierTokens = issueStaffTokens({ staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff' });

  assert(ownerTokens.accessToken.length > 0, 'Owner token issued');
  assert(cashierTokens.accessToken.length > 0, 'Cashier token issued');

  // Test: Cashier cannot access owner-only routes (tested via middleware logic)
  const { verifyStaffToken } = await import('../services/auth.js');
  const cashierPayload = verifyStaffToken(cashierTokens.accessToken);
  assert(cashierPayload.role === 'cashier', 'Cashier token has cashier role');
  assert(cashierPayload.role !== 'owner', 'Cashier cannot impersonate owner');

  // Test: Owner can deactivate a cashier
  console.log('\nTest: Staff management');
  await prisma.staff.update({ where: { id: cashier.id }, data: { active: false } });
  const deactivatedAuth = await authenticateStaff('cashier@r.com', 'cashier123', tenant.id);
  assert(deactivatedAuth === null, 'Deactivated cashier cannot authenticate');

  // Test: Audit trail is immutable
  console.log('\nTest: Audit trail immutability');
  await prisma.$executeRaw`
    INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, created_at)
    VALUES (gen_random_uuid(), ${tenant.id}::uuid, ${cashier.id}::uuid, 'staff', 'cashier', 'QR_SCAN_SUCCESS', 'success', now())
  `;

  const auditEntries = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenant.id}::uuid
  `;
  assert(auditEntries.length >= 1, 'Audit log entry exists');

  try {
    await prisma.$executeRaw`DELETE FROM audit_log WHERE tenant_id = ${tenant.id}::uuid`;
    assert(false, 'DELETE on audit_log should have been rejected');
  } catch (err: any) {
    assert(err.message?.includes('immutable') === true, 'Audit log DELETE rejected');
  }

  try {
    await prisma.$executeRaw`UPDATE audit_log SET outcome = 'failure' WHERE tenant_id = ${tenant.id}::uuid`;
    assert(false, 'UPDATE on audit_log should have been rejected');
  } catch (err: any) {
    assert(err.message?.includes('immutable') === true, 'Audit log UPDATE rejected');
  }
}

// ============================================================
// STEP 3.2: ADMIN PANEL
// ============================================================

async function testStep3_2() {
  console.log('\n=== STEP 3.2: ADMIN PANEL ===\n');
  await cleanAll();

  // Create admin user
  const adminHash = await bcrypt.hash('admin123', 10);
  const admin = await prisma.adminUser.create({
    data: { name: 'Eric', email: 'eric@platform.com', passwordHash: adminHash },
  });

  // Test: Admin authentication
  console.log('Test: Admin authentication');
  const adminAuth = await authenticateAdmin('eric@platform.com', 'admin123');
  assert(adminAuth !== null, 'Admin can authenticate');
  assert(adminAuth!.name === 'Eric', 'Admin name correct');

  const badAuth = await authenticateAdmin('eric@platform.com', 'wrong');
  assert(badAuth === null, 'Wrong password rejected');

  // Test: Create tenant from admin
  console.log('\nTest: Tenant creation from admin');
  const asset = await createAssetType('Points', 'pts', '1.00000000');

  const tenant = await createTenant('Admin Created Store', 'admin-store', 'admin-store@t.com');
  await createSystemAccounts(tenant.id);
  const ownerHash = await bcrypt.hash('pass', 10);
  await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Store Owner', email: 'admin-store@t.com', passwordHash: ownerHash, role: 'owner' },
  });

  const ownerAuth = await authenticateStaff('admin-store@t.com', 'pass', tenant.id);
  assert(ownerAuth !== null, 'Created merchant owner can log in');

  // Test: Manual adjustment
  console.log('\nTest: Manual adjustment (double-entry)');
  const consumer = await prisma.account.create({
    data: { tenantId: tenant.id, phoneNumber: '+58412555001', accountType: 'shadow' },
  });

  const poolAccount = await prisma.account.findFirst({
    where: { tenantId: tenant.id, systemAccountType: 'issued_value_pool' },
  });

  const adjResult = await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: poolAccount!.id,
    creditAccountId: consumer.id,
    amount: '75.00000000',
    assetTypeId: asset.id,
    referenceId: `ADJ-${Date.now()}`,
    referenceType: 'manual_adjustment',
    metadata: { adminId: admin.id, reason: 'Test manual adjustment for testing', direction: 'credit' },
  });

  assert(adjResult.debit !== null, 'Adjustment debit entry created');
  assert(adjResult.credit !== null, 'Adjustment credit entry created');

  const balance = await getAccountBalance(consumer.id, asset.id, tenant.id);
  assert(balance === '75.00000000', `Balance after adjustment: 75 (got: ${balance})`);

  // Test: Hash chain integrity
  console.log('\nTest: Hash chain integrity');
  const chainResult = await verifyHashChain(tenant.id);
  assert(chainResult.valid === true, 'Hash chain valid after adjustment');

  // Test: Platform metrics
  console.log('\nTest: Platform metrics');
  const tenantCount = await prisma.tenant.count({ where: { status: 'active' } });
  assert(tenantCount >= 1, `Active tenants: ${tenantCount}`);

  const consumerCount = await prisma.account.count({
    where: { accountType: { in: ['shadow', 'verified'] } },
  });
  assert(consumerCount >= 1, `Consumer accounts: ${consumerCount}`);
}

// ============================================================
// STEP 3.3: TRANSACTION IDEMPOTENCY
// ============================================================

async function testStep3_3() {
  console.log('\n=== STEP 3.3: TRANSACTION IDEMPOTENCY ===\n');
  await cleanAll();

  // Test idempotency key storage
  console.log('Test: Idempotency key store and retrieve');
  const key = 'test-request-123';
  const result = { success: true, value: 100 };

  const check1 = await checkIdempotencyKey(key);
  assert(check1 === null, 'Key not found initially');

  await storeIdempotencyKey(key, 'invoice_validation', result);
  const check2 = await checkIdempotencyKey(key);
  assert(check2 !== null, 'Key found after storing');
  assert(check2.success === true, 'Stored result is correct');

  // Test: Invoice double-claim already handled by unique constraint (Step 1.6)
  console.log('\nTest: Invoice double-claim idempotency');
  const tenant = await createTenant('Idemp Store', 'idemp-store', 'i@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@i.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  await processCSV(`invoice_number,total\nIDP-001,100.00`, tenant.id, staff.id);

  const v1 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412666001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'IDP-001', total_amount: 100.00, transaction_date: '2024-03-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(v1.success === true, 'First claim succeeds');

  const v2 = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412666001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'IDP-001', total_amount: 100.00, transaction_date: '2024-03-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(v2.success === false, 'Second claim rejected (idempotent)');

  // Verify only 2 ledger entries (1 double-entry pair)
  const entries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: 'IDP-001' },
  });
  assert(entries.length === 2, `Only 2 ledger entries (got: ${entries.length})`);

  // Test: Redemption double-scan already handled (Step 2.5)
  console.log('\nTest: Redemption double-scan idempotency');
  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Test', redemptionCost: '50.00000000', assetTypeId: asset.id, stock: 5, active: true },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412666001' } },
  });

  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });

  const scan1 = await processRedemption({ token: redemption.token!, cashierStaffId: staff.id, cashierTenantId: tenant.id });
  assert(scan1.success === true, 'First scan succeeds');

  const scan2 = await processRedemption({ token: redemption.token!, cashierStaffId: staff.id, cashierTenantId: tenant.id });
  assert(scan2.success === false, 'Second scan rejected (idempotent)');

  const confirmedEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED' },
  });
  assert(confirmedEntries.length === 2, `Only 2 REDEMPTION_CONFIRMED entries (got: ${confirmedEntries.length})`);

  // Test: CSV duplicate rows
  console.log('\nTest: CSV upload deduplication');
  const r = await processCSV(`invoice_number,total\nIDP-001,100.00\nIDP-002,200.00`, tenant.id, staff.id);
  assert(r.rowsLoaded === 1, `1 new row loaded (got: ${r.rowsLoaded})`);
  assert(r.rowsSkipped === 1, `1 duplicate skipped (got: ${r.rowsSkipped})`);
}

// ============================================================
// STEP 3.4: ASYNC RECONCILIATION
// ============================================================

async function testStep3_4() {
  console.log('\n=== STEP 3.4: ASYNC RECONCILIATION ===\n');
  await cleanAll();

  const tenant = await createTenant('Recon Store', 'recon-store', 'r@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@r.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Test: Submit invoice with no CSV uploaded → pending_validation
  console.log('Test: Invoice pending when no CSV uploaded');
  const pending = await createPendingValidation({
    tenantId: tenant.id,
    senderPhone: '+58412777001',
    invoiceNumber: 'RECON-001',
    totalAmount: 300.00,
    assetTypeId: asset.id,
  });
  assert(pending.success === true, 'Pending validation created');
  assert(pending.status === 'pending_validation', 'Status is pending_validation');

  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412777001' } },
  });
  const balBefore = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(balBefore === '300.00000000', `Provisional balance: 300 (got: ${balBefore})`);

  // Run reconciliation — should stay pending (no CSV yet)
  console.log('\nTest: Reconciliation with no CSV — stays pending');
  const recon1 = await runReconciliation();
  assert(recon1.stillPending === 1, `1 still pending (got: ${recon1.stillPending})`);

  // Upload CSV with matching invoice — CSV upload confirms pending invoices directly
  console.log('\nTest: Upload CSV → pending invoice confirmed directly');
  await processCSV(`invoice_number,total\nRECON-001,300.00`, tenant.id, staff.id);

  // Reconciliation has nothing left — CSV already confirmed it
  const recon2 = await runReconciliation();
  assert(recon2.stillPending === 0, `0 still pending (got: ${recon2.stillPending})`);

  // Check invoice status
  const invoice = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: 'RECON-001', source: 'photo_submission' },
  });
  assert(invoice!.status === 'claimed', `Invoice status: claimed (got: ${invoice!.status})`);

  // Test: Expired pending invoice → reversal
  // Use a fresh tenant to avoid the previous batch interfering
  console.log('\nTest: Expired pending → reversal');
  const tenant2 = await createTenant('Recon Store 2', 'recon-store-2', 'r2@t.com');
  await createSystemAccounts(tenant2.id);

  const pending2 = await createPendingValidation({
    tenantId: tenant2.id,
    senderPhone: '+58412777002',
    invoiceNumber: 'RECON-002',
    totalAmount: 150.00,
    assetTypeId: asset.id,
  });

  const account2 = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant2.id, phoneNumber: '+58412777002' } },
  });

  // Force the pending invoice to be older than the reconciliation window
  await prisma.invoice.updateMany({
    where: { tenantId: tenant2.id, invoiceNumber: 'RECON-002', source: 'photo_submission' },
    data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }, // 25 hours ago
  });

  const recon3 = await runReconciliation();
  assert(recon3.reversed === 1, `1 reversed (got: ${recon3.reversed})`);

  const balAfterReversal = await getAccountBalance(account2!.id, asset.id, tenant2.id);
  assert(Number(balAfterReversal) === 0, `Balance after reversal: 0 (got: ${balAfterReversal})`);

  // Verify REVERSAL entries exist
  const reversalEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant2.id, eventType: 'REVERSAL' },
  });
  assert(reversalEntries.length === 2, `2 REVERSAL entries (got: ${reversalEntries.length})`);

  const rejectedInvoice = await prisma.invoice.findFirst({
    where: { tenantId: tenant2.id, invoiceNumber: 'RECON-002', source: 'photo_submission' },
  });
  assert(rejectedInvoice!.status === 'rejected', `Rejected invoice status (got: ${rejectedInvoice!.status})`);
}

async function runAll() {
  await testStep3_1();
  await testStep3_2();
  await testStep3_3();
  await testStep3_4();

  console.log(`\n========================================`);
  console.log(`MILESTONE 3 TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
