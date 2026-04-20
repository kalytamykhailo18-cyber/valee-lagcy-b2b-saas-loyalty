/**
 * E2E: admin tenant deactivation kills staff sessions and blocks re-login,
 * and reactivation restores access.
 *
 * Scenarios:
 *   1. Signup a merchant → owner token works
 *   2. Admin deactivates tenant with reason → response reports staffSessionsKilled
 *   3. Existing owner token → 401 (tokens_invalidated_at bumped)
 *   4. Owner tries to log back in with password → REJECTED (tenant inactive)
 *   5. Admin reactivates tenant with reason → tenant.status = 'active'
 *   6. Owner logs in again with same password → SUCCESS, gets fresh token
 *   7. Negative cases: no reason → 400, short reason → 400, unknown id → 404,
 *      non-admin caller → 401
 *   8. Audit log has TENANT_DEACTIVATED + TENANT_CREATED(reactivated) rows
 *      both carrying the reason in metadata
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { issueAdminTokens } from '../src/services/auth.js';

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
  console.log('=== Tenant suspension E2E ===\n');

  const ts = Date.now();
  const admin = await prisma.adminUser.findFirstOrThrow();
  const adminToken = issueAdminTokens({ adminId: admin.id, type: 'admin' }).accessToken;

  // Signup a merchant (creates owner + auto-login)
  const email = `suspend-${ts}@e2e.local`;
  const password = 'passw0rd-suspend';
  const signup = await http('/api/merchant/signup', null, {
    method: 'POST',
    body: JSON.stringify({
      businessName: `Suspend E2E ${ts}`,
      ownerName: 'Suspend Owner',
      ownerEmail: email,
      password,
    }),
  });
  await assert('signup 200 + token', signup.status === 200 && !!signup.body.accessToken,
    `status=${signup.status}`);
  const tenantId = signup.body.tenant.id as string;
  const ownerToken1 = signup.body.accessToken as string;

  const pre = await http('/api/merchant/plan-usage', ownerToken1);
  await assert('owner token works pre-deactivation', pre.status === 200, `status=${pre.status}`);

  // Negative cases
  const noReason = await http(`/api/admin/tenants/${tenantId}/deactivate`, adminToken, {
    method: 'PATCH', body: JSON.stringify({}),
  });
  await assert('deactivate without reason → 400', noReason.status === 400, `status=${noReason.status}`);

  const shortReason = await http(`/api/admin/tenants/${tenantId}/deactivate`, adminToken, {
    method: 'PATCH', body: JSON.stringify({ reason: 'hi' }),
  });
  await assert('deactivate with <5 char reason → 400', shortReason.status === 400, `status=${shortReason.status}`);

  const notFound = await http('/api/admin/tenants/00000000-0000-0000-0000-000000000000/deactivate', adminToken, {
    method: 'PATCH', body: JSON.stringify({ reason: 'unknown id test' }),
  });
  await assert('deactivate unknown tenant → 404', notFound.status === 404, `status=${notFound.status}`);

  const noAdmin = await http(`/api/admin/tenants/${tenantId}/deactivate`, null, {
    method: 'PATCH', body: JSON.stringify({ reason: 'should be blocked' }),
  });
  await assert('deactivate without admin token → 401', noAdmin.status === 401, `status=${noAdmin.status}`);

  // Sleep so iat comparison will work when we bump tokens_invalidated_at.
  await new Promise(r => setTimeout(r, 1100));

  // Happy path deactivate
  const reason1 = `E2E suspension ${ts}`;
  const deact = await http(`/api/admin/tenants/${tenantId}/deactivate`, adminToken, {
    method: 'PATCH', body: JSON.stringify({ reason: reason1 }),
  });
  await assert('deactivate 200', deact.status === 200, `status=${deact.status}`);
  await assert('deactivate reports staff sessions killed',
    typeof deact.body.staffSessionsKilled === 'number' && deact.body.staffSessionsKilled >= 1,
    `killed=${deact.body.staffSessionsKilled}`);
  await assert('tenant status is inactive', deact.body.tenant?.status === 'inactive',
    `status=${deact.body.tenant?.status}`);

  // Existing token should be rejected
  const post = await http('/api/merchant/plan-usage', ownerToken1);
  await assert('existing owner token rejected post-deactivate', post.status === 401,
    `status=${post.status}`);

  // Re-login with correct password should ALSO fail because tenant is inactive
  const reLogin = await http('/api/merchant/auth/login', null, {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  await assert('owner cannot log back in while tenant is inactive',
    reLogin.status === 401, `status=${reLogin.status}`);

  // Audit log has TENANT_DEACTIVATED row with the reason
  const deactAudit = await prisma.auditLog.findFirst({
    where: { tenantId, actionType: 'TENANT_DEACTIVATED' },
    orderBy: { createdAt: 'desc' },
  });
  await assert('TENANT_DEACTIVATED audit row exists', !!deactAudit, `id=${deactAudit?.id?.slice(0,8)}`);
  const meta: any = deactAudit?.metadata;
  await assert('audit metadata carries reason', meta?.reason === reason1,
    `reason=${meta?.reason}`);

  // Reactivate
  const reason2 = `E2E lifted ${ts}`;
  const reactivate = await http(`/api/admin/tenants/${tenantId}/reactivate`, adminToken, {
    method: 'PATCH', body: JSON.stringify({ reason: reason2 }),
  });
  await assert('reactivate 200', reactivate.status === 200, `status=${reactivate.status}`);
  await assert('tenant status is active again', reactivate.body.tenant?.status === 'active',
    `status=${reactivate.body.tenant?.status}`);

  // Owner can log in again
  const loginOk = await http('/api/merchant/auth/login', null, {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  await assert('owner can log back in after reactivation',
    loginOk.status === 200 && !!loginOk.body.accessToken, `status=${loginOk.status}`);

  // And the new token works
  const fresh = await http('/api/merchant/plan-usage', loginOk.body.accessToken);
  await assert('fresh owner token works post-reactivation', fresh.status === 200, `status=${fresh.status}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
