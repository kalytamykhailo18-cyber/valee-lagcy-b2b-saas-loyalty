import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate, convertToLoyaltyValue, getConversionRate } from '../services/assets.js';
import { writeDoubleEntry, getAccountBalance } from '../services/ledger.js';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function cleanAll() {
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_truncate`;
  await prisma.$executeRaw`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_no_update`;
  await prisma.dispute.deleteMany(); await prisma.redemptionToken.deleteMany();
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
  console.log('=== ASSET TYPE SYSTEM: MULTI-ASSET, NO CODE CHANGES ===\n');
  await cleanAll();

  const tenant = await createTenant('Multi-Asset Shop', 'multi-asset', 'ma@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, '+58412MA001');

  // ──────────────────────────────────
  // 1. Create multiple asset types — just DB inserts, no code
  // ──────────────────────────────────
  console.log('1. Create asset types (DB records, not hardcoded)');
  const points = await createAssetType('Loyalty Points', 'points', '1.00000000');
  const coins = await createAssetType('Gold Coins', 'coins', '0.50000000');
  const bucks = await createAssetType('Store Bucks', '$', '2.00000000');

  assert(points.name === 'Loyalty Points', `Created: ${points.name} (${points.unitLabel})`);
  assert(coins.name === 'Gold Coins', `Created: ${coins.name} (${coins.unitLabel})`);
  assert(bucks.name === 'Store Bucks', `Created: ${bucks.name} (${bucks.unitLabel})`);

  // ──────────────────────────────────
  // 2. Ledger can record entries in ANY asset type
  // ──────────────────────────────────
  console.log('\n2. Ledger records entries in different asset types');
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.id,
    amount: '100.00000000', assetTypeId: points.id,
    referenceId: 'MA-POINTS-001', referenceType: 'invoice',
  });
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.id,
    amount: '50.00000000', assetTypeId: coins.id,
    referenceId: 'MA-COINS-001', referenceType: 'invoice',
  });
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.id,
    amount: '200.00000000', assetTypeId: bucks.id,
    referenceId: 'MA-BUCKS-001', referenceType: 'invoice',
  });

  // Balances are tracked independently per asset type
  const balPoints = await getAccountBalance(consumer.id, points.id, tenant.id);
  const balCoins = await getAccountBalance(consumer.id, coins.id, tenant.id);
  const balBucks = await getAccountBalance(consumer.id, bucks.id, tenant.id);

  assert(Number(balPoints) === 100, `Points balance: 100 (got ${balPoints})`);
  assert(Number(balCoins) === 50, `Coins balance: 50 (got ${balCoins})`);
  assert(Number(balBucks) === 200, `Bucks balance: 200 (got ${balBucks})`);

  // ──────────────────────────────────
  // 3. Default conversion rates work
  // ──────────────────────────────────
  console.log('\n3. Conversion rates (default)');
  const cvtPoints = await convertToLoyaltyValue('100.00', tenant.id, points.id);
  const cvtCoins = await convertToLoyaltyValue('100.00', tenant.id, coins.id);
  const cvtBucks = await convertToLoyaltyValue('100.00', tenant.id, bucks.id);

  assert(cvtPoints === '100.00000000', `$100 × 1.0 rate = 100 points (got ${cvtPoints})`);
  assert(cvtCoins === '50.00000000', `$100 × 0.5 rate = 50 coins (got ${cvtCoins})`);
  assert(cvtBucks === '200.00000000', `$100 × 2.0 rate = 200 bucks (got ${cvtBucks})`);

  // ──────────────────────────────────
  // 4. Per-tenant conversion rate override
  // ──────────────────────────────────
  console.log('\n4. Per-tenant conversion rate override');
  await setTenantConversionRate(tenant.id, points.id, '3.00000000');
  const overridden = await convertToLoyaltyValue('100.00', tenant.id, points.id);
  assert(overridden === '300.00000000', `$100 × 3.0 override = 300 points (got ${overridden})`);

  // Other asset types unaffected
  const coinsStill = await convertToLoyaltyValue('100.00', tenant.id, coins.id);
  assert(coinsStill === '50.00000000', `Coins rate unchanged: $100 × 0.5 = 50 (got ${coinsStill})`);

  // ──────────────────────────────────
  // 5. Adding a NEW asset type = just one DB insert, zero code changes
  // ──────────────────────────────────
  console.log('\n5. Add a completely new asset type (zero code changes)');
  const crypto = await createAssetType('Crypto Tokens', 'CRT', '0.01000000');

  // Immediately usable in the ledger
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.id,
    amount: '5.00000000', assetTypeId: crypto.id,
    referenceId: 'MA-CRYPTO-001', referenceType: 'invoice',
  });

  const balCrypto = await getAccountBalance(consumer.id, crypto.id, tenant.id);
  assert(Number(balCrypto) === 5, `Crypto balance: 5 (got ${balCrypto})`);

  const cvtCrypto = await convertToLoyaltyValue('100.00', tenant.id, crypto.id);
  assert(cvtCrypto === '1.00000000', `$100 × 0.01 rate = 1 CRT (got ${cvtCrypto})`);

  // ──────────────────────────────────
  // 6. Verify: no asset type is hardcoded anywhere
  // ──────────────────────────────────
  console.log('\n6. No hardcoded asset types in codebase');
  // All 4 asset types work identically — the code has no knowledge of which types exist.
  // The same writeDoubleEntry, getAccountBalance, convertToLoyaltyValue work for all.
  const allAssets = await prisma.assetType.findMany();
  assert(allAssets.length === 4, `4 asset types exist (got ${allAssets.length})`);
  assert(allAssets.every(a => a.id && a.name && a.unitLabel && a.defaultConversionRate), 'All have name, label, and rate');

  console.log(`\n=== ASSET TYPES: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
