/**
 * Eric 2026-04-26 (item "Canje de producto / Panel de Productos"):
 *   A level-1 consumer (zero confirmed claims, first redemption) was able to
 *   redeem a product with minLevel=2 (Galletas Oreo). The catalog filter hides
 *   level-restricted products, but the redeem endpoint and the scan endpoint
 *   never enforced minLevel server-side — a stale catalog cache or a direct
 *   POST bypassed.
 *
 * This test proves both gates are now closed:
 *   1. initiateRedemption rejects when consumer.level < product.minLevel.
 *   2. processRedemption rejects an in-flight QR (e.g. minted before the fix
 *      shipped) when the consumer hasn't earned the level yet.
 *   3. Once the consumer levels up (5+ confirmed INVOICE_CLAIMED), both gates
 *      pass.
 *   4. minLevel=1 (default) products keep working for level-1 consumers.
 */
import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { writeDoubleEntry } from '../services/ledger.js';
import { initiateRedemption, processRedemption } from '../services/redemption.js';
import { checkAndUpdateLevel } from '../services/levels.js';

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
  console.log('=== E2E: product minLevel is enforced at redeem and at scan ===\n');
  await cleanAll();

  const tenant = await createTenant('Kromi', 'kromi-minlevel', 'k@k.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  await setTenantConversionRate(tenant.id, asset.id, '1.00000000');

  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Maria', email: 'm@k.com', passwordHash: '$2b$10$x', role: 'cashier' },
  });

  // Consumer at level 1 (default — no claims yet) with a healthy balance so
  // affordability never dominates the failure mode under test.
  const consumer = await findOrCreateConsumerAccount(tenant.id, '+584125559001');
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '10000.00000000', assetTypeId: asset.id,
    referenceId: 'INV-SEED-LEVEL1', referenceType: 'invoice',
  });
  // The seed credit alone shouldn't be enough to bump level (1 claim < 5).
  await checkAndUpdateLevel(consumer.account.id, tenant.id);
  let acct = await prisma.account.findUnique({ where: { id: consumer.account.id } });
  assert(acct?.level === 1, `Consumer starts at level 1 (got ${acct?.level})`);

  // Galletas Oreo: minLevel=2, in stock, affordable.
  const oreo = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      name: 'Galletas Oreo', redemptionCost: '1500.00000000',
      assetTypeId: asset.id, stock: 5, active: true, minLevel: 2,
    },
  });
  // Cafe: minLevel=1 (default), control product.
  const cafe = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      name: 'Cafe', redemptionCost: '500.00000000',
      assetTypeId: asset.id, stock: 5, active: true, minLevel: 1,
    },
  });

  // 1. initiateRedemption rejects level-1 consumer for level-2 product.
  console.log('1. initiateRedemption rejects level-1 consumer for level-2 product');
  const r1 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: oreo.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  assert(!r1.success, 'Redemption was rejected');
  assert(/nivel 2/i.test(r1.message), `Message names the required level (got: "${r1.message}")`);
  assert(/nivel.*1/i.test(r1.message), `Message names the consumer's current level (got: "${r1.message}")`);

  // 2. No PENDING ledger row was created for the rejected attempt.
  console.log('\n2. Rejected initiation does not write a PENDING ledger row');
  const pendingAfter1 = await prisma.ledgerEntry.count({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_PENDING' },
  });
  assert(pendingAfter1 === 0, `No REDEMPTION_PENDING entries (got ${pendingAfter1})`);

  // 3. Control: same consumer can redeem the level-1 product.
  console.log('\n3. Same consumer CAN redeem the minLevel=1 control product');
  const r2 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: cafe.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  assert(r2.success, `Cafe redemption succeeded (msg: "${r2.message}")`);
  assert(!!r2.tokenId, 'Cafe redemption returned a tokenId');

  // 4. processRedemption rejects an in-flight QR for a level-2 product when
  //    the consumer is still level 1. Simulate by creating a token directly,
  //    bypassing the new initiateRedemption guard (mirrors a QR minted before
  //    this fix shipped).
  console.log('\n4. processRedemption rejects an in-flight level-2 QR for a level-1 consumer');
  const holding = await prisma.account.findFirst({
    where: { tenantId: tenant.id, systemAccountType: 'redemption_holding' },
  });
  const inFlightTokenId = (await import('crypto')).randomUUID();
  const inFlightRef = `REDEEM-${inFlightTokenId}`;
  const inFlightLedger = await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'REDEMPTION_PENDING',
    debitAccountId: consumer.account.id, creditAccountId: holding!.id,
    amount: '1500.00000000', assetTypeId: asset.id,
    referenceId: inFlightRef, referenceType: 'redemption_token',
    metadata: { productId: oreo.id, productName: oreo.name },
  });
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await prisma.redemptionToken.create({
    data: {
      id: inFlightTokenId, tenantId: tenant.id,
      consumerAccountId: consumer.account.id, productId: oreo.id,
      amount: '1500.00000000', assetTypeId: asset.id, status: 'pending',
      tokenSignature: 'unused-uuid-path', shortCode: '999111', expiresAt,
      ledgerPendingEntryId: inFlightLedger.debit.id,
    },
  });
  const scan1 = await processRedemption({
    token: inFlightTokenId, cashierStaffId: cashier.id, cashierTenantId: tenant.id,
  });
  assert(!scan1.success, 'In-flight scan was rejected');
  assert(/nivel 2/i.test(scan1.message), `Scan message names required level (got: "${scan1.message}")`);

  // 5. Token stays pending — the rejection is non-destructive (no audit-log
  //    success, no stock decrement, the consumer can still escalate).
  console.log('\n5. Rejected scan leaves token pending and stock untouched');
  const tokenAfter = await prisma.redemptionToken.findUnique({ where: { id: inFlightTokenId } });
  assert(tokenAfter?.status === 'pending', `Token still pending (got ${tokenAfter?.status})`);
  const oreoAfter = await prisma.product.findUnique({ where: { id: oreo.id } });
  assert(oreoAfter?.stock === 5, `Oreo stock still 5 (got ${oreoAfter?.stock})`);
  const confirmedAfter = await prisma.ledgerEntry.count({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_CONFIRMED' },
  });
  assert(confirmedAfter === 0, `No REDEMPTION_CONFIRMED rows for Oreo (got ${confirmedAfter})`);

  // 6. After the consumer earns level 2 (5 confirmed claims), both gates pass.
  console.log('\n6. After leveling up to 2, redeem + scan both pass');
  for (let i = 1; i <= 4; i++) {
    await writeDoubleEntry({
      tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
      debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
      amount: '100.00000000', assetTypeId: asset.id,
      referenceId: `INV-LEVELUP-${i}`, referenceType: 'invoice',
    });
  }
  await checkAndUpdateLevel(consumer.account.id, tenant.id);
  acct = await prisma.account.findUnique({ where: { id: consumer.account.id } });
  assert(acct?.level === 2, `Consumer now at level 2 (got ${acct?.level})`);

  const r3 = await initiateRedemption({
    consumerAccountId: consumer.account.id, productId: oreo.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  assert(r3.success, `Level-2 redemption succeeded (msg: "${r3.message}")`);
  assert(!!r3.tokenId, 'Level-2 redemption returned a tokenId');

  const scan2 = await processRedemption({
    token: r3.tokenId!, cashierStaffId: cashier.id, cashierTenantId: tenant.id,
  });
  assert(scan2.success, `Level-2 scan succeeded (msg: "${scan2.message}")`);
  assert(scan2.productName === 'Galletas Oreo', `Confirmed product is Galletas Oreo (got ${scan2.productName})`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
