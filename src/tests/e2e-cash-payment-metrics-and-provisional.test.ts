/**
 * Eric 2026-04-27 (item "Pagos en efectivo"):
 *   1. Cash payments (PRESENCE_VALIDATED CREDIT) were invisible in EMITIDO
 *      and CIRCULACION. He saw 12.000 pts in transactions but EMITIDO=5.000
 *      and CIRCULACION=0.
 *   2. The EMITIDO breakdown card had no "Efectivo" line — only Facturas /
 *      Bienvenidas / Referidos / Manuales.
 *   3. Cash entries should be PROVISIONAL until validated (CSV / POS).
 *      Currently they wrote with status=confirmed.
 *
 * This test proves all three: metrics include cash in valueIssued + cash bucket
 * + circulation, the new dual-scan ledger row lands as status=provisional, and
 * the consumer-facing message labels it as "(en verificacion)".
 */
import dotenv from 'dotenv'; dotenv.config();
import { readFileSync } from 'fs';
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { initiateDualScan, confirmDualScan } from '../services/dual-scan.js';
import { getMerchantMetrics } from '../services/metrics.js';

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
  console.log('=== E2E: cash payments visible in metrics + provisional + Efectivo line ===\n');
  await cleanAll();

  const tenant = await createTenant('Restaurante', 'rest-cash', 'r@r.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1');
  await setTenantConversionRate(tenant.id, asset.id, '100');

  const valencia = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Valencia', address: 'V', active: true },
  });

  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Mesonero', email: 'm@r.com', passwordHash: '$2b$10$x', role: 'cashier', branchId: valencia.id },
  });

  // ─────────── 1. Two dual-scan cash payments ───────────
  console.log('1. Cashier rings up two dual-scan transactions ($100 + $20)');
  const a = await initiateDualScan({
    tenantId: tenant.id, cashierId: cashier.id, branchId: valencia.id,
    amount: '100', assetTypeId: asset.id,
  });
  const b = await initiateDualScan({
    tenantId: tenant.id, cashierId: cashier.id, branchId: valencia.id,
    amount: '20', assetTypeId: asset.id,
  });
  assert(a.success && b.success, 'Both initiations succeeded');

  const ca = await confirmDualScan({ token: a.token!, consumerPhone: '+584125550700' });
  const cb = await confirmDualScan({ token: b.token!, consumerPhone: '+584125550700' });
  assert(ca.success && cb.success, 'Both consumer confirmations succeeded');
  assert(/en verificacion/i.test(ca.message),
    `Confirmation message labels "(en verificacion)" (got: "${ca.message}")`);
  assert(/Te confirmamos cuando se valide/.test(ca.message),
    `Message tells the customer it will be confirmed (got: "${ca.message}")`);

  // ─────────── 2. Ledger rows are PROVISIONAL ───────────
  console.log('\n2. PRESENCE_VALIDATED rows land as status=provisional');
  const cashRows = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'PRESENCE_VALIDATED', entryType: 'CREDIT' },
    select: { status: true, amount: true, branchId: true },
    orderBy: { createdAt: 'asc' },
  });
  assert(cashRows.length === 2, `2 cash credits in ledger (got ${cashRows.length})`);
  assert(cashRows.every(r => r.status === 'provisional'),
    `All cash credits provisional (got ${cashRows.map(r => r.status).join(',')})`);
  assert(cashRows.every(r => r.branchId === valencia.id),
    `All cash credits stamped with Valencia branch`);

  // ─────────── 3. Metrics include cash in valueIssued + cash bucket ───────────
  console.log('\n3. Tenant aggregate metrics include cash in EMITIDO + Efectivo bucket');
  const metricsAll = await getMerchantMetrics(tenant.id);
  // 100 USD + 20 USD = 120 → multiplier 100 → 12.000 puntos
  assert(parseFloat(metricsAll.valueIssuedCash) === 12000,
    `valueIssuedCash = 12.000 puntos (got ${metricsAll.valueIssuedCash})`);
  assert(parseFloat(metricsAll.valueIssuedInvoices) === 0,
    `valueIssuedInvoices = 0 (got ${metricsAll.valueIssuedInvoices})`);
  assert(parseFloat(metricsAll.valueIssued) === 12000,
    `valueIssued total includes cash (got ${metricsAll.valueIssued})`);

  // ─────────── 4. CIRCULACION reflects unredeemed cash ───────────
  console.log('\n4. CIRCULACION (netCirculation) reflects unredeemed cash');
  assert(parseFloat(metricsAll.netCirculation) === 12000,
    `netCirculation = 12.000 (no canjes yet) (got ${metricsAll.netCirculation})`);

  // ─────────── 5. Per-branch metrics: Valencia carries the cash ───────────
  console.log('\n5. Per-branch metrics attribute cash to the right sucursal');
  const metricsValencia = await getMerchantMetrics(tenant.id, valencia.id);
  assert(parseFloat(metricsValencia.valueIssuedCash) === 12000,
    `Valencia valueIssuedCash = 12.000 (got ${metricsValencia.valueIssuedCash})`);
  assert(parseFloat(metricsValencia.valueIssued) === 12000,
    `Valencia valueIssued = 12.000 (got ${metricsValencia.valueIssued})`);

  // ─────────── 6. _unassigned slice carries orphan cash if any ───────────
  console.log('\n6. _unassigned slice surfaces orphan cash');
  // Simulate one cash payment with no branch (legacy / pre-fix flow).
  const c = await initiateDualScan({
    tenantId: tenant.id, cashierId: cashier.id, branchId: null,
    amount: '5', assetTypeId: asset.id,
  });
  await confirmDualScan({ token: c.token!, consumerPhone: '+584125550701' });
  const metricsUnassigned = await getMerchantMetrics(tenant.id, '_unassigned');
  assert(parseFloat(metricsUnassigned.valueIssuedCash) === 500,
    `_unassigned valueIssuedCash = 500 (5 USD * 100) (got ${metricsUnassigned.valueIssuedCash})`);
  assert(parseFloat(metricsUnassigned.valueIssued) === 500,
    `_unassigned valueIssued = 500 (got ${metricsUnassigned.valueIssued})`);

  const metricsAll2 = await getMerchantMetrics(tenant.id);
  assert(parseFloat(metricsAll2.valueIssuedUnassigned!) === 500,
    `Aggregate exposes valueIssuedUnassigned = 500 (got ${metricsAll2.valueIssuedUnassigned})`);
  assert(parseFloat(metricsAll2.valueIssuedCash) === 12500,
    `Aggregate valueIssuedCash sums everything (got ${metricsAll2.valueIssuedCash})`);

  // ─────────── 7. Frontend renders the Efectivo line ───────────
  console.log('\n7. Frontend EMITIDO breakdown includes Efectivo line');
  const src = readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/page.tsx', 'utf-8');
  assert(/<span>Efectivo<\/span>[\s\S]{0,80}metrics\.valueIssuedCash/.test(src),
    'EMITIDO card renders <span>Efectivo</span> bound to valueIssuedCash');
  assert(/<span>Facturas<\/span>[\s\S]{0,200}<span>Efectivo<\/span>/.test(src),
    'Efectivo line sits next to Facturas (cash-source pair)');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
