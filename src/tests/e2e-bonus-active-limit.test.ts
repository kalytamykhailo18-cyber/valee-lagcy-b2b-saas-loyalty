import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { grantWelcomeBonus } from '../services/welcome-bonus.js';

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
  console.log('=== WELCOME BONUS: active toggle + stock cap ===\n');
  await cleanAll();

  const tenant = await createTenant('Bonus Test', 'bonus-test', 'b@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  await setTenantConversionRate(tenant.id, asset.id, '1.00000000');
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusAmount: 100 } });

  // ──────────────────────────────────
  // 1. Active=true, no limit → bonus granted
  // ──────────────────────────────────
  console.log('1. Active + no limit → bonus granted');
  const c1 = await findOrCreateConsumerAccount(tenant.id, '+584125550001');
  const r1 = await grantWelcomeBonus(c1.account.id, tenant.id, asset.id);
  assert(r1.granted === true, `1st consumer gets bonus (granted=${r1.granted})`);
  assert(parseFloat(r1.amount) === 100, `Amount is 100 (${r1.amount})`);

  // ──────────────────────────────────
  // 2. Active=false → bonus NOT granted (Eric's main ask)
  // ──────────────────────────────────
  console.log('\n2. Active=false → bonus NOT granted, no leak');
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusActive: false } });
  const c2 = await findOrCreateConsumerAccount(tenant.id, '+584125550002');
  const r2 = await grantWelcomeBonus(c2.account.id, tenant.id, asset.id);
  assert(r2.granted === false, `Bonus skipped when active=false (granted=${r2.granted})`);
  const c2Acct = await prisma.account.findUnique({ where: { id: c2.account.id } });
  assert(c2Acct?.welcomeBonusGranted === false, `welcomeBonusGranted flag NOT flipped (consumer can still get the bonus later if merchant re-enables)`);

  // ──────────────────────────────────
  // 3. Re-enable active, set limit=2. First two consumers (one already has it from step 1).
  //    The cap should count the existing WELCOME-* row + 1 new = 2. Third is denied.
  // ──────────────────────────────────
  console.log('\n3. Limit=2, count includes prior grants');
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { welcomeBonusActive: true, welcomeBonusLimit: 2 },
  });
  // c1 already received in step 1. Grant to c3 → should succeed (count=2, limit=2).
  const c3 = await findOrCreateConsumerAccount(tenant.id, '+584125550003');
  const r3 = await grantWelcomeBonus(c3.account.id, tenant.id, asset.id);
  assert(r3.granted === true, `2nd grant within limit (granted=${r3.granted})`);

  // c4 should be denied (count=2 >= limit=2).
  const c4 = await findOrCreateConsumerAccount(tenant.id, '+584125550004');
  const r4 = await grantWelcomeBonus(c4.account.id, tenant.id, asset.id);
  assert(r4.granted === false, `3rd grant denied — cap reached (granted=${r4.granted})`);

  const totalGranted = await prisma.ledgerEntry.count({
    where: { tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL', entryType: 'CREDIT', referenceId: { startsWith: 'WELCOME-' } },
  });
  assert(totalGranted === 2, `Exactly 2 WELCOME entries on the ledger (got ${totalGranted})`);

  // ──────────────────────────────────
  // 4. Bumping limit to 3 lets one more through
  // ──────────────────────────────────
  console.log('\n4. Raise limit → next consumer gets it');
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusLimit: 3 } });
  const r4again = await grantWelcomeBonus(c4.account.id, tenant.id, asset.id);
  assert(r4again.granted === true, `4th consumer now eligible (granted=${r4again.granted})`);

  // ──────────────────────────────────
  // 5. Removing the limit (null) → unbounded
  // ──────────────────────────────────
  console.log('\n5. Limit=null → unbounded');
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusLimit: null } });
  const c5 = await findOrCreateConsumerAccount(tenant.id, '+584125550005');
  const r5 = await grantWelcomeBonus(c5.account.id, tenant.id, asset.id);
  assert(r5.granted === true, `Limit=null, grant proceeds (granted=${r5.granted})`);

  // ──────────────────────────────────
  // 6. Amount=0 still treated as no-bonus (regression check)
  // ──────────────────────────────────
  console.log('\n6. Amount=0 → no grant (legacy behavior preserved)');
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusAmount: 0 } });
  const c6 = await findOrCreateConsumerAccount(tenant.id, '+584125550006');
  const r6 = await grantWelcomeBonus(c6.account.id, tenant.id, asset.id);
  assert(r6.granted === false, `Amount=0 → no grant (granted=${r6.granted})`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
