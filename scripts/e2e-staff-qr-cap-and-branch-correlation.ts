/**
 * E2E for Eric's 2026-04-23 WhatsApp asks:
 *
 *   (1) "cuando creo un qr puedo regenerarlo X cantidad de clicks
 *        que desee y no deberia funcionar asi"
 *       → staff QR regeneration must be capped at 2, mandatory
 *         reason (min 3 chars), same model as branch QR.
 *
 *   (2) "no veo correlacion entre una sucursal y sus cajeros"
 *       → /api/merchant/branches must surface the cashiers
 *         assigned to each branch, plus a mainBranch summary for
 *         cashiers attached to the tenant (branchId=null).
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
  console.log('=== Staff QR cap + sucursal-cajero correlation E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`QR Cap ${ts}`, `qr-cap-${ts}`, `qr-cap-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({ where: { id: tenant.id }, data: { plan: 'x10' } });

  const branchA = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal A', active: true },
  });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const token = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  // ── Create a cashier on branchA AND another on "sede principal" (null) ──
  const createA = await http('/api/merchant/staff', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Cajero A', email: `ca-${ts}@e2e.local`,
      password: 'pw', role: 'cashier', branchId: branchA.id,
    }),
  });
  const cashierA = createA.body.staff.id;
  const createMain = await http('/api/merchant/staff', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Cajero Main', email: `cm-${ts}@e2e.local`,
      password: 'pw', role: 'cashier',
    }),
  });
  await assert('cashiers created (branch + sede principal)',
    createA.status === 200 && createMain.status === 200,
    `${createA.status} / ${createMain.status}`);

  // ── Asks (2): branches endpoint surfaces cashiers per branch + main ──
  const branchesRes = await http('/api/merchant/branches', token);
  const branchA_out = branchesRes.body.branches.find((b: any) => b.id === branchA.id);
  await assert('branch carries cashierCount',
    branchA_out?.cashierCount === 1,
    `count=${branchA_out?.cashierCount}`);
  await assert('branch carries cashiers list with name + email',
    Array.isArray(branchA_out?.cashiers)
    && branchA_out.cashiers.length === 1
    && branchA_out.cashiers[0].name === 'Cajero A'
    && branchA_out.cashiers[0].email === `ca-${ts}@e2e.local`,
    `cashiers=${JSON.stringify(branchA_out?.cashiers)}`);
  await assert('mainBranch summary includes sede-principal cashier',
    branchesRes.body.mainBranch?.cashierCount === 1
    && branchesRes.body.mainBranch.cashiers[0].name === 'Cajero Main',
    `mainBranch=${JSON.stringify(branchesRes.body.mainBranch)}`);

  // ── Asks (1): staff QR regen cap ──
  // First generation = NOT a regen. No reason required.
  const gen1 = await http(`/api/merchant/staff/${cashierA}/qr`, token, { method: 'POST' });
  await assert('initial staff QR generation succeeds (no reason needed)',
    gen1.status === 200,
    `status=${gen1.status}`);

  // Second call is a regen — requires reason.
  const gen2NoReason = await http(`/api/merchant/staff/${cashierA}/qr`, token, { method: 'POST' });
  await assert('second call without reason is rejected',
    gen2NoReason.status === 400,
    `status=${gen2NoReason.status}`);

  const gen2 = await http(`/api/merchant/staff/${cashierA}/qr`, token, {
    method: 'POST', body: JSON.stringify({ reason: 'Se mojo el papel' }),
  });
  await assert('first regen with reason succeeds',
    gen2.status === 200,
    `status=${gen2.status}`);

  const gen3 = await http(`/api/merchant/staff/${cashierA}/qr`, token, {
    method: 'POST', body: JSON.stringify({ reason: 'Cambio de cajero' }),
  });
  await assert('second regen with reason succeeds',
    gen3.status === 200,
    `status=${gen3.status}`);

  const gen4 = await http(`/api/merchant/staff/${cashierA}/qr`, token, {
    method: 'POST', body: JSON.stringify({ reason: 'Otro intento' }),
  });
  await assert('third regen is blocked with 403',
    gen4.status === 403,
    `status=${gen4.status}`);
  await assert('block message points to soporte@valee.app',
    typeof gen4.body?.error === 'string' && gen4.body.error.includes('soporte@valee.app'),
    `error=${gen4.body?.error}`);

  // ── Staff list exposes qrRegenCount / qrRegenLocked ──
  const list = await http('/api/merchant/staff', token);
  const row = list.body.staff.find((s: any) => s.id === cashierA);
  await assert('list exposes qrRegenCount=2 after two regens',
    row?.qrRegenCount === 2 && row?.qrRegenLocked === true && row?.qrRegenCap === 2,
    `row=${JSON.stringify({ count: row?.qrRegenCount, locked: row?.qrRegenLocked, cap: row?.qrRegenCap })}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
