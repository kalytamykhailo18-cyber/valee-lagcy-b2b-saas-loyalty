/**
 * E2E: cedula validation on both merchant endpoints that write cedula.
 *
 * Genesis flagged two cases where merchants saved garbage:
 *   - 'sssss' (pure letters)
 *   - '21123456FFFFF' (digits followed by garbage)
 * Both stored as-is because the only normalization was whitespace-strip.
 *
 * Covers:
 *   POST /api/merchant/identity-upgrade (shadow → verified)
 *   PATCH /api/merchant/customers/:id (edit existing account cedula)
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';
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
      'Authorization': `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== Cedula validation E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Cedula E2E ${ts}`, `cedula-e2e-${ts}`, `cedula-e2e-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const staff = await prisma.staff.create({
    data: {
      tenantId: tenant.id,
      name: 'Cedula E2E Owner',
      email: `cedula-e2e-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10),
      role: 'owner',
    },
  });
  const token = issueStaffTokens({
    staffId: staff.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  const phone = `+19100${String(ts).slice(-7)}`;
  await findOrCreateConsumerAccount(tenant.id, phone);

  // ── identity-upgrade endpoint ──

  // Pure-garbage cedula → rejected
  const r1 = await http('/api/merchant/identity-upgrade', token, {
    method: 'POST', body: JSON.stringify({ phoneNumber: phone, cedula: 'sssss' }),
  });
  await assert('identity-upgrade rejects pure-letters cedula',
    r1.status === 400 && /cedula invalida/i.test(r1.body?.error || ''),
    `status=${r1.status} err=${r1.body?.error}`);

  // Digits + garbage suffix → rejected
  const r2 = await http('/api/merchant/identity-upgrade', token, {
    method: 'POST', body: JSON.stringify({ phoneNumber: phone, cedula: '21123456FFFFF' }),
  });
  await assert('identity-upgrade rejects digits+garbage cedula',
    r2.status === 400, `status=${r2.status}`);

  // Short (< 6 digits) → rejected
  const r3 = await http('/api/merchant/identity-upgrade', token, {
    method: 'POST', body: JSON.stringify({ phoneNumber: phone, cedula: 'V12345' }),
  });
  await assert('identity-upgrade rejects cedula shorter than 6 digits',
    r3.status === 400, `status=${r3.status}`);

  // Valid — plain digits → normalizes to V-prefix
  const r4 = await http('/api/merchant/identity-upgrade', token, {
    method: 'POST', body: JSON.stringify({ phoneNumber: phone, cedula: '12345678' }),
  });
  await assert('identity-upgrade accepts 8-digit cedula',
    r4.status === 200, `status=${r4.status} err=${r4.body?.error}`);
  await assert('stored cedula normalized to V-prefix format',
    r4.body?.account?.cedula === 'V-12345678',
    `stored=${r4.body?.account?.cedula}`);

  // ── PATCH /customers/:id ──

  const phoneB = `+19100${String(ts).slice(-7)}X`;
  const { account: accountB } = await findOrCreateConsumerAccount(tenant.id, phoneB);

  // Garbage rejected
  const p1 = await http(`/api/merchant/customers/${accountB.id}`, token, {
    method: 'PATCH', body: JSON.stringify({ cedula: 'sssss' }),
  });
  await assert('PATCH /customers rejects garbage cedula',
    p1.status === 400, `status=${p1.status} err=${p1.body?.error}`);

  // Valid with E prefix
  const p2 = await http(`/api/merchant/customers/${accountB.id}`, token, {
    method: 'PATCH', body: JSON.stringify({ cedula: 'E87654321' }),
  });
  await assert('PATCH /customers accepts E-prefix cedula',
    p2.status === 200, `status=${p2.status} err=${p2.body?.error}`);

  const rowB = await prisma.account.findUnique({ where: { id: accountB.id } });
  await assert('stored normalized with E-prefix + separator',
    rowB?.cedula === 'E-87654321', `stored=${rowB?.cedula}`);

  // Setting cedula to null clears it
  const p3 = await http(`/api/merchant/customers/${accountB.id}`, token, {
    method: 'PATCH', body: JSON.stringify({ cedula: null }),
  });
  await assert('PATCH /customers clears cedula when null',
    p3.status === 200, `status=${p3.status}`);
  const rowC = await prisma.account.findUnique({ where: { id: accountB.id } });
  await assert('cedula null after clear', rowC?.cedula === null, `stored=${rowC?.cedula}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
