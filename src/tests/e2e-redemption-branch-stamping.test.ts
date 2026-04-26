import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { writeDoubleEntry } from '../services/ledger.js';
import { initiateRedemption, processRedemption } from '../services/redemption.js';

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
  await prisma.recurrenceNotification.deleteMany(); await prisma.recurrenceRule.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.dispute.deleteMany(); await prisma.redemptionToken.deleteMany();
  await prisma.dualScanSession.deleteMany(); await prisma.staffScanSession.deleteMany();
  await prisma.passwordResetToken.deleteMany();
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
  console.log('=== REDEMPTION: branchId stamping fallbacks ===\n');
  await cleanAll();

  const tenant = await createTenant('Branch Test', 'branch-test', 'b@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  await setTenantConversionRate(tenant.id, asset.id, '1.00000000');

  const branchA = await prisma.branch.create({ data: { tenantId: tenant.id, name: 'PC - Caracas', address: 'Caracas', active: true } });
  const branchB = await prisma.branch.create({ data: { tenantId: tenant.id, name: 'PC - Valencia', address: 'Valencia', active: true } });

  // Owner: not assigned to any branch (this is Eric's situation)
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Eric', email: 'eric@b.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  // Cashier: assigned to branch B
  const cashierB = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Pedro', email: 'pedro@b.com', passwordHash: '$2b$10$x', role: 'cashier', branchId: branchB.id },
  });

  const consumer = await findOrCreateConsumerAccount(tenant.id, '+584125550777');
  // Give consumer some points to redeem
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '1000.00000000', assetTypeId: asset.id,
    referenceId: 'INV-SETUP', referenceType: 'invoice',
  });

  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Cafe Madrid', redemptionCost: '150.00000000', assetTypeId: asset.id, stock: 10, active: true, minLevel: 1 },
  });

  // ──────────────────────────────────
  // 1. Owner scanner with explicit branchId → REDEMPTION_CONFIRMED gets that branchId
  // (This is Eric's exact scenario: owner picks "PC - Caracas" in the scanner)
  // ──────────────────────────────────
  console.log('1. Owner with explicit branchId in scan call');
  const r1 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  assert(r1.success === true, 'Redemption initiated');
  const c1 = await processRedemption({
    token: r1.token!, cashierStaffId: owner.id, cashierTenantId: tenant.id, branchId: branchA.id,
  });
  assert(c1.success === true, 'Owner scan succeeded');
  const conf1 = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED', referenceId: `CONFIRMED-${r1.tokenId}` },
    select: { branchId: true },
  });
  assert(conf1?.branchId === branchA.id, `REDEMPTION_CONFIRMED stamped with branchA (${conf1?.branchId} vs ${branchA.id})`);

  // ──────────────────────────────────
  // 2. Cashier with assigned branch, NO explicit branchId → falls back to staff.branchId
  // ──────────────────────────────────
  console.log('\n2. Cashier with staff.branchId, no explicit override');
  const r2 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  const c2 = await processRedemption({
    token: r2.token!, cashierStaffId: cashierB.id, cashierTenantId: tenant.id,
  });
  assert(c2.success === true, 'Cashier scan succeeded');
  const conf2 = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED', referenceId: `CONFIRMED-${r2.tokenId}` },
    select: { branchId: true },
  });
  assert(conf2?.branchId === branchB.id, `Falls back to cashier's branchB (${conf2?.branchId} vs ${branchB.id})`);

  // ──────────────────────────────────
  // 3. Owner scan with NO explicit branchId → falls back to PENDING entry's branchId
  // (consumer initiated with branchId, owner just confirms)
  // ──────────────────────────────────
  console.log('\n3. No explicit + no staff.branchId → falls back to pending origin branch');
  const r3 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
    branchId: branchA.id,
  });
  const c3 = await processRedemption({
    token: r3.token!, cashierStaffId: owner.id, cashierTenantId: tenant.id,
  });
  assert(c3.success === true, 'Owner scan succeeded');
  const conf3 = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED', referenceId: `CONFIRMED-${r3.tokenId}` },
    select: { branchId: true },
  });
  assert(conf3?.branchId === branchA.id, `Falls back to pending entry's branchA (${conf3?.branchId} vs ${branchA.id})`);

  // ──────────────────────────────────
  // 4. Owner scan, no explicit, no staff.branchId, no pending branch → null (regression baseline)
  // ──────────────────────────────────
  console.log('\n4. Nothing supplied anywhere → null (degenerate case still works)');
  const r4 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  const c4 = await processRedemption({
    token: r4.token!, cashierStaffId: owner.id, cashierTenantId: tenant.id,
  });
  assert(c4.success === true, 'Owner scan succeeded');
  const conf4 = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED', referenceId: `CONFIRMED-${r4.tokenId}` },
    select: { branchId: true },
  });
  assert(conf4?.branchId === null, `Null branchId when nothing available (got ${conf4?.branchId})`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
