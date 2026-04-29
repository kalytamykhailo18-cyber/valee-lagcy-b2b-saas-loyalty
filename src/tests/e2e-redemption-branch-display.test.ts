/**
 * Eric 2026-04-26 (item "Transacciones (escaner de canjes y sucursales)"):
 *   After completing a canje with sucursal=Caracas selected at scan time:
 *     - Filtering Transactions by Caracas → no result.
 *     - Filtering by Valencia → no result.
 *     - Filtering by Todas las sucursales → the canje shows but with no
 *       sucursal label.
 *     - Customer panel MOVIMIENTOS shows the canje with no sucursal label.
 *   Root cause: the collapse logic keeps the PENDING leg (consumer's QR
 *   generation context, often null) and hides the CONFIRMED leg (where the
 *   merchant scanned). The per-branch filter and the row badge both read
 *   PENDING.branch_id, so a real Caracas canje was invisible.
 *
 * This test simulates that exact shape (PENDING.branchId=null,
 * CONFIRMED.branchId=Caracas) and proves:
 *   1. Per-branch SQL filter for Caracas now surfaces the row.
 *   2. The surfaced row carries the CONFIRMED leg's branch in its display.
 *   3. The Valencia filter still excludes the row (no false positives).
 *   4. The "_unassigned" filter excludes it (the canje IS assigned, just
 *      via the CONFIRMED leg).
 *   5. The customer-lookup history surfaces branchName for the canje.
 */
import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import Fastify from 'fastify';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { writeDoubleEntry } from '../services/ledger.js';
import { initiateRedemption, processRedemption } from '../services/redemption.js';
import { issueStaffTokens } from '../services/auth.js';
import { registerAnalyticsRoutes } from '../api/routes/merchant/analytics.js';
import { registerCustomersRoutes } from '../api/routes/merchant/customers.js';

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
  console.log('=== E2E: redemption rows show CONFIRMED branch in transactions + customer panel ===\n');
  await cleanAll();

  const tenant = await createTenant('Kromi', 'kromi-trace', 'k@k.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  await setTenantConversionRate(tenant.id, asset.id, '1.00000000');

  const valencia = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Kromi Valencia', address: 'V', active: true },
  });
  const caracas = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Kromi Caracas', address: 'C', active: true },
  });

  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Eric', email: 'e@k.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  const consumer = await findOrCreateConsumerAccount(tenant.id, '+584125559500');
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '5000.00000000', assetTypeId: asset.id,
    referenceId: 'INV-SEED', referenceType: 'invoice',
  });

  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id, name: 'Doritos', redemptionCost: '2000.00000000',
      assetTypeId: asset.id, stock: 5, active: true,
    },
  });

  // 1. Consumer initiates redemption WITHOUT branch context (PENDING.branchId=null).
  console.log('1. Consumer initiates redemption with no branch context');
  const init = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: product.id,
    tenantId: tenant.id, assetTypeId: asset.id, branchId: null,
  });
  assert(init.success, `Init succeeded (msg: "${init.message}")`);
  const pending = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_PENDING', referenceId: `REDEEM-${init.tokenId}` },
  });
  assert(pending?.branchId === null, `PENDING.branchId is null (got ${pending?.branchId})`);

  // 2. Owner scans at Caracas → CONFIRMED.branchId=Caracas.
  console.log('\n2. Owner scans at Caracas → CONFIRMED.branchId=Caracas');
  const scan = await processRedemption({
    token: init.tokenId!, cashierStaffId: owner.id, cashierTenantId: tenant.id,
    branchId: caracas.id,
  });
  assert(scan.success, `Scan succeeded (msg: "${scan.message}")`);
  const confirmed = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED', referenceId: `CONFIRMED-${init.tokenId}`, entryType: 'CREDIT' },
  });
  assert(confirmed?.branchId === caracas.id, `CONFIRMED.branchId === Caracas (got ${confirmed?.branchId})`);

  // 3. Boot a tiny fastify with the analytics + customers routes for live testing.
  const app = Fastify();
  await registerAnalyticsRoutes(app);
  await registerCustomersRoutes(app);
  await app.ready();

  const tokens = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  });
  const auth = `Bearer ${tokens.accessToken}`;

  // ─────────── 3. Per-branch filter for Caracas surfaces the canje ───────────
  console.log('\n3. /api/merchant/transactions?branchId=<Caracas> surfaces the canje');
  const r1 = await app.inject({
    method: 'GET',
    url: `/api/merchant/transactions?branchId=${caracas.id}`,
    headers: { authorization: auth },
  });
  const body1 = r1.json() as any;
  const redemptionRows1 = body1.entries?.filter((e: any) => e.eventType === 'REDEMPTION_CONFIRMED') || [];
  assert(redemptionRows1.length === 1, `Caracas filter surfaces 1 canje (got ${redemptionRows1.length})`);
  if (redemptionRows1.length > 0) {
    assert(redemptionRows1[0].branchId === caracas.id,
      `Surfaced row's branchId is Caracas (got ${redemptionRows1[0].branchId})`);
    assert(redemptionRows1[0].branchName === 'Kromi Caracas',
      `Surfaced row's branchName is Kromi Caracas (got ${redemptionRows1[0].branchName})`);
  }

  // ─────────── 4. Per-branch filter for Valencia excludes the canje ───────────
  console.log('\n4. Valencia filter does NOT surface the canje (no false positives)');
  const r2 = await app.inject({
    method: 'GET',
    url: `/api/merchant/transactions?branchId=${valencia.id}`,
    headers: { authorization: auth },
  });
  const body2 = r2.json() as any;
  const redemptionRows2 = body2.entries?.filter((e: any) => e.eventType === 'REDEMPTION_CONFIRMED') || [];
  assert(redemptionRows2.length === 0, `Valencia filter excludes the canje (got ${redemptionRows2.length})`);

  // ─────────── 5. _unassigned filter excludes it (it IS assigned, via CONFIRMED) ───────────
  console.log('\n5. _unassigned filter excludes the canje');
  const r3 = await app.inject({
    method: 'GET',
    url: `/api/merchant/transactions?branchId=_unassigned`,
    headers: { authorization: auth },
  });
  const body3 = r3.json() as any;
  const redemptionRows3 = body3.entries?.filter((e: any) => e.eventType === 'REDEMPTION_CONFIRMED') || [];
  assert(redemptionRows3.length === 0, `_unassigned filter excludes Caracas-confirmed canje (got ${redemptionRows3.length})`);

  // ─────────── 6. No-filter still surfaces it AND now carries the Caracas label ───────────
  console.log('\n6. No-filter view labels the canje with Caracas (Eric: antes "salia sin donde fue realizado")');
  const r4 = await app.inject({
    method: 'GET',
    url: `/api/merchant/transactions`,
    headers: { authorization: auth },
  });
  const body4 = r4.json() as any;
  const redemptionRows4 = body4.entries?.filter((e: any) => e.eventType === 'REDEMPTION_CONFIRMED') || [];
  assert(redemptionRows4.length === 1, `Unfiltered view shows 1 canje (got ${redemptionRows4.length})`);
  if (redemptionRows4.length > 0) {
    assert(redemptionRows4[0].branchName === 'Kromi Caracas',
      `Unfiltered row labeled Kromi Caracas (got ${redemptionRows4[0].branchName})`);
  }

  // ─────────── 7. Customer panel MOVIMIENTOS surfaces the branchName ───────────
  console.log('\n7. /api/merchant/customer-lookup/:phone returns history with branchName');
  const r5 = await app.inject({
    method: 'GET',
    url: `/api/merchant/customer-lookup/${encodeURIComponent('+584125559500')}`,
    headers: { authorization: auth },
  });
  const body5 = r5.json() as any;
  const pendingInHistory = body5.history?.find((e: any) => e.eventType === 'REDEMPTION_PENDING');
  assert(!!pendingInHistory, `History contains the PENDING row (got ${!!pendingInHistory})`);
  if (pendingInHistory) {
    assert(pendingInHistory.branchId === caracas.id,
      `Customer-panel row's branchId === Caracas (got ${pendingInHistory.branchId})`);
    assert(pendingInHistory.branchName === 'Kromi Caracas',
      `Customer-panel row's branchName === Kromi Caracas (got ${pendingInHistory.branchName})`);
  }

  await app.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
