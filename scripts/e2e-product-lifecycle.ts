/**
 * E2E: product lifecycle — 2-edit cap, stock-coupled toggle, archive.
 *
 * Eric's rules from the 2026-04-22 group call:
 *   1. A product card is "identity-edited" at most 2 times. After
 *      that, editing is blocked and the merchant must archive it and
 *      create a new one.  Stock and the active toggle do NOT count.
 *   2. Stock=0 auto-disables the card. Re-enabling via the toggle
 *      while stock=0 is rejected ("no tienes stock"). When stock
 *      returns, a card that was auto-disabled flips back on; a card
 *      the owner explicitly deactivated stays off.
 *   3. Instead of deleting, merchants archive. Archived cards hide
 *      from the consumer catalog but keep redemption_tokens FK intact.
 *      Unarchive does NOT consume an edit slot.
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
  console.log('=== Product lifecycle E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Product Life ${ts}`, `prod-life-${ts}`, `prod-life-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
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

  // --- Create product (stock=10, name=Pizza) ---
  const create = await http('/api/merchant/products', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Pizza', description: 'slice', redemptionCost: '100',
      assetTypeId: asset.id, stock: 10, minLevel: 1,
    }),
  });
  await assert('create succeeds', create.status === 200, `status=${create.status}`);
  const pid = create.body.product.id;

  // --- Stock/minLevel changes are NOT identity edits ---
  await http(`/api/merchant/products/${pid}`, token, {
    method: 'PUT',
    body: JSON.stringify({ stock: 20, minLevel: 2 }),
  });
  let p = (await http(`/api/merchant/products`, token)).body.products.find((x: any) => x.id === pid);
  await assert('stock/minLevel change does not consume edit slot',
    p.identityEditCount === 0,
    `count=${p.identityEditCount}`);

  // --- Identity edit #1 (description) ---
  const edit1 = await http(`/api/merchant/products/${pid}`, token, {
    method: 'PUT', body: JSON.stringify({ description: 'pepperoni slice' }),
  });
  await assert('first identity edit allowed',
    edit1.status === 200 && edit1.body.product.identityEditCount === 1,
    `count=${edit1.body?.product?.identityEditCount}`);

  // --- Identity edit #2 (redemptionCost) ---
  const edit2 = await http(`/api/merchant/products/${pid}`, token, {
    method: 'PUT', body: JSON.stringify({ redemptionCost: '120' }),
  });
  await assert('second identity edit allowed',
    edit2.status === 200 && edit2.body.product.identityEditCount === 2,
    `count=${edit2.body?.product?.identityEditCount}`);

  // --- Identity edit #3 (name) — rejected ---
  const edit3 = await http(`/api/merchant/products/${pid}`, token, {
    method: 'PUT', body: JSON.stringify({ name: 'Water' }),
  });
  await assert('third identity edit rejected',
    edit3.status === 403,
    `status=${edit3.status}`);
  await assert('rejection message mentions archivar',
    typeof edit3.body?.error === 'string' && edit3.body.error.toLowerCase().includes('archi'),
    `error=${edit3.body?.error}`);

  // --- Stock change still allowed after cap ---
  const postCapStock = await http(`/api/merchant/products/${pid}`, token, {
    method: 'PUT', body: JSON.stringify({ stock: 5 }),
  });
  await assert('stock change after edit cap still allowed',
    postCapStock.status === 200 && postCapStock.body.product.stock === 5,
    `status=${postCapStock.status}`);

  // --- Stock → 0 auto-disables and flags stockAutoDisabled ---
  const out = await http(`/api/merchant/products/${pid}`, token, {
    method: 'PUT', body: JSON.stringify({ stock: 0 }),
  });
  await assert('stock=0 auto-disables',
    out.body.product.active === false && out.body.product.stockAutoDisabled === true,
    `active=${out.body?.product?.active} auto=${out.body?.product?.stockAutoDisabled}`);

  // --- Toggle ON with stock=0 → 400 ---
  const toggleNoStock = await http(`/api/merchant/products/${pid}/toggle`, token, { method: 'PATCH' });
  await assert('toggle ON with stock=0 is rejected',
    toggleNoStock.status === 400,
    `status=${toggleNoStock.status}`);

  // --- Stock returns — auto-re-enables because stockAutoDisabled was set ---
  const restock = await http(`/api/merchant/products/${pid}`, token, {
    method: 'PUT', body: JSON.stringify({ stock: 10 }),
  });
  await assert('stock restock auto-reactivates auto-disabled card',
    restock.body.product.active === true && restock.body.product.stockAutoDisabled === false,
    `active=${restock.body?.product?.active} auto=${restock.body?.product?.stockAutoDisabled}`);

  // --- Owner explicitly deactivates, then stock drops and returns —
  //     it should STAY OFF (owner intent preserved) ---
  await http(`/api/merchant/products/${pid}/toggle`, token, { method: 'PATCH' }); // now inactive, stockAutoDisabled=false
  const ownerOff = (await http(`/api/merchant/products`, token)).body.products.find((x: any) => x.id === pid);
  await assert('after explicit toggle off, stockAutoDisabled is false',
    ownerOff.active === false && ownerOff.stockAutoDisabled === false,
    `active=${ownerOff.active} auto=${ownerOff.stockAutoDisabled}`);

  await http(`/api/merchant/products/${pid}`, token, {
    method: 'PUT', body: JSON.stringify({ stock: 0 }),
  });
  // ownerOff had active=false already, so stock→0 should NOT set auto flag
  const stillOff = (await http(`/api/merchant/products`, token)).body.products.find((x: any) => x.id === pid);
  await assert('owner-disabled + stock=0 does not set auto-disabled',
    stillOff.active === false && stillOff.stockAutoDisabled === false,
    `active=${stillOff.active} auto=${stillOff.stockAutoDisabled}`);

  const ownerBack = await http(`/api/merchant/products/${pid}`, token, {
    method: 'PUT', body: JSON.stringify({ stock: 15 }),
  });
  await assert('restock respects owner-disabled intent (stays off)',
    ownerBack.body.product.active === false,
    `active=${ownerBack.body?.product?.active}`);

  // --- Archive the card ---
  const arch = await http(`/api/merchant/products/${pid}/archive`, token, { method: 'PATCH' });
  await assert('archive succeeds', arch.status === 200 && arch.body.product.archivedAt,
    `status=${arch.status}`);

  // --- Archived card is NOT in the default list ---
  const listActive = await http('/api/merchant/products', token);
  await assert('archived card hidden from default list',
    !listActive.body.products.some((x: any) => x.id === pid),
    `count=${listActive.body?.products?.length}`);

  const listArchived = await http('/api/merchant/products?archived=true', token);
  await assert('archived card visible in ?archived=true list',
    listArchived.body.products.some((x: any) => x.id === pid),
    `count=${listArchived.body?.products?.length}`);

  // --- Edit on archived is blocked even if slots remain ---
  // (Create a second product, archive it without spending edits.)
  const c2 = await http('/api/merchant/products', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Coke', redemptionCost: '50', assetTypeId: asset.id, stock: 5,
    }),
  });
  const p2 = c2.body.product.id;
  await http(`/api/merchant/products/${p2}/archive`, token, { method: 'PATCH' });
  const editArch = await http(`/api/merchant/products/${p2}`, token, {
    method: 'PUT', body: JSON.stringify({ description: 'new' }),
  });
  await assert('editing an archived card is rejected',
    editArch.status === 409,
    `status=${editArch.status}`);

  // --- Unarchive (does not consume edit slot) ---
  const unarch = await http(`/api/merchant/products/${p2}/unarchive`, token, { method: 'PATCH' });
  await assert('unarchive succeeds and no edit slot consumed',
    unarch.status === 200 && unarch.body.product.identityEditCount === 0,
    `count=${unarch.body?.product?.identityEditCount}`);

  // --- Consumer catalog filter: archived card never shows up ---
  // (Archived pid on the same tenant; look it up raw since the
  // consumer catalog endpoint needs OTP auth — we read via Prisma.)
  const inCatalog = await prisma.product.findFirst({
    where: { id: pid, tenantId: tenant.id, archivedAt: null },
  });
  await assert('archived product excluded by archivedAt:null filter',
    inCatalog === null,
    `row=${inCatalog ? 'present' : 'absent'}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
