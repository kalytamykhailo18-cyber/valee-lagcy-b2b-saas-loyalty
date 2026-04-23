/**
 * E2E for Genesis's 2026-04-23 ask:
 *
 *   "Se pudiera quitar la palabra temporal y que el usuario la cambie
 *    despues... si el usuario entra a su panel que tenga la opcion
 *    de cambiarla."
 *
 * Covers the new POST /api/merchant/auth/change-password:
 *   - wrong current password is rejected with 400
 *   - too-short new password is rejected with 400
 *   - same-as-current new password is rejected with 400
 *   - valid change rotates the bcrypt hash
 *   - valid change bumps tokensInvalidatedAt so OLD sessions are dead
 *   - valid change returns fresh tokens so the CALLER stays logged in
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { issueStaffTokens } from '../src/services/auth.js';
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
  console.log('=== Staff change-password E2E ===\n');

  const ts = Date.now();
  const tenant = await createTenant(`ChangePw ${ts}`, `changepw-${ts}`, `changepw-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);

  const originalPw = 'firstPassword123';
  const newPw = 'brandNewPassword456';
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cashier', email: `c-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash(originalPw, 10), role: 'cashier',
    },
  });
  const originalToken = issueStaffTokens({
    staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff',
  }).accessToken;

  // Wrong current password
  const wrong = await http('/api/merchant/auth/change-password', originalToken, {
    method: 'POST',
    body: JSON.stringify({ currentPassword: 'not-the-real-one', newPassword: newPw }),
  });
  await assert('wrong current password is rejected 400',
    wrong.status === 400 && /actual es incorrecta/i.test(wrong.body?.error || ''),
    `status=${wrong.status} error=${wrong.body?.error}`);

  // Too-short new password
  const tooShort = await http('/api/merchant/auth/change-password', originalToken, {
    method: 'POST',
    body: JSON.stringify({ currentPassword: originalPw, newPassword: '123' }),
  });
  await assert('too-short new password is rejected 400',
    tooShort.status === 400,
    `status=${tooShort.status}`);

  // Same-as-current
  const same = await http('/api/merchant/auth/change-password', originalToken, {
    method: 'POST',
    body: JSON.stringify({ currentPassword: originalPw, newPassword: originalPw }),
  });
  await assert('same-as-current is rejected 400',
    same.status === 400,
    `status=${same.status}`);

  // Sanity: original token can still access the API before rotation
  const pre = await http('/api/merchant/branches', originalToken);
  // branches is owner-only → cashier gets 403, not 401; both are fine, what we
  // want is: NOT 401 (meaning the token itself is valid against auth layer).
  await assert('original token is valid pre-change',
    pre.status !== 401,
    `status=${pre.status}`);

  // Valid change
  const ok = await http('/api/merchant/auth/change-password', originalToken, {
    method: 'POST',
    body: JSON.stringify({ currentPassword: originalPw, newPassword: newPw }),
  });
  await assert('valid change returns 200 with fresh tokens',
    ok.status === 200
    && typeof ok.body?.accessToken === 'string'
    && ok.body.accessToken.length > 10
    && typeof ok.body?.refreshToken === 'string',
    `status=${ok.status} hasAccess=${!!ok.body?.accessToken} hasRefresh=${!!ok.body?.refreshToken}`);

  const newToken: string = ok.body.accessToken;

  // DB: hash actually rotated to the new value
  const refreshed = await prisma.staff.findUnique({ where: { id: cashier.id } });
  await assert('bcrypt hash rotated to new password',
    !!refreshed && await bcrypt.compare(newPw, refreshed!.passwordHash)
      && !(await bcrypt.compare(originalPw, refreshed!.passwordHash)),
    `ok=${!!refreshed}`);
  await assert('tokensInvalidatedAt bumped',
    !!refreshed?.tokensInvalidatedAt
    && refreshed!.tokensInvalidatedAt.getTime() > cashier.createdAt.getTime(),
    `bumped=${refreshed?.tokensInvalidatedAt?.toISOString()}`);

  // OLD access token must now be rejected (issued before tokensInvalidatedAt).
  const postOld = await http('/api/merchant/branches', originalToken);
  await assert('old token is now rejected 401',
    postOld.status === 401,
    `status=${postOld.status}`);

  // NEW token from the response must still work.
  const postNew = await http('/api/merchant/branches', newToken);
  await assert('fresh token keeps the caller logged in',
    postNew.status !== 401,
    `status=${postNew.status}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
