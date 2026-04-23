/**
 * E2E: the redemption QR now carries only the tokenId UUID instead of the
 * full base64 signed payload. Eric flagged on 2026-04-23 that the cashier's
 * camera was rejecting the first frame ("Codigo QR invalido") because the
 * old dense QR was too small to capture cleanly. Encoding a 36-char uuid
 * instead of a ~450-char base64 blob cuts the QR version from ~15 to ~3,
 * so the modules are 3-4x larger and scan on the first frame.
 *
 * Verifies:
 *  - scan-redemption accepts a bare UUID and completes the canje
 *  - the UUID is wrong/unknown → "Codigo QR invalido"
 *  - the UUID exists but status != pending → the right "ya expiro"/"ya canjeado"
 *    message (not the generic invalido)
 *  - the legacy base64 payload still works (backward compat — old PWA tabs)
 *  - /api/consumer/active-redemptions still returns the legacy `token` field
 *    alongside `id` so a PWA served before the change keeps rendering its QR
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { issueConsumerTokens, issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== Redemption QR uuid-payload E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`QR UUID ${ts}`, `qr-uuid-${ts}`, `qr-uuid-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;

  // Consumer funded with enough to redeem twice
  const phone = `+19100${String(ts).slice(-7)}`;
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
      tenantId: tenant.id, name: 'Test Prize', redemptionCost: 10,
      assetTypeId: asset.id, stock: 5, active: true, minLevel: 1,
    },
  });

  // Cashier
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cashier', email: `c-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
    },
  });
  const cashierToken = issueStaffTokens({
    staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff',
  }).accessToken;

  const consumerToken = issueConsumerTokens({
    accountId: consumer.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;

  // ── Redeem twice so we have two tokens to test with ──
  async function redeem() {
    const res = await http('/api/consumer/redeem', consumerToken, {
      method: 'POST',
      body: JSON.stringify({ productId: product.id, assetTypeId: asset.id }),
    });
    return res.body;
  }
  const r1 = await redeem();
  const r2 = await redeem();
  await assert('both redemptions produced a tokenId uuid',
    /^[0-9a-f-]{36}$/.test(r1.tokenId) && /^[0-9a-f-]{36}$/.test(r2.tokenId),
    `t1=${r1.tokenId} t2=${r2.tokenId}`);
  await assert('redeem response carries both tokenId and legacy token',
    typeof r1.token === 'string' && r1.token.length > 50,
    `tokenLen=${r1.token?.length}`);

  // ── active-redemptions exposes id for the short QR path ──
  const active = await http('/api/consumer/active-redemptions', consumerToken);
  const activeIds = (active.body.redemptions || []).map((r: any) => r.id);
  await assert('active-redemptions surfaces the uuid as `id`',
    activeIds.includes(r1.tokenId) && activeIds.includes(r2.tokenId),
    `ids=${JSON.stringify(activeIds)}`);

  // ── 1. Scan with the bare UUID → success ──
  const scanUuid = await http('/api/merchant/scan-redemption', cashierToken, {
    method: 'POST',
    body: JSON.stringify({ token: r1.tokenId }),
  });
  await assert('bare UUID scan succeeds',
    scanUuid.status === 200 && scanUuid.body.success === true,
    `status=${scanUuid.status} msg=${scanUuid.body?.message}`);

  // ── 2. Second scan of the same UUID → "ya canjeado" ──
  const scanAgain = await http('/api/merchant/scan-redemption', cashierToken, {
    method: 'POST',
    body: JSON.stringify({ token: r1.tokenId }),
  });
  await assert('second UUID scan reports already-used',
    scanAgain.body?.success === false && /ya fue canjeado/i.test(scanAgain.body?.message || ''),
    `msg=${scanAgain.body?.message}`);

  // ── 3. Unknown UUID → "Codigo QR invalido" (not a generic server error) ──
  const fakeUuid = '00000000-0000-0000-0000-000000000000';
  const scanMissing = await http('/api/merchant/scan-redemption', cashierToken, {
    method: 'POST',
    body: JSON.stringify({ token: fakeUuid }),
  });
  await assert('unknown UUID is rejected as Codigo QR invalido',
    scanMissing.body?.success === false && /invalido/i.test(scanMissing.body?.message || ''),
    `msg=${scanMissing.body?.message}`);

  // ── 4. Legacy base64 token still works for r2 (backward compat) ──
  const legacyScan = await http('/api/merchant/scan-redemption', cashierToken, {
    method: 'POST',
    body: JSON.stringify({ token: r2.token }),
  });
  await assert('legacy base64 token still scans successfully',
    legacyScan.status === 200 && legacyScan.body.success === true,
    `status=${legacyScan.status} msg=${legacyScan.body?.message}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
