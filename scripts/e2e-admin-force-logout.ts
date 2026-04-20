/**
 * E2E: admin-initiated force-logout kills a live session.
 *
 * Consumer path:
 *   1. Mint a consumer token (skip OTP via direct token issuance).
 *   2. Token works on /consumer/account.
 *   3. Admin hits POST /api/admin/accounts/:id/force-logout with a reason.
 *   4. Same token → 401 on /consumer/account.
 *   5. Audit log carries a SESSION_TERMINATED row with the reason.
 *
 * Staff path:
 *   1. Signup creates a new merchant → token in response.
 *   2. Token works on /merchant/plan-usage.
 *   3. Admin hits POST /api/admin/staff/:id/force-logout with a reason.
 *   4. Same token → 401.
 *
 * Negative cases:
 *   - Missing reason → 400
 *   - Short reason (<5 chars) → 400
 *   - Non-admin caller → 401/403
 *   - Unknown account id → 404
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { issueConsumerTokens, issueAdminTokens } from '../src/services/auth.js';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

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
  console.log('=== Admin force-logout E2E ===\n');

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'smoke-test' } });
  const admin = await prisma.adminUser.findFirstOrThrow();
  const adminToken = issueAdminTokens({ adminId: admin.id, type: 'admin' }).accessToken;

  // ── Consumer flow ──
  const ts = Date.now();
  const phone = `+19800${String(ts).slice(-7)}`;
  const { account } = await findOrCreateConsumerAccount(tenant.id, phone);
  const token1 = issueConsumerTokens({
    accountId: account.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;

  const pre = await http('/api/consumer/account', token1);
  await assert('consumer token works before force-logout', pre.status === 200, `status=${pre.status}`);

  // Sleep at least 1s so the iat check has a strict ordering (JWT iat is seconds).
  await new Promise(r => setTimeout(r, 1100));

  // Missing reason → 400
  const noReason = await http(`/api/admin/accounts/${account.id}/force-logout`, adminToken, {
    method: 'POST', body: JSON.stringify({}),
  });
  await assert('force-logout without reason → 400', noReason.status === 400, `status=${noReason.status}`);

  const shortReason = await http(`/api/admin/accounts/${account.id}/force-logout`, adminToken, {
    method: 'POST', body: JSON.stringify({ reason: 'hi' }),
  });
  await assert('force-logout with <5 char reason → 400', shortReason.status === 400, `status=${shortReason.status}`);

  const notFound = await http('/api/admin/accounts/00000000-0000-0000-0000-000000000000/force-logout', adminToken, {
    method: 'POST', body: JSON.stringify({ reason: 'unknown-id-test' }),
  });
  await assert('force-logout unknown account → 404', notFound.status === 404, `status=${notFound.status}`);

  const noAdmin = await http(`/api/admin/accounts/${account.id}/force-logout`, null, {
    method: 'POST', body: JSON.stringify({ reason: 'should fail' }),
  });
  await assert('force-logout without admin token → 401', noAdmin.status === 401, `status=${noAdmin.status}`);

  // Happy path
  const reason = `E2E force-logout ${ts}`;
  const ok = await http(`/api/admin/accounts/${account.id}/force-logout`, adminToken, {
    method: 'POST', body: JSON.stringify({ reason }),
  });
  await assert('force-logout with valid reason → 200', ok.status === 200, `status=${ok.status}`);

  const post = await http('/api/consumer/account', token1);
  await assert('same consumer token REJECTED after force-logout', post.status === 401,
    `status=${post.status} msg=${post.body?.error}`);

  // tokens_invalidated_at was bumped
  const row = await prisma.account.findUnique({ where: { id: account.id } });
  await assert('account.tokensInvalidatedAt set', !!row?.tokensInvalidatedAt,
    `ts=${row?.tokensInvalidatedAt?.toISOString()}`);

  // Audit log entry exists
  const audit = await prisma.auditLog.findFirst({
    where: {
      tenantId: tenant.id,
      consumerAccountId: account.id,
      actionType: 'SESSION_TERMINATED',
    },
    orderBy: { createdAt: 'desc' },
  });
  await assert('audit_log SESSION_TERMINATED row created', !!audit, `id=${audit?.id?.slice(0,8)}`);
  const meta: any = audit?.metadata;
  await assert('audit metadata carries reason', meta?.reason === reason, `reason=${meta?.reason}`);

  // A freshly-minted token AFTER the bump works again (no permanent lockout)
  await new Promise(r => setTimeout(r, 1100));
  const token2 = issueConsumerTokens({
    accountId: account.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;
  const retry = await http('/api/consumer/account', token2);
  await assert('fresh token (issued after bump) works', retry.status === 200, `status=${retry.status}`);

  // ── Staff flow ──
  const signup = await http('/api/merchant/signup', null, {
    method: 'POST',
    body: JSON.stringify({
      businessName: `Force-logout E2E ${ts}`,
      ownerName: 'Force-Out Owner',
      ownerEmail: `force-${ts}@e2e.local`,
      password: 'passw0rd-force',
    }),
  });
  await assert('staff signup ok', signup.status === 200 && !!signup.body.accessToken, `status=${signup.status}`);
  const staffToken1 = signup.body.accessToken as string;
  const staffId = signup.body.staff.id as string;

  const pre2 = await http('/api/merchant/plan-usage', staffToken1);
  await assert('staff token works before force-logout', pre2.status === 200, `status=${pre2.status}`);

  await new Promise(r => setTimeout(r, 1100));
  const ok2 = await http(`/api/admin/staff/${staffId}/force-logout`, adminToken, {
    method: 'POST', body: JSON.stringify({ reason: `E2E staff force-logout ${ts}` }),
  });
  await assert('staff force-logout 200', ok2.status === 200, `status=${ok2.status}`);

  const post2 = await http('/api/merchant/plan-usage', staffToken1);
  await assert('staff token REJECTED after force-logout', post2.status === 401, `status=${post2.status}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
