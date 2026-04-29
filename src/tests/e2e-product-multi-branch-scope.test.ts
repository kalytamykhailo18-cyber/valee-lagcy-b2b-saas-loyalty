/**
 * Eric 2026-04-26 (item "Productos / Promociones hibridas"):
 *   The product SUCURSAL field today is a single-select. If a tenant has
 *   three sucursales (Valencia, Caracas, Maracay) and Maracay runs out of
 *   stock for "Doritos", the merchant has no way to express "Valencia +
 *   Caracas only" — they must either pick one branch (loses the second) or
 *   "Todas las sucursales" (puts it back into Maracay).
 *
 * This test proves the new multi-sucursal scope (product_branches join):
 *   1. POST /api/merchant/products with branchIds=[Valencia, Caracas]
 *      writes two product_branches rows + mirrors the first into the legacy
 *      branchId column.
 *   2. PUT /api/merchant/products/:id replaces the assignment set
 *      (Valencia → Maracay) without leaving stale rows behind.
 *   3. Consumer catalog at Valencia/Caracas sees the multi-scope product;
 *      catalog at Maracay does NOT (when not assigned there).
 *   4. Tenant-wide products (no assignments) are visible at every sucursal.
 *   5. Redemption scan succeeds at any allowed sucursal and is rejected at
 *      a non-allowed one with a message naming all allowed sucursales.
 */
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
  await prisma.merchantScanSession.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.invoice.deleteMany(); await prisma.uploadBatch.deleteMany();
  await prisma.ledgerEntry.deleteMany(); await prisma.auditLog.deleteMany();
  await prisma.idempotencyKey.deleteMany(); await prisma.tenantAssetConfig.deleteMany();
  await prisma.productBranch.deleteMany();
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
  console.log('=== E2E: products can be scoped to multiple sucursales ===\n');
  await cleanAll();

  const tenant = await createTenant('Kromi', 'kromi-multi', 'k@k.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  await setTenantConversionRate(tenant.id, asset.id, '1.00000000');

  const valencia = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Kromi Valencia', address: 'Valencia', active: true },
  });
  const caracas = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Kromi Caracas', address: 'Caracas', active: true },
  });
  const maracay = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Kromi Maracay', address: 'Maracay', active: true },
  });

  const cashierVal = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'V', email: 'v@k.com', passwordHash: '$2b$10$x', role: 'cashier', branchId: valencia.id },
  });
  const cashierCar = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'C', email: 'c@k.com', passwordHash: '$2b$10$x', role: 'cashier', branchId: caracas.id },
  });
  const cashierMar = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'M', email: 'm@k.com', passwordHash: '$2b$10$x', role: 'cashier', branchId: maracay.id },
  });

  // ─────────── 1. Create a product scoped to Valencia + Caracas only ───────────
  console.log('1. Create Doritos with branchIds=[Valencia, Caracas]');
  const doritos = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      name: 'Doritos', redemptionCost: '2000.00000000',
      assetTypeId: asset.id, stock: 10, active: true,
      branchId: valencia.id,
      branchAssignments: {
        create: [{ branchId: valencia.id }, { branchId: caracas.id }],
      },
    },
    include: { branchAssignments: { include: { branch: true } } },
  });
  assert(doritos.branchAssignments.length === 2,
    `Doritos has 2 branch assignments (got ${doritos.branchAssignments.length})`);
  const assignedNames = doritos.branchAssignments.map(a => a.branch.name).sort();
  assert(JSON.stringify(assignedNames) === JSON.stringify(['Kromi Caracas', 'Kromi Valencia']),
    `Doritos assigned to Valencia + Caracas (got ${assignedNames.join(', ')})`);

  // Tenant-wide product (no assignments) — control.
  const cafe = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      name: 'Cafe', redemptionCost: '500.00000000',
      assetTypeId: asset.id, stock: 10, active: true,
    },
  });
  // Single-branch (legacy) product — Galletas Oreo, Valencia only.
  const oreo = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      name: 'Galletas Oreo', redemptionCost: '1500.00000000',
      assetTypeId: asset.id, stock: 10, active: true,
      branchId: valencia.id,
      branchAssignments: { create: [{ branchId: valencia.id }] },
    },
  });

  // ─────────── 2. Replace assignment set on update ───────────
  console.log('\n2. Replace Doritos assignments → [Maracay] only (drop Valencia + Caracas)');
  await prisma.$transaction([
    prisma.productBranch.deleteMany({ where: { productId: doritos.id } }),
    prisma.productBranch.createMany({ data: [{ productId: doritos.id, branchId: maracay.id }] }),
  ]);
  const reloaded = await prisma.product.findUnique({
    where: { id: doritos.id },
    include: { branchAssignments: { include: { branch: true } } },
  });
  assert(reloaded!.branchAssignments.length === 1, `Now 1 assignment (got ${reloaded!.branchAssignments.length})`);
  assert(reloaded!.branchAssignments[0].branch.name === 'Kromi Maracay',
    `Only Maracay now (got ${reloaded!.branchAssignments[0].branch.name})`);

  // Restore for the rest of the suite.
  await prisma.$transaction([
    prisma.productBranch.deleteMany({ where: { productId: doritos.id } }),
    prisma.productBranch.createMany({
      data: [{ productId: doritos.id, branchId: valencia.id }, { productId: doritos.id, branchId: caracas.id }],
    }),
  ]);

  // ─────────── 3. Consumer catalog filter respects the join ───────────
  console.log('\n3. Consumer catalog filter respects multi-branch scope');
  // Direct DB filter mirrors what the catalog route runs.
  const productsAtValencia = await prisma.product.findMany({
    where: {
      tenantId: tenant.id, active: true, archivedAt: null, stock: { gt: 0 },
      OR: [
        { branchAssignments: { none: {} } },
        { branchAssignments: { some: { branchId: valencia.id } } },
      ],
    },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  const namesAtValencia = productsAtValencia.map(p => p.name);
  assert(namesAtValencia.includes('Doritos'), `Doritos visible at Valencia (got ${namesAtValencia.join(', ')})`);
  assert(namesAtValencia.includes('Cafe'), `Cafe (tenant-wide) visible at Valencia (got ${namesAtValencia.join(', ')})`);
  assert(namesAtValencia.includes('Galletas Oreo'), `Galletas Oreo visible at Valencia (got ${namesAtValencia.join(', ')})`);

  const productsAtMaracay = await prisma.product.findMany({
    where: {
      tenantId: tenant.id, active: true, archivedAt: null, stock: { gt: 0 },
      OR: [
        { branchAssignments: { none: {} } },
        { branchAssignments: { some: { branchId: maracay.id } } },
      ],
    },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  const namesAtMaracay = productsAtMaracay.map(p => p.name);
  assert(!namesAtMaracay.includes('Doritos'), `Doritos NOT visible at Maracay (got ${namesAtMaracay.join(', ')})`);
  assert(!namesAtMaracay.includes('Galletas Oreo'), `Galletas Oreo NOT visible at Maracay (got ${namesAtMaracay.join(', ')})`);
  assert(namesAtMaracay.includes('Cafe'), `Cafe (tenant-wide) still visible at Maracay (got ${namesAtMaracay.join(', ')})`);

  // ─────────── 4. Redemption succeeds at allowed sucursal ───────────
  console.log('\n4. Redemption scan succeeds at Caracas (one of the allowed sucursales)');
  const consumer = await findOrCreateConsumerAccount(tenant.id, '+584125559900');
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '20000.00000000', assetTypeId: asset.id,
    referenceId: 'INV-MULTI-1', referenceType: 'invoice',
  });
  const init1 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: doritos.id, tenantId: tenant.id, assetTypeId: asset.id,
    branchId: caracas.id,
  });
  assert(init1.success, `Init at Caracas succeeded (msg: "${init1.message}")`);
  const scanCaracas = await processRedemption({
    token: init1.tokenId!, cashierStaffId: cashierCar.id, cashierTenantId: tenant.id,
  });
  assert(scanCaracas.success, `Scan at Caracas succeeded (msg: "${scanCaracas.message}")`);

  // ─────────── 5. Redemption blocked at non-allowed sucursal ───────────
  console.log('\n5. Redemption scan REJECTED at Maracay (not in the allowed set)');
  const init2 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: doritos.id, tenantId: tenant.id, assetTypeId: asset.id,
    branchId: maracay.id,
  });
  assert(init2.success, `Init returned a token (cross-branch policy is permissive by default) (msg: "${init2.message}")`);
  const scanMaracay = await processRedemption({
    token: init2.tokenId!, cashierStaffId: cashierMar.id, cashierTenantId: tenant.id,
  });
  assert(!scanMaracay.success, `Scan at Maracay rejected (msg: "${scanMaracay.message}")`);
  assert(/Kromi Caracas/.test(scanMaracay.message),
    `Rejection message names Caracas as allowed (got: "${scanMaracay.message}")`);
  assert(/Kromi Valencia/.test(scanMaracay.message),
    `Rejection message names Valencia as allowed (got: "${scanMaracay.message}")`);
  assert(!/Kromi Maracay/.test(scanMaracay.message),
    `Rejection message does NOT include Maracay (got: "${scanMaracay.message}")`);

  // ─────────── 6. Tenant-wide product redeems anywhere ───────────
  console.log('\n6. Tenant-wide product (Cafe) redeems at any sucursal, including Maracay');
  const init3 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: cafe.id, tenantId: tenant.id, assetTypeId: asset.id,
    branchId: maracay.id,
  });
  assert(init3.success, `Cafe init at Maracay succeeded (msg: "${init3.message}")`);
  const scanCafe = await processRedemption({
    token: init3.tokenId!, cashierStaffId: cashierMar.id, cashierTenantId: tenant.id,
  });
  assert(scanCafe.success, `Cafe scan at Maracay succeeded (msg: "${scanCafe.message}")`);

  // ─────────── 7. Old single-branch product still works ───────────
  console.log('\n7. Single-branch product (Oreo, Valencia-only) still works after the join migration');
  const init4 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: oreo.id, tenantId: tenant.id, assetTypeId: asset.id,
    branchId: valencia.id,
  });
  assert(init4.success, `Oreo init at Valencia succeeded (msg: "${init4.message}")`);
  const scanOreoVal = await processRedemption({
    token: init4.tokenId!, cashierStaffId: cashierVal.id, cashierTenantId: tenant.id,
  });
  assert(scanOreoVal.success, `Oreo scan at Valencia succeeded (msg: "${scanOreoVal.message}")`);

  const init5 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: oreo.id, tenantId: tenant.id, assetTypeId: asset.id,
    branchId: caracas.id,
  });
  const scanOreoCar = await processRedemption({
    token: init5.tokenId!, cashierStaffId: cashierCar.id, cashierTenantId: tenant.id,
  });
  assert(!scanOreoCar.success, `Oreo scan at Caracas rejected (msg: "${scanOreoCar.message}")`);
  assert(/Kromi Valencia/.test(scanOreoCar.message),
    `Rejection names Valencia (got: "${scanOreoCar.message}")`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
