/**
 * E2E: cashier branch assignment can be edited exactly once.
 *
 * Eric's rule: when creating cashiers, the owner must pick a sucursal.
 * That assignment can be changed ONCE from the panel. A second edit
 * is rejected with a message telling the owner to contact
 * soporte@valee.app — same model as the merchant QR change limit.
 *
 * Hits the running API at SMOKE_API_BASE (default http://localhost:3000).
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
  console.log('=== Cashier branch edit-once E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Branch Edit ${ts}`, `branch-edit-${ts}`, `branch-edit-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  // This test creates > 3 staff members across its steps. Skip the basic
  // plan's 3-staff cap so the plan-limit path doesn't bleed into these
  // assertions — the cap is exercised separately in e2e-plan-limits.
  await prisma.tenant.update({ where: { id: tenant.id }, data: { plan: 'x10' } });

  const branchA = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal A', active: true },
  });
  const branchB = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal B', active: true },
  });
  const branchC = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal C', active: true },
  });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  // --- 1. Creating a cashier WITHOUT branch lands on "sede principal"
  // (Eric's 2026-04-23 Notion card: the tenant's main location should
  // always be a valid target, even when it has no Branch row). branchId
  // stays null and the UI renders the cashier as "Sede principal".
  const createNoBranch = await http('/api/merchant/staff', ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Pedro Sede Principal', email: `pedro-main-${ts}@e2e.local`,
      password: 'pw', role: 'cashier',
    }),
  });
  await assert('create cashier without branchId assigns to sede principal',
    createNoBranch.status === 200 && createNoBranch.body.staff.branchId === null,
    `status=${createNoBranch.status} branchId=${createNoBranch.body?.staff?.branchId}`);

  // --- 2. Creating a cashier WITH a valid branch succeeds
  const createOk = await http('/api/merchant/staff', ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Pedro Perez', email: `pedro-${ts}@e2e.local`,
      password: 'pw', role: 'cashier', branchId: branchA.id,
    }),
  });
  await assert('create cashier with branchId succeeds',
    createOk.status === 200 && createOk.body?.staff?.branchId === branchA.id,
    `status=${createOk.status} branchId=${createOk.body?.staff?.branchId}`);
  const pedroId = createOk.body.staff.id;

  // --- 3. branchId from a different tenant is rejected
  const otherTenant = await createTenant(`Other ${ts}`, `other-${ts}`, `other-${ts}@e2e.local`);
  const foreignBranch = await prisma.branch.create({
    data: { tenantId: otherTenant.id, name: 'Foreign', active: true },
  });
  const createForeign = await http('/api/merchant/staff', ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Foreign', email: `foreign-${ts}@e2e.local`,
      password: 'pw', role: 'cashier', branchId: foreignBranch.id,
    }),
  });
  await assert('create with foreign branchId rejected',
    createForeign.status === 400,
    `status=${createForeign.status}`);

  // --- 4. First branch change succeeds
  const change1 = await http(`/api/merchant/staff/${pedroId}/branch`, ownerToken, {
    method: 'PATCH', body: JSON.stringify({ branchId: branchB.id }),
  });
  await assert('first branch change succeeds',
    change1.status === 200 && change1.body?.staff?.branchId === branchB.id,
    `status=${change1.status} branchId=${change1.body?.staff?.branchId}`);

  // --- 5. Second branch change is rejected with 403 and soporte@valee.app message
  const change2 = await http(`/api/merchant/staff/${pedroId}/branch`, ownerToken, {
    method: 'PATCH', body: JSON.stringify({ branchId: branchC.id }),
  });
  await assert('second branch change is rejected',
    change2.status === 403,
    `status=${change2.status}`);
  await assert('second-change error mentions soporte@valee.app',
    typeof change2.body?.error === 'string' && change2.body.error.includes('soporte@valee.app'),
    `error=${change2.body?.error}`);

  // --- 6. Branch stayed at B (not moved to C)
  const afterSecond = await prisma.staff.findUnique({
    where: { id: pedroId }, select: { branchId: true },
  });
  await assert('cashier branch unchanged after rejected second edit',
    afterSecond?.branchId === branchB.id,
    `got=${afterSecond?.branchId} expected=${branchB.id}`);

  // --- 7. listStaff exposes branchLocked=true after the single allowed edit
  const listRes = await http('/api/merchant/staff', ownerToken);
  const pedroRow = listRes.body?.staff?.find((s: any) => s.id === pedroId);
  await assert('list marks branchLocked=true after first edit',
    pedroRow?.branchLocked === true && pedroRow?.branchChangeCount === 1,
    `branchLocked=${pedroRow?.branchLocked} count=${pedroRow?.branchChangeCount}`);

  // --- 8. Same-branch edit is 400 and does NOT consume the one allowed edit
  const freshCreate = await http('/api/merchant/staff', ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Fresh', email: `fresh-${ts}@e2e.local`,
      password: 'pw', role: 'cashier', branchId: branchA.id,
    }),
  });
  const freshId = freshCreate.body.staff.id;
  const sameBranch = await http(`/api/merchant/staff/${freshId}/branch`, ownerToken, {
    method: 'PATCH', body: JSON.stringify({ branchId: branchA.id }),
  });
  await assert('same-branch edit is rejected as 400 (no-op)',
    sameBranch.status === 400,
    `status=${sameBranch.status}`);
  const freshListRes = await http('/api/merchant/staff', ownerToken);
  const freshRow = freshListRes.body?.staff?.find((s: any) => s.id === freshId);
  await assert('same-branch edit did not burn the one allowed edit',
    freshRow?.branchLocked === false && freshRow?.branchChangeCount === 0,
    `locked=${freshRow?.branchLocked} count=${freshRow?.branchChangeCount}`);

  // --- 9. PATCH accepts null to move back to sede principal (same
  //        one-edit rule — Eric's 2026-04-23 Notion card).
  const toMain = await http(`/api/merchant/staff/${freshId}/branch`, ownerToken, {
    method: 'PATCH', body: JSON.stringify({ branchId: null }),
  });
  await assert('edit to sede principal (branchId=null) is allowed',
    toMain.status === 200 && toMain.body?.staff?.branchId === null,
    `status=${toMain.status} branchId=${toMain.body?.staff?.branchId}`);

  // That edit consumed the one-time slot — a second edit is blocked.
  const toMainAgain = await http(`/api/merchant/staff/${freshId}/branch`, ownerToken, {
    method: 'PATCH', body: JSON.stringify({ branchId: branchB.id }),
  });
  await assert('second edit after moving to sede principal is rejected',
    toMainAgain.status === 403,
    `status=${toMainAgain.status}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
