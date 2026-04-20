/**
 * E2E: recurrence engine picks lapsed customers, grants the right bonus,
 * is idempotent, and respects the optional targetPhones filter.
 *
 * Scenarios:
 *   A. 3 consumers with interval=7d, grace=0d, bonus=25:
 *      - lapsed   (last visit 14d ago) → MUST be notified + granted bonus
 *      - recent   (last visit 3d ago)  → MUST NOT be notified
 *      - no-visit (never had a visit)  → MUST NOT be notified
 *   B. runRecurrenceEngine() twice — second run MUST skip the already-notified
 *      consumer (no duplicate bonus, no duplicate notification row).
 *   C. targetPhones filter: rule with targetPhones=[only lapsedA] in a fresh
 *      tenant with two lapsed consumers — only the phone in the list is
 *      notified.
 *
 * WhatsApp send is best-effort: the engine records the notification and
 * grants the bonus even when Meta refuses the number, so we can test the
 * flow end-to-end with fake +19999xxxxxxx phones that Meta will reject.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry, getAccountBalance } from '../src/services/ledger.js';
import { runRecurrenceEngine } from '../src/services/recurrence.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function seedVisit(tenantId: string, accountId: string, assetTypeId: string, daysAgo: number, invoiceNumber: string) {
  const pool = await getSystemAccount(tenantId, 'issued_value_pool');
  if (!pool) throw new Error('pool missing');
  const visitDate = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  // The ledger immutability trigger blocks UPDATE, so we can't back-date
  // after write. INSERT is permitted, so we raw-insert both sides of the
  // double entry with a historic created_at. Hashes are throwaway (the
  // recurrence query only cares about created_at + event_type), and the
  // hash-chain checker is not in scope here — it's verified independently.
  const refId = `RECUR-SEED-${invoiceNumber}`;
  await prisma.$executeRaw`
    INSERT INTO ledger_entries (id, tenant_id, event_type, entry_type, account_id, amount, asset_type_id, reference_id, reference_type, metadata, status, prev_hash, hash, created_at)
    VALUES
      (gen_random_uuid(), ${tenantId}::uuid, 'INVOICE_CLAIMED', 'DEBIT',  ${pool.id}::uuid,    10, ${assetTypeId}::uuid, ${refId}, 'invoice', ${JSON.stringify({ seed: true })}::jsonb, 'confirmed'::"LedgerStatus", ${'ee'.repeat(32)}, ${'dd'.repeat(32)}, ${visitDate}),
      (gen_random_uuid(), ${tenantId}::uuid, 'INVOICE_CLAIMED', 'CREDIT', ${accountId}::uuid, 10, ${assetTypeId}::uuid, ${refId}, 'invoice', ${JSON.stringify({ seed: true })}::jsonb, 'confirmed'::"LedgerStatus", ${'ee'.repeat(32)}, ${'cc'.repeat(32)}, ${visitDate})
  `;
}

async function main() {
  console.log('=== Recurrence engine E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();

  // ── Scenario A + B: fresh tenant, one rule, three consumers ──
  const tenant = await createTenant(`Recur ${ts}`, `recur-${ts}`, `recur-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const phoneLapsed = `+19999${String(ts).slice(-7)}1`;
  const phoneRecent = `+19999${String(ts).slice(-7)}2`;
  const phoneNoVisit = `+19999${String(ts).slice(-7)}3`;
  const { account: lapsed  } = await findOrCreateConsumerAccount(tenant.id, phoneLapsed);
  const { account: recent  } = await findOrCreateConsumerAccount(tenant.id, phoneRecent);
  const { account: novisit } = await findOrCreateConsumerAccount(tenant.id, phoneNoVisit);

  await seedVisit(tenant.id, lapsed.id,  asset.id, 14, `lapsed-${ts}`);
  await seedVisit(tenant.id, recent.id,  asset.id, 3,  `recent-${ts}`);
  // novisit: no visit seeded

  const BONUS = 25;
  await prisma.recurrenceRule.create({
    data: {
      tenantId: tenant.id,
      name: 'E2E rule',
      intervalDays: 7,
      graceDays: 0,
      messageTemplate: 'Hola {name}, hace {days} dias no vienes. Tienes {bonus} puntos esperandote.',
      bonusAmount: BONUS,
      active: true,
    },
  });

  const run1 = await runRecurrenceEngine();
  await assert('first run: notified includes only the lapsed consumer', run1.notified === 1,
    `notified=${run1.notified}`);
  await assert('first run: exactly one bonus granted', run1.bonusesGranted === 1,
    `bonusesGranted=${run1.bonusesGranted}`);

  // Balance of lapsed consumer now equals the bonus (they had 10 pts from the
  // seed visit + 25 from the recurrence bonus = 35).
  const lapsedBal = await getAccountBalance(lapsed.id, asset.id, tenant.id);
  await assert('lapsed consumer balance = seed (10) + bonus (25) = 35', Number(lapsedBal) === 35,
    `balance=${lapsedBal}`);

  // Notifications: one row for lapsed
  const notifs = await prisma.recurrenceNotification.findMany({
    where: { tenantId: tenant.id },
  });
  await assert('exactly one recurrence_notifications row', notifs.length === 1,
    `count=${notifs.length}`);
  await assert('notification is for the lapsed consumer', notifs[0]?.consumerAccountId === lapsed.id,
    `accountId=${notifs[0]?.consumerAccountId.slice(0,8)}`);
  await assert('notification.bonusGranted = true', notifs[0]?.bonusGranted === true,
    `bonusGranted=${notifs[0]?.bonusGranted}`);

  // Recent + no-visit must NOT have been notified
  const recentBal  = await getAccountBalance(recent.id,  asset.id, tenant.id);
  const novisitBal = await getAccountBalance(novisit.id, asset.id, tenant.id);
  await assert('recent consumer balance = seed (10) only (no bonus)', Number(recentBal) === 10,
    `balance=${recentBal}`);
  await assert('no-visit consumer balance = 0 (no bonus)', Number(novisitBal) === 0,
    `balance=${novisitBal}`);

  // ── Scenario B: rerun → skip ──
  const run2 = await runRecurrenceEngine();
  // skipped counts the lapsed consumer this time (already notified); other
  // tenants may also contribute, so assert >= 1 rather than exact.
  await assert('second run: lapsed consumer is skipped', run2.skipped >= 1 && run2.notified === 0,
    `notified=${run2.notified} skipped=${run2.skipped}`);

  const lapsedBalAfter = await getAccountBalance(lapsed.id, asset.id, tenant.id);
  await assert('second run: no duplicate bonus', Number(lapsedBalAfter) === 35,
    `balance=${lapsedBalAfter}`);

  const notifsAfter = await prisma.recurrenceNotification.count({
    where: { tenantId: tenant.id },
  });
  await assert('still exactly one notification row', notifsAfter === 1, `count=${notifsAfter}`);

  // ── Scenario C: targetPhones filter ──
  const tenantC = await createTenant(`Recur Target ${ts}`, `recur-target-${ts}`, `recur-target-${ts}@e2e.local`);
  await createSystemAccounts(tenantC.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenantC.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const phoneA = `+19998${String(ts).slice(-7)}1`;
  const phoneB = `+19998${String(ts).slice(-7)}2`;
  const { account: accA } = await findOrCreateConsumerAccount(tenantC.id, phoneA);
  const { account: accB } = await findOrCreateConsumerAccount(tenantC.id, phoneB);
  await seedVisit(tenantC.id, accA.id, asset.id, 14, `targA-${ts}`);
  await seedVisit(tenantC.id, accB.id, asset.id, 14, `targB-${ts}`);

  await prisma.recurrenceRule.create({
    data: {
      tenantId: tenantC.id,
      name: 'E2E targeted rule',
      intervalDays: 7,
      graceDays: 0,
      messageTemplate: 'Volve a vernos',
      bonusAmount: BONUS,
      active: true,
      targetPhones: [phoneA], // only this one
    },
  });

  const runC = await runRecurrenceEngine();
  // Tenant C contributes 1 notified. Other tenants may contribute skips, so
  // we verify by counting notifications in tenant C specifically.
  const cNotifs = await prisma.recurrenceNotification.findMany({
    where: { tenantId: tenantC.id },
  });
  await assert('targetPhones filter: exactly one notification in tenant C', cNotifs.length === 1,
    `count=${cNotifs.length}`);
  await assert('targetPhones filter: only phoneA was notified',
    cNotifs[0]?.consumerAccountId === accA.id,
    `notified=${cNotifs[0]?.consumerAccountId.slice(0,8)} expected=${accA.id.slice(0,8)}`);

  const balA = await getAccountBalance(accA.id, asset.id, tenantC.id);
  const balB = await getAccountBalance(accB.id, asset.id, tenantC.id);
  await assert('targeted consumer got the bonus', Number(balA) === 35, `balance=${balA}`);
  await assert('untargeted consumer did not get the bonus', Number(balB) === 10, `balance=${balB}`);

  // Tenant-C run accounted for the 1 notification we asserted above.
  await assert('overall runC.notified >= 1', runC.notified >= 1, `notified=${runC.notified}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
