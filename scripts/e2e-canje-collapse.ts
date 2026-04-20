/**
 * E2E: consumer /history collapses the PENDING/CONFIRMED redemption
 * pair into a single 'Producto Canjeado' row (Genesis M6).
 *
 * Before: two rows 'Canje pendiente -10' + 'Canje confirmado +10'.
 * Now: one row for the CONFIRMED debit, relabeled on the frontend to
 * 'Producto Canjeado'. CONFIRMED's credit-side row (which was the
 * reversal of the pending debit) is hidden too.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { issueConsumerTokens } from '../src/services/auth.js';

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Consumer history — PENDING/CONFIRMED collapse E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Canje Collapse ${ts}`, `canje-${ts}`, `canje-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;
  const holding = (await getSystemAccount(tenant.id, 'redemption_holding'))!;

  const phone = `+19000${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);

  // Fund the consumer
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '100', assetTypeId: asset.id,
    referenceId: `SEED-${ts}`, referenceType: 'manual_adjustment',
    metadata: { type: 'test_fund' },
  });

  // Simulate a redemption: PENDING (consumer debit, holding credit)
  const tokenUuid = `00000000-0000-0000-0000-${String(ts).padStart(12, '0').slice(-12)}`;
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_PENDING',
    debitAccountId: consumer.id, creditAccountId: holding.id,
    amount: '10', assetTypeId: asset.id,
    referenceId: `REDEEM-${tokenUuid}`, referenceType: 'redemption_token',
    metadata: { productName: 'yogurt' },
  });

  // Then CONFIRMED (holding debit, pool credit — consumer side has the
  // CONFIRMED credit pair that we hide, since the debit on PENDING
  // already represents the spend)
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_CONFIRMED',
    debitAccountId: holding.id, creditAccountId: consumer.id,
    amount: '10', assetTypeId: asset.id,
    referenceId: `CONFIRMED-${tokenUuid}`, referenceType: 'redemption_token',
    metadata: { productName: 'yogurt' },
  });

  const consumerToken = issueConsumerTokens({
    accountId: consumer.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;
  const res = await fetch(`${API}/api/consumer/history`, {
    headers: { 'Authorization': `Bearer ${consumerToken}` },
  });
  const body: any = await res.json();

  const redemptionEntries = body.entries.filter((e: any) =>
    ['REDEMPTION_PENDING', 'REDEMPTION_CONFIRMED', 'REDEMPTION_EXPIRED'].includes(e.eventType)
    && e.referenceId.endsWith(tokenUuid)
  );
  await assert('only ONE redemption entry surfaces for the confirmed canje',
    redemptionEntries.length === 1,
    `count=${redemptionEntries.length}`);
  await assert('surviving row is REDEMPTION_CONFIRMED',
    redemptionEntries[0]?.eventType === 'REDEMPTION_CONFIRMED',
    `eventType=${redemptionEntries[0]?.eventType}`);
  await assert('surviving row is the DEBIT side (consumer lost points)',
    redemptionEntries[0]?.entryType === 'DEBIT',
    `entryType=${redemptionEntries[0]?.entryType}`);

  // Frontend carries the 'Producto Canjeado' label
  const html = await (await fetch(`${FRONTEND}/consumer`)).text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('consumer chunk labels REDEMPTION_CONFIRMED as "Producto Canjeado"',
    chunkBodies.some(js => js.includes('Producto Canjeado')),
    `scanned=${chunkUrls.length}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
