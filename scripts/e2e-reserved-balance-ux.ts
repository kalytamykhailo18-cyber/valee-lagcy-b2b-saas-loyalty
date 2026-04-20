/**
 * E2E: Genesis M4 — don't make pending canje points look missing.
 *
 * When a consumer generates a redemption QR, the double-entry debits
 * them immediately (so a second scan can't double-spend) which makes
 * their "Saldo" visually drop even before the cashier scanned. The fix
 * surfaces the reserved amount on /api/consumer/balance and
 * /api/consumer/all-accounts, and the PWA renders the total as
 * spendable + reserved with a "N reservados" chip.
 *
 *  1. Fund consumer with 100, redeem a 30-pt product.
 *  2. /api/consumer/balance → balance=70, reserved=30.
 *  3. /api/consumer/all-accounts → totalBalance=70, totalReserved=30;
 *     per-merchant row has reserved=30.
 *  4. /consumer chunk carries the "reservados para canje pendiente" copy.
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
  console.log('=== Consumer reserved-balance UX E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Reserved UX ${ts}`, `ru-${ts}`, `ru-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;

  const phone = `+19000${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);

  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '100', assetTypeId: asset.id,
    referenceId: `SEED-${ts}`, referenceType: 'manual_adjustment',
    metadata: { type: 'test_fund' },
  });

  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id, name: `Reserved Prize ${ts}`, redemptionCost: 30,
      assetTypeId: asset.id, stock: 3, active: true, minLevel: 1,
    },
  });

  const consumerToken = issueConsumerTokens({
    accountId: consumer.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;

  // Before redeem: balance=100, reserved=0
  const b0Res = await fetch(`${API}/api/consumer/balance`, {
    headers: { 'Authorization': `Bearer ${consumerToken}` },
  });
  const b0: any = await b0Res.json();
  await assert('pre-redeem balance=100', Number(b0.balance) === 100, `balance=${b0.balance}`);
  await assert('pre-redeem reserved=0', Number(b0.reserved) === 0, `reserved=${b0.reserved}`);

  // Redeem — creates a PENDING that reserves 30
  const redRes = await fetch(`${API}/api/consumer/redeem`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${consumerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      productId: product.id, assetTypeId: asset.id,
      requestId: `reserved-ux-${ts}`,
    }),
  });
  await assert('/api/consumer/redeem 200', redRes.status === 200, `status=${redRes.status}`);

  // After redeem
  const b1Res = await fetch(`${API}/api/consumer/balance`, {
    headers: { 'Authorization': `Bearer ${consumerToken}` },
  });
  const b1: any = await b1Res.json();
  await assert('post-redeem spendable balance is 70 (30 debited)',
    Number(b1.balance) === 70, `balance=${b1.balance}`);
  await assert('post-redeem reserved is 30', Number(b1.reserved) === 30,
    `reserved=${b1.reserved}`);

  // all-accounts surfaces the same
  const aRes = await fetch(`${API}/api/consumer/all-accounts`, {
    headers: { 'Authorization': `Bearer ${consumerToken}` },
  });
  const a: any = await aRes.json();
  await assert('all-accounts 200', aRes.status === 200, `status=${aRes.status}`);
  await assert('all-accounts totalBalance excludes reserved',
    Number(a.totalBalance) === 70, `totalBalance=${a.totalBalance}`);
  await assert('all-accounts totalReserved is 30',
    Number(a.totalReserved) === 30, `totalReserved=${a.totalReserved}`);
  const thisMerchant = a.merchants.find((m: any) => m.tenantId === tenant.id);
  await assert('per-merchant card has reserved=30',
    Number(thisMerchant?.reserved) === 30, `reserved=${thisMerchant?.reserved}`);

  // Frontend chunk-grep
  const html = await (await fetch(`${FRONTEND}/consumer`)).text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('/consumer chunk ships "reservados para canje pendiente"',
    chunkBodies.some(js => js.includes('reservados para canje pendiente')),
    `scanned=${chunkUrls.length}`);
  await assert('/consumer chunk ships the per-merchant "reservados" label',
    chunkBodies.some(js => /reservados/.test(js)),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
