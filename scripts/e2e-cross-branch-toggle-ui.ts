/**
 * E2E: Configuracion page ships the cross-branch toggle (Genesis H11 Re Do).
 *
 * The backend policy was live but Genesis had no way to flip it from
 * the UI — she marked H11 Re Do for that reason. This test drives the
 * full loop: load settings → toggle off via PUT → read back → toggle
 * on → read back, and chunk-greps the /merchant/settings page for the
 * new UI copy.
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
  console.log('=== Cross-branch toggle in settings UI E2E ===\n');

  const ts = Date.now();
  const tenant = await createTenant(`CBUI ${ts}`, `cbui-${ts}`, `cbui-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { rif: 'J-12345678-9' },
  });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `cbui-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  async function get() {
    const r = await fetch(`${API}/api/merchant/settings`, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    return { status: r.status, body: await r.json() as any };
  }
  async function put(body: any) {
    return fetch(`${API}/api/merchant/settings`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  const initial = await get();
  await assert('settings GET 200', initial.status === 200, `status=${initial.status}`);
  await assert('default crossBranchRedemption=true',
    initial.body.crossBranchRedemption === true,
    `value=${initial.body.crossBranchRedemption}`);

  // Toggle off
  const r1 = await put({ crossBranchRedemption: false });
  await assert('PUT accepts crossBranchRedemption=false',
    r1.status === 200, `status=${r1.status}`);
  const after1 = await get();
  await assert('GET echoes crossBranchRedemption=false',
    after1.body.crossBranchRedemption === false,
    `value=${after1.body.crossBranchRedemption}`);

  // Toggle on
  const r2 = await put({ crossBranchRedemption: true });
  await assert('PUT accepts crossBranchRedemption=true',
    r2.status === 200, `status=${r2.status}`);
  const after2 = await get();
  await assert('GET echoes crossBranchRedemption=true',
    after2.body.crossBranchRedemption === true,
    `value=${after2.body.crossBranchRedemption}`);

  // Bad type
  const r3 = await put({ crossBranchRedemption: 'yes' as any });
  await assert('PUT rejects non-boolean crossBranchRedemption',
    r3.status === 400, `status=${r3.status}`);

  // Frontend chunk ships the toggle copy
  const html = await (await fetch(`${FRONTEND}/merchant/settings`)).text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('settings chunk ships "Canje entre sucursales"',
    chunkBodies.some(js => js.includes('Canje entre sucursales')),
    `scanned=${chunkUrls.length}`);
  await assert('settings chunk ships the "cualquier sucursal" helper copy',
    chunkBodies.some(js => js.includes('cualquier sucursal')),
    'verified');
  await assert('settings chunk ships the "solo pueden canjear" helper copy',
    chunkBodies.some(js => js.includes('solo pueden canjear')),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
