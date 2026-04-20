/**
 * E2E: merchant password recovery (Genesis M5).
 *
 * Flow:
 *   1. POST /api/merchant/auth/password-reset/request with a known owner
 *      email → returns { success: true }. In dev (no Resend wired), the
 *      response also carries devResetUrl so the script can extract the
 *      token for the next step.
 *   2. POST /api/merchant/auth/password-reset/confirm with the token and
 *      a new password → success, old password no longer works, new one
 *      does, existing sessions were invalidated.
 *   3. Reusing the same token returns 400.
 *   4. Requesting with an unknown email still returns success (no leak).
 *   5. Confirm with a too-short password is rejected.
 *   6. Frontend /merchant/forgot-password and /merchant/reset-password
 *      pages serve 200 and ship the expected copy.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Password reset E2E (Genesis M5) ===\n');

  const ts = Date.now();
  const tenant = await createTenant(`PwReset ${ts}`, `pwr-${ts}`, `pwr-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);

  const ownerEmail = `pwr-owner-${ts}@e2e.local`;
  const oldPassword = 'old-password-123';
  const oldHash = await bcrypt.hash(oldPassword, 10);
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: ownerEmail,
      passwordHash: oldHash, role: 'owner',
    },
  });
  // Seed a pre-existing session — after the reset lands we expect this
  // session to be invalidated (tokens_invalidated_at bumps forward).
  const preResetToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;
  const preMeRes = await fetch(`${API}/api/merchant/settings`, {
    headers: { 'Authorization': `Bearer ${preResetToken}` },
  });
  await assert('pre-reset session is valid',
    preMeRes.status === 200, `status=${preMeRes.status}`);

  // Step 1 — request reset
  const reqRes = await fetch(`${API}/api/merchant/auth/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail }),
  });
  const reqBody: any = await reqRes.json();
  await assert('request returns 200', reqRes.status === 200, `status=${reqRes.status}`);
  await assert('request payload reports success', reqBody.success === true,
    `success=${reqBody.success}`);
  // Without Resend DNS, the server surfaces the reset URL in dev mode so
  // the flow is testable. Extract the raw token from the URL.
  await assert('dev mode returns a reset URL for testing',
    typeof reqBody.devResetUrl === 'string' && reqBody.devResetUrl.includes('?token='),
    `devResetUrl=${reqBody.devResetUrl?.slice(0, 80)}`);
  const rawToken = new URL(reqBody.devResetUrl).searchParams.get('token')!;
  await assert('reset URL carries a non-empty token',
    typeof rawToken === 'string' && rawToken.length >= 32,
    `len=${rawToken.length}`);

  // Step 2 — confirm with new password
  const newPassword = 'new-password-456';
  const confRes = await fetch(`${API}/api/merchant/auth/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: rawToken, newPassword }),
  });
  const confBody: any = await confRes.json();
  await assert('confirm returns 200', confRes.status === 200, `status=${confRes.status}`);
  await assert('confirm success=true', confBody.success === true,
    `success=${confBody.success}`);

  // Verify: old password fails, new password works
  const oldLoginRes = await fetch(`${API}/api/merchant/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: oldPassword }),
  });
  await assert('old password no longer works',
    oldLoginRes.status === 401, `status=${oldLoginRes.status}`);

  const newLoginRes = await fetch(`${API}/api/merchant/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: newPassword }),
  });
  await assert('new password logs in',
    newLoginRes.status === 200, `status=${newLoginRes.status}`);

  // Pre-reset session should be dead (tokens_invalidated_at bumped)
  const preAfterRes = await fetch(`${API}/api/merchant/settings`, {
    headers: { 'Authorization': `Bearer ${preResetToken}` },
  });
  await assert('pre-reset session was invalidated',
    preAfterRes.status === 401, `status=${preAfterRes.status}`);

  // Step 3 — reusing the token is rejected
  const reuseRes = await fetch(`${API}/api/merchant/auth/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: rawToken, newPassword: 'another-password-789' }),
  });
  await assert('reusing the reset token returns 400',
    reuseRes.status === 400, `status=${reuseRes.status}`);

  // Step 4 — unknown email still returns success (no leak)
  const unknownRes = await fetch(`${API}/api/merchant/auth/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `nonexistent-${ts}@e2e.local` }),
  });
  const unknownBody: any = await unknownRes.json();
  await assert('request for unknown email returns success (no leak)',
    unknownRes.status === 200 && unknownBody.success === true,
    `status=${unknownRes.status} success=${unknownBody.success}`);
  await assert('no devResetUrl is returned for unknown email',
    !unknownBody.devResetUrl, `devResetUrl=${unknownBody.devResetUrl}`);

  // Step 5 — short password rejected
  // Get a fresh token first (we consumed the previous one).
  const reqRes2 = await fetch(`${API}/api/merchant/auth/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail }),
  });
  const reqBody2: any = await reqRes2.json();
  const rawToken2 = new URL(reqBody2.devResetUrl).searchParams.get('token')!;
  const shortRes = await fetch(`${API}/api/merchant/auth/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: rawToken2, newPassword: 'short' }),
  });
  await assert('short password is rejected',
    shortRes.status === 400, `status=${shortRes.status}`);

  // Step 6 — frontend pages serve + ship copy
  const forgotRes = await fetch(`${FRONTEND}/merchant/forgot-password`);
  await assert('/merchant/forgot-password serves 200',
    forgotRes.status === 200, `status=${forgotRes.status}`);
  const resetPageRes = await fetch(`${FRONTEND}/merchant/reset-password?token=abc`);
  await assert('/merchant/reset-password serves 200',
    resetPageRes.status === 200, `status=${resetPageRes.status}`);

  const loginHtml = await (await fetch(`${FRONTEND}/merchant/login`)).text();
  const chunkUrls = Array.from(loginHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('/merchant/login chunk references the forgot-password link',
    chunkBodies.some(js => js.includes('Olvide mi contrasena')),
    `scanned=${chunkUrls.length}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
