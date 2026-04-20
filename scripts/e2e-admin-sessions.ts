/**
 * E2E: admin sessions page — lookup + force-logout via the real HTTP
 * endpoints the UI calls. Exercises account search, staff search, the
 * force-logout path, and re-search to confirm the tokensInvalidatedAt
 * field updates.
 *
 * Also does a lightweight UI surface check:
 *   - /admin/sessions page returns 200
 *   - /admin main page's chunk links to /admin/sessions
 *   - /admin/sessions page's chunk references the search + force-logout APIs
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { issueAdminTokens, issueConsumerTokens } from '../src/services/auth.js';
import { findOrCreateConsumerAccount } from '../src/services/accounts.js';

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== Admin sessions (lookup + force-logout) E2E ===\n');

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'smoke-test' } });
  const admin = await prisma.adminUser.findFirstOrThrow();
  const adminToken = issueAdminTokens({ adminId: admin.id, type: 'admin' }).accessToken;

  // ── Seed: create a consumer whose phone ends in a unique tail ──
  const ts = Date.now();
  const tail = String(ts).slice(-7);
  const phone = `+19600${tail}`;
  const { account } = await findOrCreateConsumerAccount(tenant.id, phone);

  // ── Search accounts (full phone) ──
  const s1 = await http(`/api/admin/accounts/search?phone=${encodeURIComponent(phone)}`, adminToken);
  await assert('account search by full phone → 200', s1.status === 200, `status=${s1.status}`);
  await assert('search returns the seeded account',
    Array.isArray(s1.body.accounts) && s1.body.accounts.some((a: any) => a.id === account.id),
    `matched=${s1.body.accounts?.some((a: any) => a.id === account.id)}`);

  // ── Search by tail ──
  const s2 = await http(`/api/admin/accounts/search?phone=${tail}`, adminToken);
  await assert('account search by last-10 tail → 200', s2.status === 200, `status=${s2.status}`);
  await assert('tail match also finds the seeded account',
    s2.body.accounts?.some((a: any) => a.id === account.id),
    `count=${s2.body.accounts?.length}`);

  // ── Mint a consumer token that works ──
  const consumerToken = issueConsumerTokens({
    accountId: account.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;
  const pre = await http('/api/consumer/account', consumerToken);
  await assert('consumer token works before force-logout', pre.status === 200, `status=${pre.status}`);

  // Need >= 1s gap so iat comparison beats tokens_invalidated_at.
  await new Promise(r => setTimeout(r, 1100));

  // ── Force-logout via the admin endpoint the UI calls ──
  const kick = await http(`/api/admin/accounts/${account.id}/force-logout`, adminToken, {
    method: 'POST', body: JSON.stringify({ reason: 'E2E admin-sessions flow' }),
  });
  await assert('force-logout account → 200', kick.status === 200, `status=${kick.status}`);

  const post = await http('/api/consumer/account', consumerToken);
  await assert('consumer token rejected after force-logout', post.status === 401, `status=${post.status}`);

  // Re-search should now surface tokensInvalidatedAt on the row.
  const s3 = await http(`/api/admin/accounts/search?phone=${encodeURIComponent(phone)}`, adminToken);
  const row = s3.body.accounts?.find((a: any) => a.id === account.id);
  await assert('search re-returns the account with tokensInvalidatedAt set',
    !!row && !!row.tokensInvalidatedAt,
    `tokensInvalidatedAt=${row?.tokensInvalidatedAt}`);

  // ── Staff search + force-logout ──
  const signup = await http('/api/merchant/signup', null, {
    method: 'POST',
    body: JSON.stringify({
      businessName: `Sessions E2E ${ts}`,
      ownerName: 'Sessions Owner',
      ownerEmail: `sessions-${ts}@e2e.local`,
      password: 'passw0rd-sess',
    }),
  });
  await assert('staff signup ok', signup.status === 200, `status=${signup.status}`);
  const staffId = signup.body.staff.id;
  const staffToken = signup.body.accessToken;

  const s4 = await http(`/api/admin/staff/search?email=sessions-${ts}`, adminToken);
  await assert('staff search by email substring → 200', s4.status === 200, `status=${s4.status}`);
  await assert('staff search returns the owner',
    s4.body.staff?.some((r: any) => r.id === staffId),
    `count=${s4.body.staff?.length}`);

  await new Promise(r => setTimeout(r, 1100));
  const preStaff = await http('/api/merchant/plan-usage', staffToken);
  await assert('staff token works before force-logout', preStaff.status === 200, `status=${preStaff.status}`);

  const kickStaff = await http(`/api/admin/staff/${staffId}/force-logout`, adminToken, {
    method: 'POST', body: JSON.stringify({ reason: 'E2E admin-sessions staff flow' }),
  });
  await assert('staff force-logout → 200', kickStaff.status === 200, `status=${kickStaff.status}`);

  const postStaff = await http('/api/merchant/plan-usage', staffToken);
  await assert('staff token rejected after force-logout', postStaff.status === 401, `status=${postStaff.status}`);

  // ── UI surface checks (same pattern as health UI E2E) ──
  const pageRes = await fetch(`${FRONTEND}/admin/sessions`);
  await assert('/admin/sessions returns 200', pageRes.status === 200, `status=${pageRes.status}`);
  const pageHtml = await pageRes.text();

  const mainHtml = await (await fetch(`${FRONTEND}/admin`)).text();
  const mainChunk = mainHtml.match(/\/_next\/static\/chunks\/app\/\(admin\)\/admin\/page-[a-f0-9]+\.js/);
  if (mainChunk) {
    const js = await (await fetch(`${FRONTEND}${mainChunk[0]}`)).text();
    await assert('admin dashboard links to /admin/sessions', js.includes('/admin/sessions'),
      `includes=${js.includes('/admin/sessions')}`);
  }

  // Literal URLs live in lib/api.ts, which Next.js may ship in a shared
  // chunk. Scan every chunk linked from the page HTML.
  const chunkUrls = Array.from(pageHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('some /admin/sessions chunk references account search',
    chunkBodies.some(js => js.includes('/api/admin/accounts/search')),
    `scanned=${chunkUrls.length}`);
  await assert('some /admin/sessions chunk references force-logout',
    chunkBodies.some(js => js.includes('force-logout')),
    `scanned=${chunkUrls.length}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
