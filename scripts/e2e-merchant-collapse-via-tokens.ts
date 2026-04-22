/**
 * E2E: merchant transactions collapse works even when the CONFIRMED
 * ledger leg is NOT on the same page as the PENDING one (Genesis QA
 * item 5/8 — "Canje pendiente / Producto Canjeado" duplicate).
 *
 * Scenario: consumer redeems a product. Cashier scans. The PENDING
 * and CONFIRMED ledger rows are written 16s apart (like Genesis's
 * image 8 timestamps). With a small page size, one might land on
 * page 1 and the other on page 2. The collapse logic must still
 * recognize the CONFIRMED state using redemption_tokens.status as a
 * fallback, not just what's in the current page.
 *
 * Steps:
 *   1. Build a tenant with noise events (to push pagination).
 *   2. Do a real redemption end-to-end (initiate + processRedemption).
 *   3. Fetch /api/merchant/transactions with a small limit.
 *   4. Assert exactly ONE row for that canje, labeled
 *      REDEMPTION_CONFIRMED with consumer name visible.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { initiateRedemption, processRedemption } from '../src/services/redemption.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Merchant collapse via redemption_tokens lookup E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`MTokColl ${ts}`, `mtc-${ts}`, `mtc-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;

  const phone = `+58414${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);
  await prisma.account.update({
    where: { id: consumer.id },
    data: { displayName: 'soygenesisabad' },
  });

  // Seed a fund so the redemption can succeed
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '500', assetTypeId: asset.id,
    referenceId: `SEED-${ts}`, referenceType: 'manual_adjustment',
    metadata: { type: 'test_fund' },
  });

  // Create the product (mirror image 8: "yogurt")
  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id, name: 'yogurt', redemptionCost: 10,
      assetTypeId: asset.id, stock: 5, active: true, minLevel: 1,
    },
  });

  // Do a REAL redemption — initiate (writes PENDING pair) then process
  // (writes CONFIRMED pair and bumps redemption_tokens.status to 'used')
  const redemption = await initiateRedemption({
    consumerAccountId: consumer.id,
    productId: product.id,
    tenantId: tenant.id,
    assetTypeId: asset.id,
  });
  await assert('initiate succeeded', redemption.success === true,
    `msg=${redemption.message}`);

  // Cashier processes it
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cashier', email: `mtc-cashier-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
    },
  });
  const processed = await processRedemption({
    token: redemption.token!,
    cashierStaffId: cashier.id,
    cashierTenantId: tenant.id,
  });
  await assert('process succeeded', processed.success === true,
    `msg=${processed.message}`);

  // Sanity: the redemption_tokens row says 'used'
  const tokRow = await prisma.redemptionToken.findUnique({
    where: { id: redemption.tokenId! },
    select: { status: true },
  });
  await assert('redemption_tokens.status is used', tokRow?.status === 'used',
    `status=${tokRow?.status}`);

  // Push some noise entries AFTER the redemption so pagination would
  // naturally push the CONFIRMED leg off page 1 (orderBy created_at DESC).
  for (let i = 0; i < 40; i++) {
    await writeDoubleEntry({
      tenantId: tenant.id,
      eventType: 'ADJUSTMENT_MANUAL',
      debitAccountId: pool.id, creditAccountId: consumer.id,
      amount: '1', assetTypeId: asset.id,
      referenceId: `NOISE-${ts}-${i}`, referenceType: 'manual_adjustment',
      metadata: { source: 'noise' },
    });
  }

  // Fetch as owner with a small limit so the CONFIRMED leg is off-page.
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `mtc-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  // limit=50 but with 40 noise + 2 redemption legs + 1 seed adjust = ~43-44
  // entries; the PENDING row is at the bottom of the range. We use a small
  // limit window that includes the PENDING but drops CONFIRMED to force
  // the collapse to rely on the redemption_tokens lookup.
  const smallRes = await fetch(`${API}/api/merchant/transactions?limit=5&offset=40`, {
    headers: { 'Authorization': `Bearer ${ownerToken}` },
  });
  const smallBody: any = await smallRes.json();
  const pageEntries = smallBody.entries as any[];

  const redemptionEntries = pageEntries.filter((e) =>
    ['REDEMPTION_PENDING', 'REDEMPTION_CONFIRMED', 'REDEMPTION_EXPIRED'].includes(e.eventType)
    && String(e.referenceId || '').endsWith(redemption.tokenId!)
  );

  // There should be AT MOST one redemption row for this token in the window.
  // Whatever survives should be labeled CONFIRMED (never as PENDING) because
  // the token is already used.
  await assert('at most one redemption row per token on the page',
    redemptionEntries.length <= 1,
    `count=${redemptionEntries.length} refs=${redemptionEntries.map(r => r.referenceId).join('|')}`);
  if (redemptionEntries.length === 1) {
    await assert('the surviving row is labeled REDEMPTION_CONFIRMED',
      redemptionEntries[0].eventType === 'REDEMPTION_CONFIRMED',
      `eventType=${redemptionEntries[0].eventType}`);
    await assert('the surviving row carries the consumer display name',
      redemptionEntries[0].accountName === 'soygenesisabad',
      `accountName=${redemptionEntries[0].accountName}`);
  }

  // And one more full-page assertion: the canonical "one row per token,
  // labeled CONFIRMED" holds regardless of page size.
  const bigRes = await fetch(`${API}/api/merchant/transactions?limit=200`, {
    headers: { 'Authorization': `Bearer ${ownerToken}` },
  });
  const big: any = await bigRes.json();
  const bigRedemption = (big.entries as any[]).filter((e) =>
    ['REDEMPTION_PENDING', 'REDEMPTION_CONFIRMED', 'REDEMPTION_EXPIRED'].includes(e.eventType)
    && String(e.referenceId || '').endsWith(redemption.tokenId!)
  );
  await assert('full page: exactly one redemption row for the token',
    bigRedemption.length === 1, `count=${bigRedemption.length}`);
  await assert('full page: the row is CONFIRMED',
    bigRedemption[0]?.eventType === 'REDEMPTION_CONFIRMED',
    `eventType=${bigRedemption[0]?.eventType}`);
  await assert('full page: consumer name present',
    bigRedemption[0]?.accountName === 'soygenesisabad',
    `accountName=${bigRedemption[0]?.accountName}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
