/**
 * E2E: single-tenant consumer view (the one Genesis sees in image 19)
 * also shows reserved points, not just the multi-merchant hub
 * (Genesis M4 coverage gap).
 *
 * Image 19 scenario: consumer has 4373 pts, generates three 3-pt QRs
 * → should see 4373 as "Tu saldo" with a "9 reservados para canje
 * pendiente" chip, not 4364. This test mirrors that: fund 100, open
 * three 10-pt redemption QRs, hit /balance, expect balance=70 and
 * reserved=30.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { initiateRedemption } from '../src/services/redemption.js';
import { issueConsumerTokens } from '../src/services/auth.js';

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Single-tenant reserved-balance E2E (Genesis M4 coverage) ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`SingleRes ${ts}`, `sr-${ts}`, `sr-${ts}@e2e.local`);
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
      tenantId: tenant.id, name: `Oreo ${ts}`, redemptionCost: 10,
      assetTypeId: asset.id, stock: 10, active: true, minLevel: 1,
    },
  });

  // Open three 10-pt redemption QRs (mirrors Genesis's "3 codigos activos")
  for (let i = 0; i < 3; i++) {
    const r = await initiateRedemption({
      consumerAccountId: consumer.id,
      productId: product.id,
      tenantId: tenant.id,
      assetTypeId: asset.id,
    });
    if (!r.success) { throw new Error(`redeem #${i} failed: ${r.message}`); }
  }

  const consumerToken = issueConsumerTokens({
    accountId: consumer.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;
  const balRes = await fetch(`${API}/api/consumer/balance`, {
    headers: { 'Authorization': `Bearer ${consumerToken}` },
  });
  const bal: any = await balRes.json();

  await assert('balance endpoint 200', balRes.status === 200, `status=${balRes.status}`);
  await assert('spendable balance is 70 (100 - 3*10 locked)',
    Number(bal.balance) === 70, `balance=${bal.balance}`);
  await assert('reserved is 30 (3 tokens x 10 pts)',
    Number(bal.reserved) === 30, `reserved=${bal.reserved}`);

  // Frontend chunk: check the single-tenant view ships the reserved copy
  const html = await (await fetch(`${FRONTEND}/consumer`)).text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('consumer chunk carries "reservados para canje pendiente" copy',
    chunkBodies.some(js => js.includes('reservados para canje pendiente')),
    `scanned=${chunkUrls.length}`);

  // Source-level assertion: single-tenant view uses reservedBalance in its
  // displayBalance calculation (this is what M4 was missing).
  const fs = await import('fs/promises');
  const src = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx',
    'utf8',
  );
  await assert('single-tenant view sums reservedBalance into displayBalance',
    /displayBalance\s*=\s*formatPoints\(parseFloat\(balance\)\s*\+\s*parseFloat\(reservedBalance\)/.test(src),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
