/**
 * E2E: expired/cancelled redemption tokens vanish from history on
 * both consumer and merchant views (Genesis M6 Re Do deeper cut).
 *
 * Before: a PENDING that expired or was cancelled left two rows —
 * 'Canje pendiente -10' and 'Canje expirado +10' — for a net-zero
 * event. That's visual noise; if the points came back in full the
 * consumer shouldn't see two rows, and the merchant log shouldn't
 * be cluttered with cancelled canjes either.
 *
 * After: when the token has an EXPIRED event (and no CONFIRMED),
 * both legs are hidden on both endpoints. Confirmed canjes still
 * collapse into one relabeled row. Unresolved PENDING (still
 * in-flight, no terminal event) stays visible as 'Canje pendiente'.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { issueConsumerTokens, issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Expired redemption collapse E2E (Genesis M6 Re Do) ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`ExpCollapse ${ts}`, `ec-${ts}`, `ec-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;
  const holding = (await getSystemAccount(tenant.id, 'redemption_holding'))!;

  const phone = `+19000${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);
  await prisma.account.update({ where: { id: consumer.id }, data: { displayName: 'Genesis Test' } });

  // Fund consumer so subsequent debits don't overdraw.
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '500', assetTypeId: asset.id,
    referenceId: `SEED-${ts}`, referenceType: 'manual_adjustment',
    metadata: { type: 'test_fund' },
  });

  // Token A: confirmed redemption (PENDING + CONFIRMED)
  const tokenA = randomUUID();
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_PENDING',
    debitAccountId: consumer.id, creditAccountId: holding.id,
    amount: '30', assetTypeId: asset.id,
    referenceId: `REDEEM-${tokenA}`, referenceType: 'redemption_token',
    metadata: { productId: 'a', productName: 'Yogurt confirmado' },
  });
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_CONFIRMED',
    debitAccountId: holding.id, creditAccountId: pool.id,
    amount: '30', assetTypeId: asset.id,
    referenceId: `CONFIRMED-${tokenA}`, referenceType: 'redemption_token',
    metadata: { productId: 'a', productName: 'Yogurt confirmado' },
  });

  // Token B: expired redemption (PENDING + EXPIRED)
  const tokenB = randomUUID();
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_PENDING',
    debitAccountId: consumer.id, creditAccountId: holding.id,
    amount: '25', assetTypeId: asset.id,
    referenceId: `REDEEM-${tokenB}`, referenceType: 'redemption_token',
    metadata: { productId: 'b', productName: 'Yogurt expirado' },
  });
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_EXPIRED',
    debitAccountId: holding.id, creditAccountId: consumer.id,
    amount: '25', assetTypeId: asset.id,
    referenceId: `EXPIRED-${tokenB}`, referenceType: 'redemption_token',
    metadata: { productId: 'b', productName: 'Yogurt expirado' },
  });

  // Token C: still in-flight (PENDING only)
  const tokenC = randomUUID();
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_PENDING',
    debitAccountId: consumer.id, creditAccountId: holding.id,
    amount: '15', assetTypeId: asset.id,
    referenceId: `REDEEM-${tokenC}`, referenceType: 'redemption_token',
    metadata: { productId: 'c', productName: 'Yogurt en vuelo' },
  });

  // Consumer history
  const consumerToken = issueConsumerTokens({
    accountId: consumer.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;
  const histRes = await fetch(`${API}/api/consumer/history`, {
    headers: { 'Authorization': `Bearer ${consumerToken}` },
  });
  const hist: any = await histRes.json();
  const redEntries = hist.entries.filter((e: any) =>
    ['REDEMPTION_PENDING', 'REDEMPTION_CONFIRMED', 'REDEMPTION_EXPIRED'].includes(e.eventType)
  );

  const forA = redEntries.filter((e: any) => String(e.referenceId).endsWith(tokenA));
  await assert('consumer: token A (confirmed) shows ONE row',
    forA.length === 1, `count=${forA.length} refs=${forA.map((r: any) => r.referenceId).join('|')}`);
  await assert('consumer: token A row is labeled CONFIRMED',
    forA[0]?.eventType === 'REDEMPTION_CONFIRMED',
    `eventType=${forA[0]?.eventType}`);

  const forB = redEntries.filter((e: any) => String(e.referenceId).endsWith(tokenB));
  await assert('consumer: token B (expired) is HIDDEN on both sides',
    forB.length === 0, `count=${forB.length}`);

  const forC = redEntries.filter((e: any) => String(e.referenceId).endsWith(tokenC));
  await assert('consumer: token C (in-flight) shows ONE row',
    forC.length === 1, `count=${forC.length}`);
  await assert('consumer: token C stays as PENDING (no terminal event yet)',
    forC[0]?.eventType === 'REDEMPTION_PENDING',
    `eventType=${forC[0]?.eventType}`);

  // Merchant transactions
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `ec-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;
  const txRes = await fetch(`${API}/api/merchant/transactions?limit=200`, {
    headers: { 'Authorization': `Bearer ${ownerToken}` },
  });
  const tx: any = await txRes.json();
  const mRed = tx.entries.filter((e: any) =>
    ['REDEMPTION_PENDING', 'REDEMPTION_CONFIRMED', 'REDEMPTION_EXPIRED'].includes(e.eventType)
  );

  const mForA = mRed.filter((e: any) => String(e.referenceId).endsWith(tokenA));
  await assert('merchant: token A (confirmed) shows ONE row',
    mForA.length === 1, `count=${mForA.length}`);
  await assert('merchant: token A row is labeled CONFIRMED',
    mForA[0]?.eventType === 'REDEMPTION_CONFIRMED',
    `eventType=${mForA[0]?.eventType}`);

  const mForB = mRed.filter((e: any) => String(e.referenceId).endsWith(tokenB));
  await assert('merchant: token B (expired) is HIDDEN',
    mForB.length === 0, `count=${mForB.length}`);

  const mForC = mRed.filter((e: any) => String(e.referenceId).endsWith(tokenC));
  await assert('merchant: token C (in-flight) shows ONE row',
    mForC.length === 1, `count=${mForC.length}`);
  await assert('merchant: token C stays as PENDING (no terminal event yet)',
    mForC[0]?.eventType === 'REDEMPTION_PENDING',
    `eventType=${mForC[0]?.eventType}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
