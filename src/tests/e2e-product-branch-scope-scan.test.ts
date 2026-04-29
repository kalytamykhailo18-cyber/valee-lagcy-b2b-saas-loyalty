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
  console.log('=== E2E: branch-scoped product cannot be redeemed at the wrong sucursal ===\n');
  await cleanAll();

  // Eric 2026-04-26: he created "Galletas Oreo" scoped to Kromi Valencia, then a
  // cashier in Kromi Caracas approved the redemption manually with a 6-digit
  // code. The scanner had Caracas selected; the server should have rejected.
  const tenant = await createTenant('Kromi', 'kromi-scope', 'k@k.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  await setTenantConversionRate(tenant.id, asset.id, '1.00000000');

  const valencia = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Kromi Valencia', address: 'Valencia', active: true },
  });
  const caracas = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Kromi Caracas', address: 'Caracas', active: true },
  });

  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Eric', email: 'eric@k.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  // Cashier locked to Caracas (the wrong-sucursal scenario in Eric's report).
  const cashierCaracas = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Pedro', email: 'pedro@k.com', passwordHash: '$2b$10$x', role: 'cashier', branchId: caracas.id },
  });
  // Cashier locked to Valencia (the correct sucursal).
  const cashierValencia = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Maria', email: 'maria@k.com', passwordHash: '$2b$10$x', role: 'cashier', branchId: valencia.id },
  });

  const consumer = await findOrCreateConsumerAccount(tenant.id, '+584125557777');
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '10000.00000000', assetTypeId: asset.id,
    referenceId: 'INV-SETUP', referenceType: 'invoice',
  });

  // Galletas Oreo is locked to Valencia.
  const oreo = await prisma.product.create({
    data: {
      tenantId: tenant.id, branchId: valencia.id,
      name: 'Galletas Oreo', redemptionCost: '1500.00000000',
      assetTypeId: asset.id, stock: 5, active: true, minLevel: 2,
    },
  });
  // A globally-available product as a control (no branchId).
  const cafe = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      name: 'Cafe Cualquier Sucursal', redemptionCost: '500.00000000',
      assetTypeId: asset.id, stock: 5, active: true, minLevel: 1,
    },
  });

  // 1. Owner scanner with explicit Caracas branch → reject with named branch.
  console.log('1. Owner picks Caracas in scanner; product is Valencia-only → reject');
  const r1 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: oreo.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  assert(r1.success === true, 'Initiate succeeded');
  const c1 = await processRedemption({
    token: r1.token!, cashierStaffId: owner.id, cashierTenantId: tenant.id, branchId: caracas.id,
  });
  assert(c1.success === false, 'Wrong-branch scan rejected');
  assert(/Valencia/i.test(c1.message), `Error names the correct branch (got: "${c1.message}")`);
  // Token must remain pending so the customer can retry at Valencia.
  const tk1 = await prisma.redemptionToken.findUnique({ where: { id: r1.tokenId! } });
  assert(tk1?.status === 'pending', `Token still pending after wrong-branch reject (got ${tk1?.status})`);

  // 2. Caracas-locked cashier (no explicit branch override) → reject too.
  console.log('\n2. Caracas-locked cashier scans Valencia-only product → reject');
  const c2 = await processRedemption({
    token: r1.token!, cashierStaffId: cashierCaracas.id, cashierTenantId: tenant.id,
  });
  assert(c2.success === false, 'Wrong-branch cashier rejected via staff.branchId fallback');

  // 3. Valencia-locked cashier scans → success.
  console.log('\n3. Valencia-locked cashier scans Valencia-only product → success');
  const c3 = await processRedemption({
    token: r1.token!, cashierStaffId: cashierValencia.id, cashierTenantId: tenant.id,
  });
  assert(c3.success === true, `Right-branch scan succeeded (msg: "${c3.message}")`);
  const tk3 = await prisma.redemptionToken.findUnique({ where: { id: r1.tokenId! } });
  assert(tk3?.status === 'used', 'Token marked used');

  // 4. Owner scanner with explicit Valencia branch on a fresh QR → success.
  console.log('\n4. Owner picks Valencia in scanner → success');
  const r4 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: oreo.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  const c4 = await processRedemption({
    token: r4.token!, cashierStaffId: owner.id, cashierTenantId: tenant.id, branchId: valencia.id,
  });
  assert(c4.success === true, `Owner+Valencia scan succeeded (msg: "${c4.message}")`);

  // 5. Owner with NO branch context anywhere → reject (server can't verify).
  console.log('\n5. Owner with no branch anywhere → reject (cannot verify)');
  const r5 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: oreo.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  const c5 = await processRedemption({
    token: r5.token!, cashierStaffId: owner.id, cashierTenantId: tenant.id,
  });
  assert(c5.success === false, 'No-branch owner scan rejected');
  assert(/Selecciona la sucursal/i.test(c5.message), `Error tells the cashier to pick a sucursal (got: "${c5.message}")`);

  // 6. Globally-scoped product still works at any branch (control).
  console.log('\n6. Global product (no branchId) still works at Caracas');
  const r6 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: cafe.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  const c6 = await processRedemption({
    token: r6.token!, cashierStaffId: cashierCaracas.id, cashierTenantId: tenant.id,
  });
  assert(c6.success === true, `Global product redeems at Caracas (msg: "${c6.message}")`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
