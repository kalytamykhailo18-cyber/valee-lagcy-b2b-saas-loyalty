/**
 * E2E: tokens_invalidated_at force-logout survives even when the JWT
 * signature + TTL are still valid.
 *
 * Scenarios:
 *   1. Consumer: request OTP → verify → hit /account → logout → re-use
 *      the same Bearer token → must get 401.
 *   2. Staff:    signup → hit /plan-usage → logout → re-use token → 401.
 *   3. Fresh token issued AFTER the logout bump works again (no permanent
 *      lockout; only tokens issued at or before the bump are rejected).
 */

import dotenv from 'dotenv';
dotenv.config();

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function getJson(path: string, token?: string, init: RequestInit = {}) {
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

async function consumerFlow() {
  const ts = Date.now();
  const phone = `+19300${String(ts).slice(-7)}`;

  const req = await getJson('/api/consumer/auth/request-otp', undefined, {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: phone, tenantSlug: 'smoke-test' }),
  });
  await assert('consumer OTP requested', req.status === 200, `status=${req.status}`);

  const verify = await getJson('/api/consumer/auth/verify-otp', undefined, {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: phone, otp: req.body.otp, tenantSlug: 'smoke-test' }),
  });
  await assert('consumer OTP verified', verify.status === 200 && !!verify.body.accessToken,
    `status=${verify.status}`);
  const token1 = verify.body.accessToken as string;

  const r1 = await getJson('/api/consumer/account', token1);
  await assert('token works before logout', r1.status === 200, `status=${r1.status}`);

  // Sleep at least 1s so the post-logout token (re-issued below) has iat > bump.
  // JWT iat is whole-second precision.
  await new Promise(r => setTimeout(r, 1100));

  const logout = await getJson('/api/consumer/auth/logout', token1, { method: 'POST' });
  await assert('consumer logout 200', logout.status === 200, `status=${logout.status}`);

  const r2 = await getJson('/api/consumer/account', token1);
  await assert('same token REJECTED after logout', r2.status === 401,
    `status=${r2.status} msg=${r2.body?.error}`);

  // Re-verify OTP (fresh token) — must work again. Wait another second so the
  // new token's iat is strictly greater than tokens_invalidated_at.
  await new Promise(r => setTimeout(r, 1100));
  const req2 = await getJson('/api/consumer/auth/request-otp', undefined, {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: phone, tenantSlug: 'smoke-test' }),
  });
  const verify2 = await getJson('/api/consumer/auth/verify-otp', undefined, {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: phone, otp: req2.body.otp, tenantSlug: 'smoke-test' }),
  });
  const token2 = verify2.body.accessToken as string;
  const r3 = await getJson('/api/consumer/account', token2);
  await assert('fresh token (issued after bump) works', r3.status === 200,
    `status=${r3.status}`);
}

async function staffFlow() {
  const ts = Date.now();
  const signup = await getJson('/api/merchant/signup', undefined, {
    method: 'POST',
    body: JSON.stringify({
      businessName: `Revoke E2E ${ts}`,
      ownerName: 'Revoke Owner',
      ownerEmail: `revoke-${ts}@example.com`,
      password: 'passw0rd-e2e',
    }),
  });
  await assert('staff signup ok', signup.status === 200 && !!signup.body.accessToken,
    `status=${signup.status}`);
  const token1 = signup.body.accessToken as string;

  const r1 = await getJson('/api/merchant/plan-usage', token1);
  await assert('staff token works before logout', r1.status === 200, `status=${r1.status}`);

  await new Promise(r => setTimeout(r, 1100));
  const logout = await getJson('/api/merchant/auth/logout', token1, { method: 'POST' });
  await assert('staff logout 200', logout.status === 200, `status=${logout.status}`);

  const r2 = await getJson('/api/merchant/plan-usage', token1);
  await assert('staff token REJECTED after logout', r2.status === 401,
    `status=${r2.status}`);
}

async function main() {
  await consumerFlow();
  await staffFlow();
  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
