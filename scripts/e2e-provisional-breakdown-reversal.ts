/**
 * E2E: getAccountBalanceBreakdown correctly removes reversed amounts from
 * the provisional bucket so consumers don't see phantom 'en verificacion'
 * points after a REVERSAL.
 *
 * Eric hit this on Kozmo2 after the Bs→EUR fix: the original 172,327
 * provisional credit was reversed by a confirmed REVERSAL debit, but the
 * breakdown still reported 172,327 as provisional because the original
 * entry's status is 'provisional' (ledger is immutable, status can't be
 * changed). The total was correct but the split was misleading.
 *
 * Scenarios:
 *   A. Provisional credit → display shows it as provisional.
 *   B. REVERSAL on that provisional → display moves to 0 provisional,
 *      and the reversal amount drops out of confirmed too.
 *   C. Total (confirmed + provisional) always equals getAccountBalance.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry, getAccountBalance, getAccountBalanceBreakdown } from '../src/services/ledger.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Provisional breakdown handles REVERSAL E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();

  const tenant = await createTenant(`BrkRev ${ts}`, `brkrev-${ts}`, `brkrev-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;
  const phone = `+19500${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);

  // Step 1: write a provisional credit of 100 pts
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id,
    creditAccountId: consumer.id,
    amount: '100',
    assetTypeId: asset.id,
    referenceId: `PENDING-BRK-${ts}`,
    referenceType: 'invoice',
    status: 'provisional',
    metadata: { seed: 'provisional' },
  });

  // Step 2: write a confirmed welcome-bonus-style credit of 50
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id,
    creditAccountId: consumer.id,
    amount: '50',
    assetTypeId: asset.id,
    referenceId: `WELCOME-BRK-${ts}`,
    referenceType: 'manual_adjustment',
    metadata: { seed: 'confirmed' },
  });

  const b1 = await getAccountBalanceBreakdown(consumer.id, asset.id, tenant.id);
  await assert('A: pre-reversal confirmed = 50',      Number(b1.confirmed) === 50,   `confirmed=${b1.confirmed}`);
  await assert('A: pre-reversal provisional = 100',   Number(b1.provisional) === 100, `provisional=${b1.provisional}`);
  await assert('A: pre-reversal total = 150',         Number(b1.total) === 150,       `total=${b1.total}`);

  const rawBal1 = await getAccountBalance(consumer.id, asset.id, tenant.id);
  await assert('A: breakdown.total matches getAccountBalance',
    Number(rawBal1) === Number(b1.total), `raw=${rawBal1} breakdown.total=${b1.total}`);

  // Step 3: REVERSAL of the provisional — simulates reconciliation timeout
  // or a manual fix. Confirmed event, DEBIT on consumer.
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REVERSAL',
    debitAccountId: consumer.id,
    creditAccountId: pool.id,
    amount: '100',
    assetTypeId: asset.id,
    referenceId: `REVERSAL-BRK-${ts}`,
    referenceType: 'invoice',
    metadata: { seed: 'reversal' },
  });

  const b2 = await getAccountBalanceBreakdown(consumer.id, asset.id, tenant.id);
  await assert('B: reversed provisional drops to 0', Number(b2.provisional) === 0,
    `provisional=${b2.provisional}`);
  await assert('B: confirmed stays at 50 (reversal not counted there)', Number(b2.confirmed) === 50,
    `confirmed=${b2.confirmed}`);
  await assert('B: total = 50 (net after reversal)', Number(b2.total) === 50,
    `total=${b2.total}`);

  const rawBal2 = await getAccountBalance(consumer.id, asset.id, tenant.id);
  await assert('B: breakdown.total still matches getAccountBalance',
    Number(rawBal2) === Number(b2.total),
    `raw=${rawBal2} breakdown.total=${b2.total}`);

  // Step 4: write a fresh provisional credit — must show up as provisional,
  // not double-counted with the reversal.
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id,
    creditAccountId: consumer.id,
    amount: '25',
    assetTypeId: asset.id,
    referenceId: `PENDING2-BRK-${ts}`,
    referenceType: 'invoice',
    status: 'provisional',
    metadata: { seed: 'provisional2' },
  });

  const b3 = await getAccountBalanceBreakdown(consumer.id, asset.id, tenant.id);
  await assert('C: new provisional credit shows up',  Number(b3.provisional) === 25, `provisional=${b3.provisional}`);
  await assert('C: confirmed unaffected',              Number(b3.confirmed) === 50,   `confirmed=${b3.confirmed}`);
  await assert('C: total = 50 + 25 = 75',              Number(b3.total) === 75,       `total=${b3.total}`);

  const rawBal3 = await getAccountBalance(consumer.id, asset.id, tenant.id);
  await assert('C: breakdown.total matches getAccountBalance',
    Number(rawBal3) === Number(b3.total), `raw=${rawBal3}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
