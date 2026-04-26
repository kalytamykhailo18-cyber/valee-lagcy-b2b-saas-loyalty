/**
 * E2E for Eric's 2026-04-24 ask:
 *
 *   "En el area de configuacion del comercio, abajo de los puntos de
 *    bienvenida no sale la opcion de configurar el bono de referidos.
 *    En el panel de referidos tampoco da la opcion."
 *
 * Backend column and PATCH handler already existed (referralBonusAmount
 * on Tenant). Two front-end entry points now write to the same field.
 * This script verifies the backend-side contract both paths rely on:
 *
 *   (1) GET /api/merchant/settings exposes referralBonusAmount.
 *   (2) PUT /api/merchant/settings accepts referralBonusAmount and
 *       persists it (both as a single-field update and alongside
 *       welcomeBonusAmount).
 *   (3) PUT rejects negatives / non-numbers with 400.
 *   (4) Setting to 0 is allowed (treated as "disabled").
 *   (5) Tenant isolation: writing tenantA's setting does not alter
 *       tenantB's value.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

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
  let body: any = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

function ownerToken(staffId: string, tenantId: string) {
  return jwt.sign(
    { staffId, tenantId, role: 'owner', type: 'staff' },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );
}

async function main() {
  console.log('=== Referral bonus config E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();

  const tenantA = await createTenant(`Ref Bonus A ${ts}`, `ref-bonus-a-${ts}`, `ref-bonus-a-${ts}@e2e.local`);
  await createSystemAccounts(tenantA.id);
  await prisma.tenantAssetConfig.create({ data: { tenantId: tenantA.id, assetTypeId: asset.id, conversionRate: 1 }});
  const ownerA = await prisma.staff.create({
    data: {
      tenantId: tenantA.id, name: 'Owner A', email: `owner-a-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const tokA = ownerToken(ownerA.id, tenantA.id);

  const tenantB = await createTenant(`Ref Bonus B ${ts}`, `ref-bonus-b-${ts}`, `ref-bonus-b-${ts}@e2e.local`);
  await createSystemAccounts(tenantB.id);
  await prisma.tenantAssetConfig.create({ data: { tenantId: tenantB.id, assetTypeId: asset.id, conversionRate: 1 }});
  const ownerB = await prisma.staff.create({
    data: {
      tenantId: tenantB.id, name: 'Owner B', email: `owner-b-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const tokB = ownerToken(ownerB.id, tenantB.id);

  // (1) GET exposes referralBonusAmount with default 100
  const get1 = await http('/api/merchant/settings', tokA);
  await assert('GET /merchant/settings returns referralBonusAmount (default 100)',
    get1.status === 200 && get1.body.referralBonusAmount === 100,
    `status=${get1.status} amount=${get1.body.referralBonusAmount}`);

  // (2a) PUT single-field update persists
  const put1 = await http('/api/merchant/settings', tokA, {
    method: 'PUT', body: JSON.stringify({ referralBonusAmount: 250 }),
  });
  await assert('PUT single-field referralBonusAmount=250 succeeds',
    put1.status === 200, `status=${put1.status}`);
  const get2 = await http('/api/merchant/settings', tokA);
  await assert('subsequent GET reflects the new value',
    get2.body.referralBonusAmount === 250,
    `amount=${get2.body.referralBonusAmount}`);

  // (2b) PUT together with welcomeBonusAmount (the /settings page path)
  const put2 = await http('/api/merchant/settings', tokA, {
    method: 'PUT', body: JSON.stringify({ welcomeBonusAmount: 777, referralBonusAmount: 333 }),
  });
  await assert('PUT with both welcome and referral bonus succeeds',
    put2.status === 200, `status=${put2.status}`);
  const get3 = await http('/api/merchant/settings', tokA);
  await assert('both welcome and referral amounts persist',
    get3.body.welcomeBonusAmount === 777 && get3.body.referralBonusAmount === 333,
    `welcome=${get3.body.welcomeBonusAmount} referral=${get3.body.referralBonusAmount}`);

  // (3) Negatives rejected
  const bad1 = await http('/api/merchant/settings', tokA, {
    method: 'PUT', body: JSON.stringify({ referralBonusAmount: -5 }),
  });
  await assert('negative referralBonusAmount rejected 400',
    bad1.status === 400, `status=${bad1.status}`);

  const bad2 = await http('/api/merchant/settings', tokA, {
    method: 'PUT', body: JSON.stringify({ referralBonusAmount: 'not a number' }),
  });
  await assert('non-number referralBonusAmount rejected 400',
    bad2.status === 400, `status=${bad2.status}`);

  // (4) 0 is allowed (disables the program)
  const zero = await http('/api/merchant/settings', tokA, {
    method: 'PUT', body: JSON.stringify({ referralBonusAmount: 0 }),
  });
  await assert('PUT referralBonusAmount=0 is accepted (disables program)',
    zero.status === 200, `status=${zero.status}`);
  const getZero = await http('/api/merchant/settings', tokA);
  await assert('GET returns 0 after disable',
    getZero.body.referralBonusAmount === 0,
    `amount=${getZero.body.referralBonusAmount}`);

  // (5) Tenant isolation
  await http('/api/merchant/settings', tokB, {
    method: 'PUT', body: JSON.stringify({ referralBonusAmount: 42 }),
  });
  const getA = await http('/api/merchant/settings', tokA);
  const getB = await http('/api/merchant/settings', tokB);
  await assert('tenantA and tenantB have independent referralBonusAmount values',
    getA.body.referralBonusAmount === 0 && getB.body.referralBonusAmount === 42,
    `A=${getA.body.referralBonusAmount} B=${getB.body.referralBonusAmount}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
