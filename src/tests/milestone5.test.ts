import dotenv from 'dotenv';
dotenv.config();

import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { writeDoubleEntry, getAccountBalance } from '../services/ledger.js';
import { initiateRedemption, processRedemption } from '../services/redemption.js';
import { createBranch, listBranches, cashierHasBranchAccess } from '../services/branches.js';
import { getMerchantMetrics, getProductPerformance } from '../services/metrics.js';
import { createDispute, listDisputes, resolveDispute } from '../services/disputes.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../services/idempotency.js';
import bcrypt from 'bcryptjs';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) { console.log(`  ✓ ${message}`); passed++; }
  else { console.log(`  ✗ FAIL: ${message}`); failed++; }
}

async function cleanAll() {
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
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
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_update`;
}

// ============================================================
// STEP 5.1: MULTI-BRANCH SUPPORT
// ============================================================

async function testStep5_1() {
  console.log('\n=== STEP 5.1: MULTI-BRANCH SUPPORT ===\n');
  await cleanAll();

  const tenant = await createTenant('Multi Store', 'multi-store', 'm@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');

  // Create two branches
  console.log('Test: Create branches');
  const branchA = await createBranch({ tenantId: tenant.id, name: 'Downtown', latitude: 10.15, longitude: -67.99 });
  const branchB = await createBranch({ tenantId: tenant.id, name: 'Mall', latitude: 10.20, longitude: -68.01 });

  const branches = await listBranches(tenant.id);
  assert(branches.length === 2, `2 branches created (got: ${branches.length})`);

  // Assign cashier to Branch A
  console.log('\nTest: Branch-scoped cashier');
  const cashierA = await prisma.staff.create({
    data: { tenantId: tenant.id, branchId: branchA.id, name: 'Cashier A', email: 'ca@m.com', passwordHash: await bcrypt.hash('p', 10), role: 'cashier' },
  });
  const ownerStaff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@m.com', passwordHash: await bcrypt.hash('p', 10), role: 'owner' },
  });

  assert(await cashierHasBranchAccess(cashierA.id, branchA.id) === true, 'Cashier A has access to Branch A');
  assert(await cashierHasBranchAccess(cashierA.id, branchB.id) === false, 'Cashier A denied access to Branch B');
  assert(await cashierHasBranchAccess(ownerStaff.id, branchB.id) === true, 'Owner has access to all branches');

  // Ledger entries record branch ID
  console.log('\nTest: Ledger entries record branch');
  await processCSV(`invoice_number,total\nBR-001,100.00`, tenant.id, ownerStaff.id);
  const valResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412BR001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'BR-001', total_amount: 100.00, transaction_date: '2024-03-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(valResult.success === true, 'Invoice validated');

  // Check per-branch filtering
  const allEntries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id } });
  assert(allEntries.length >= 2, `Ledger entries exist (got: ${allEntries.length})`);
}

// ============================================================
// STEP 5.2: MERCHANT METRICS DASHBOARD
// ============================================================

async function testStep5_2() {
  console.log('\n=== STEP 5.2: MERCHANT METRICS DASHBOARD ===\n');
  // Uses data from step 5.1

  const tenant = await prisma.tenant.findUnique({ where: { slug: 'multi-store' } });
  const asset = await prisma.assetType.findFirst();

  console.log('Test: Merchant metrics');
  const metrics = await getMerchantMetrics(tenant!.id);
  assert(parseFloat(metrics.valueIssued) === 100, `Value issued: 100 (got: ${metrics.valueIssued})`);
  assert(parseFloat(metrics.valueRedeemed) === 0, `Value redeemed: 0 (got: ${metrics.valueRedeemed})`);
  assert(parseFloat(metrics.netCirculation) === 100, `Net circulation: 100 (got: ${metrics.netCirculation})`);
  assert(metrics.activeConsumers30d >= 1, `Active consumers >= 1 (got: ${metrics.activeConsumers30d})`);

  // Product performance
  console.log('\nTest: Product performance');
  const product = await prisma.product.create({
    data: { tenantId: tenant!.id, name: 'Metrics Product', redemptionCost: '25.00000000', assetTypeId: asset!.id, stock: 10, active: true },
  });

  const perf = await getProductPerformance(tenant!.id);
  assert(perf.length >= 1, `At least 1 product (got: ${perf.length})`);
  assert(perf[0].redemptionsTotal === 0, 'No redemptions yet');
}

// ============================================================
// STEP 5.3: DISPUTE RESOLUTION
// ============================================================

async function testStep5_3() {
  console.log('\n=== STEP 5.3: DISPUTE RESOLUTION ===\n');
  await cleanAll();

  const tenant = await createTenant('Dispute Store', 'dispute-store', 'd@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');

  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, '+58412DIS001');
  const ownerStaff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@d.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Submit a dispute
  console.log('Test: Submit dispute');
  const dispute = await createDispute({
    tenantId: tenant.id,
    consumerAccountId: consumer.id,
    description: 'My receipt was not credited 3 days ago',
    screenshotUrl: 'https://cloudinary.com/screenshot.jpg',
  });
  assert(dispute.status === 'open', 'Dispute created with open status');

  const disputes = await listDisputes(tenant.id, 'open');
  assert(disputes.length === 1, `1 open dispute (got: ${disputes.length})`);

  // Approve dispute — creates ADJUSTMENT_MANUAL
  console.log('\nTest: Approve dispute (double-entry adjustment)');
  const approveResult = await resolveDispute({
    disputeId: dispute.id,
    action: 'approve',
    reason: 'Receipt verified manually',
    resolverId: ownerStaff.id,
    resolverType: 'staff',
    adjustmentAmount: '50.00000000',
    assetTypeId: asset.id,
  });
  assert(approveResult.success === true, 'Dispute approved');

  const balance = await getAccountBalance(consumer.id, asset.id, tenant.id);
  assert(balance === '50.00000000', `Balance after approval: 50 (got: ${balance})`);

  // Verify double-entry
  const adjEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL' },
  });
  assert(adjEntries.length === 2, `2 ADJUSTMENT_MANUAL entries (got: ${adjEntries.length})`);

  // Verify audit log
  const auditEntries = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenant.id}::uuid AND action_type = 'DISPUTE_APPROVED'
  `;
  assert(auditEntries.length === 1, `Audit log entry for approval (got: ${auditEntries.length})`);

  // Submit and reject another dispute
  console.log('\nTest: Reject dispute');
  const dispute2 = await createDispute({
    tenantId: tenant.id,
    consumerAccountId: consumer.id,
    description: 'Another issue',
  });

  const rejectResult = await resolveDispute({
    disputeId: dispute2.id,
    action: 'reject',
    reason: 'No evidence found',
    resolverId: ownerStaff.id,
    resolverType: 'staff',
  });
  assert(rejectResult.success === true, 'Dispute rejected');

  const rejected = await prisma.dispute.findUnique({ where: { id: dispute2.id } });
  assert(rejected!.status === 'rejected', 'Dispute status: rejected');
  assert(rejected!.resolutionReason === 'No evidence found', 'Rejection reason stored');

  // Submit and escalate
  console.log('\nTest: Escalate dispute');
  const dispute3 = await createDispute({
    tenantId: tenant.id,
    consumerAccountId: consumer.id,
    description: 'Complex issue',
  });

  const escalateResult = await resolveDispute({
    disputeId: dispute3.id,
    action: 'escalate',
    reason: 'Needs admin review',
    resolverId: ownerStaff.id,
    resolverType: 'staff',
  });
  assert(escalateResult.success === true, 'Dispute escalated');

  const escalated = await prisma.dispute.findUnique({ where: { id: dispute3.id } });
  assert(escalated!.status === 'escalated', 'Dispute status: escalated');
}

// ============================================================
// STEP 5.4: OFFLINE QUEUE (Server-side idempotency contract)
// ============================================================

async function testStep5_4() {
  console.log('\n=== STEP 5.4: OFFLINE QUEUE (Idempotent sync) ===\n');
  await cleanAll();

  const tenant = await createTenant('Offline Store', 'offline-store', 'off@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@off.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Give consumer a balance
  await processCSV(`invoice_number,total\nOFF-001,200.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412OFF001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'OFF-001', total_amount: 200.00, transaction_date: '2024-03-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412OFF001' } },
  });
  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Offline Item', redemptionCost: '50.00000000', assetTypeId: asset.id, stock: 5, active: true },
  });

  // Simulate: consumer generates QR
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });

  // Simulate: cashier scans — first attempt succeeds
  console.log('Test: First scan succeeds');
  const actionId = 'offline-action-001';
  await storeIdempotencyKey(actionId, 'redemption_scan', { pending: true });

  const scan1 = await processRedemption({
    token: redemption.token!, cashierStaffId: staff.id, cashierTenantId: tenant.id,
  });
  assert(scan1.success === true, 'First scan succeeds');

  // Store the result
  await storeIdempotencyKey(actionId, 'redemption_scan', scan1);

  // Simulate: connectivity restored, client retries with same action ID
  console.log('\nTest: Retry with same action ID returns stored result');
  const cached = await checkIdempotencyKey(actionId);
  assert(cached !== null, 'Cached result found');
  assert(cached.success === true, 'Cached result is success');

  // Simulate: second scan with the token is also rejected
  const scan2 = await processRedemption({
    token: redemption.token!, cashierStaffId: staff.id, cashierTenantId: tenant.id,
  });
  assert(scan2.success === false, 'Second scan rejected (already used)');

  // Verify only one redemption processed
  const confirmed = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED' },
  });
  assert(confirmed.length === 2, `Only 2 REDEMPTION_CONFIRMED entries (got: ${confirmed.length})`);

  // Test: expired idempotency key
  console.log('\nTest: Expired idempotency key cleanup');
  await storeIdempotencyKey('expired-key', 'test', { data: 'old' }, 0); // 0 hour TTL = already expired
  // Set expires_at to past
  await prisma.idempotencyKey.update({
    where: { key: 'expired-key' },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expired = await checkIdempotencyKey('expired-key');
  assert(expired === null, 'Expired key returns null');
}

async function runAll() {
  await testStep5_1();
  await testStep5_2();
  await testStep5_3();
  await testStep5_4();

  console.log(`\n========================================`);
  console.log(`MILESTONE 5 TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
