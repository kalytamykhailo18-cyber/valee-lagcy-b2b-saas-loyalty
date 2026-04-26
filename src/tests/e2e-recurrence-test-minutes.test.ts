import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { runRecurrenceEngine } from '../services/recurrence.js';
import { writeDoubleEntry } from '../services/ledger.js';

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
  console.log('=== RECURRENCE ENGINE: minutes-mode test affordance ===\n');
  await cleanAll();

  const tenant = await createTenant('Test Recurrence', 'test-rec', 'r@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  await setTenantConversionRate(tenant.id, asset.id, '1.00000000');

  // Create a consumer + give them an INVOICE_CLAIMED 6 minutes ago.
  // We backdate the entry by direct UPDATE so the engine sees it as "old enough".
  const consumer = await findOrCreateConsumerAccount(tenant.id, '+584125550999');
  const e1 = await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '10.00000000', assetTypeId: asset.id,
    referenceId: 'TEST-REC-001', referenceType: 'invoice',
  });
  const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_update`;
  await prisma.$executeRaw`UPDATE ledger_entries SET created_at =${sixMinutesAgo}::timestamptz WHERE id IN (${e1.debit.id}::uuid, ${e1.credit.id}::uuid)`;

  // Rule: intervalDays=5, graceDays=0 → in minutes mode = 5 minute threshold
  const rule = await prisma.recurrenceRule.create({
    data: {
      tenantId: tenant.id, name: 'Test Rule', intervalDays: 5, graceDays: 0,
      messageTemplate: 'Hola {name}, han pasado {days} dias desde tu ultima visita.',
      bonusAmount: '5.00000000', active: true,
    },
  });

  // 1. Days mode (production) — consumer visited 6 minutes ago, NOT lapsed by 5 days
  console.log('1. Days mode: consumer NOT lapsed (visited 6 min ago, threshold 5 days)');
  const dayResult = await runRecurrenceEngine({ ruleId: rule.id, thresholdUnit: 'days' });
  assert(dayResult.notified === 0, `0 notified in days mode (got ${dayResult.notified})`);
  assert(dayResult.bonusesGranted === 0, `0 bonuses in days mode (got ${dayResult.bonusesGranted})`);

  // 2. Minutes mode — same threshold (5 minutes), consumer visited 6 min ago → IS lapsed
  console.log('\n2. Minutes mode: consumer IS lapsed (visited 6 min ago, threshold 5 min)');
  const minResult = await runRecurrenceEngine({ ruleId: rule.id, thresholdUnit: 'minutes' });
  assert(minResult.notified === 1, `1 notified in minutes mode (got ${minResult.notified})`);
  assert(minResult.bonusesGranted === 1, `1 bonus granted in minutes mode (got ${minResult.bonusesGranted})`);

  // 3. Re-running minutes mode is idempotent (already-notified consumers are skipped)
  console.log('\n3. Re-run is idempotent (already-notified skipped)');
  const minResult2 = await runRecurrenceEngine({ ruleId: rule.id, thresholdUnit: 'minutes' });
  assert(minResult2.notified === 0, `0 notified on re-run (got ${minResult2.notified})`);
  assert(minResult2.skipped === 1, `1 skipped on re-run (got ${minResult2.skipped})`);

  // 4. ruleId filter only runs the specified rule
  console.log('\n4. ruleId filter scopes the run');
  const otherRule = await prisma.recurrenceRule.create({
    data: {
      tenantId: tenant.id, name: 'Other Rule', intervalDays: 1, graceDays: 0,
      messageTemplate: 'Other message {days}', active: true,
    },
  });
  // Add a fresh consumer + visit so the other rule has a candidate
  const consumer2 = await findOrCreateConsumerAccount(tenant.id, '+584125550888');
  const e2 = await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer2.account.id,
    amount: '5.00000000', assetTypeId: asset.id,
    referenceId: 'TEST-REC-002', referenceType: 'invoice',
  });
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_update`;
  await prisma.$executeRaw`UPDATE ledger_entries SET created_at =${twoMinutesAgo}::timestamptz WHERE id IN (${e2.debit.id}::uuid, ${e2.credit.id}::uuid)`;

  // Run only the OTHER rule. Both consumers are lapsed >1min, so both notify
  // under the OTHER rule. The KEY assertion is that the FIRST rule's
  // notification count is unchanged — proving the ruleId filter scopes the run.
  const scopedResult = await runRecurrenceEngine({ ruleId: otherRule.id, thresholdUnit: 'minutes' });
  assert(scopedResult.notified === 2, `Both consumers notified by otherRule (got ${scopedResult.notified})`);

  // Confirm scoping: first rule's notification count is unchanged after running otherRule.
  const firstRuleNotifs = await prisma.recurrenceNotification.count({
    where: { ruleId: rule.id },
  });
  assert(firstRuleNotifs === 1, `First rule unchanged (got ${firstRuleNotifs}) — ruleId scope works`);
  const otherRuleNotifs = await prisma.recurrenceNotification.count({
    where: { ruleId: otherRule.id },
  });
  assert(otherRuleNotifs === 2, `Other rule has 2 notifications (got ${otherRuleNotifs})`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
