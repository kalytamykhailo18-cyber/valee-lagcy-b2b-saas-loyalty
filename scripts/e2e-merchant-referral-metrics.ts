/**
 * E2E for Eric's 2026-04-23 Notion ask:
 *
 *   "No se tiene una vista como tal dentro del merchant para cuantos
 *    codigos de referidos se han repartido... cuantos se han escaneado
 *    y cuantas personas han entrado como referidos en su primera compra."
 *
 * Exercises GET /api/merchant/referrals/metrics end-to-end: seeds a tenant
 * with a referrer who already has their referralSlug, a credited referral
 * (first purchase completed → bonus paid), a pending referral (scan landed
 * but no purchase yet), and asserts the summary + top list + recent list
 * reflect all three states.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { issueStaffTokens } from '../src/services/auth.js';
import { ensureReferralSlug, recordPendingReferral, tryCreditReferral } from '../src/services/referrals.js';
import bcrypt from 'bcryptjs';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== Merchant referral metrics E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Referral Metrics ${ts}`, `ref-metrics-${ts}`, `ref-metrics-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { plan: 'x10', referralBonusAmount: 150 },
  });

  // Owner + token
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const token = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  // Three consumer accounts: one referrer, two referees.
  async function mkAccount(phone: string) {
    return prisma.account.create({
      data: {
        tenantId: tenant.id, accountType: 'shadow',
        phoneNumber: phone,
      },
    });
  }
  const referrer = await mkAccount(`+1900${String(ts).slice(-7)}`);
  const refereeCredited = await mkAccount(`+1901${String(ts).slice(-7)}`);
  const refereePending  = await mkAccount(`+1902${String(ts).slice(-7)}`);

  // Referrer gets a slug — that counts as a "codigo entregado".
  const slug = await ensureReferralSlug(referrer.id);
  await assert('referrer has a slug', !!slug && slug.length >= 4, `slug=${slug}`);

  // Record two pending referrals.
  const pend1 = await recordPendingReferral({
    tenantId: tenant.id,
    referrerAccountId: referrer.id,
    refereeAccountId: refereeCredited.id,
  });
  const pend2 = await recordPendingReferral({
    tenantId: tenant.id,
    referrerAccountId: referrer.id,
    refereeAccountId: refereePending.id,
  });
  await assert('two pending referrals recorded',
    pend1.recorded === true && pend2.recorded === true,
    `p1=${pend1.recorded} p2=${pend2.recorded}`);

  // Credit only the first one (simulating first purchase completed).
  const credit = await tryCreditReferral({
    tenantId: tenant.id,
    refereeAccountId: refereeCredited.id,
    assetTypeId: asset.id,
  });
  await assert('first referee credited',
    credit.credited === true && Number(credit.amount) === 150,
    `credited=${credit.credited} amount=${credit.amount}`);

  // Hit the endpoint.
  const res = await http('/api/merchant/referrals/metrics', token);
  await assert('endpoint returns 200', res.status === 200, `status=${res.status}`);

  const s = res.body.summary;
  await assert('codesIssued counts referrers with slugs',
    s.codesIssued === 1, `codesIssued=${s.codesIssued}`);
  await assert('codesScanned sums all statuses',
    s.codesScanned === 2, `scanned=${s.codesScanned}`);
  await assert('pending bucket is 1',
    s.pending === 1, `pending=${s.pending}`);
  await assert('credited bucket is 1',
    s.credited === 1, `credited=${s.credited}`);
  await assert('bonusPaid equals credited bonus',
    Math.round(Number(s.bonusPaid)) === 150, `bonusPaid=${s.bonusPaid}`);

  const top = res.body.topReferrers;
  await assert('top list has the referrer once',
    Array.isArray(top) && top.length === 1 && top[0].accountId === referrer.id,
    `top=${JSON.stringify(top)}`);
  await assert('top entry shows credited count + slug',
    top[0].creditedCount === 1 && top[0].referralSlug === slug
      && Math.round(Number(top[0].bonusTotal)) === 150,
    `entry=${JSON.stringify(top[0])}`);

  const recent = res.body.recent;
  await assert('recent list has both referrals',
    Array.isArray(recent) && recent.length === 2,
    `recent.length=${recent.length}`);
  const creditedRow = recent.find((r: any) => r.status === 'credited');
  const pendingRow  = recent.find((r: any) => r.status === 'pending');
  await assert('credited row carries bonus + creditedAt',
    !!creditedRow && Math.round(Number(creditedRow.bonusAmount)) === 150 && !!creditedRow.creditedAt,
    `credited=${JSON.stringify(creditedRow)}`);
  await assert('pending row has no bonus yet',
    !!pendingRow && pendingRow.bonusAmount === null && pendingRow.creditedAt === null,
    `pending=${JSON.stringify(pendingRow)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
