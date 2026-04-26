/**
 * E2E for Genesis's 2026-04-24 report:
 *
 *   "Al regenerar un nuevo codigo qr de cajero, el codigo escrito que se
 *    envia a WhatsApp (despues del escaneo) deberia cambiar. Sigue
 *    enviando el mismo codigo."
 *
 * Root cause: generateStaffQR reused the existing staff.qrSlug on every
 * call. Re-printing was idempotent (good) but REGENERATE (bad) never
 * rotated. The printed QR of a cashier who leaves could stay active.
 *
 * Behavior after fix:
 *   (1) First POST /api/merchant/staff/:id/qr sets a slug.
 *   (2) Second POST (with `reason`) regenerates → new slug, different
 *       from the first.
 *   (3) Old slug no longer resolves via parseStaffAttribution (stale QR
 *       is effectively invalidated).
 *   (4) New slug resolves to the same staffId.
 *   (5) The deepLink text that WhatsApp opens contains the new slug.
 *   (6) Regen WITHOUT a reason still fails 400 (regression guard).
 *   (7) Third regen fails (still capped at 2 regens per staff).
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { parseStaffAttribution } from '../src/services/whatsapp-bot.js';
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
  console.log('=== Staff QR rotate-on-regen E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`QR Rotate ${ts}`, `qr-rotate-${ts}`, `qr-rotate-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `owner-rot-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cajera Rot', email: `cashier-rot-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
    },
  });
  const tok = ownerToken(owner.id, tenant.id);

  // (1) First generation
  const gen1 = await http(`/api/merchant/staff/${cashier.id}/qr`, tok, {
    method: 'POST', body: JSON.stringify({}),
  });
  await assert('first POST /qr succeeds and returns a qrSlug',
    gen1.status === 200 && typeof gen1.body.qrSlug === 'string' && gen1.body.qrSlug.length === 8,
    `status=${gen1.status} slug=${gen1.body.qrSlug}`);
  const slug1 = gen1.body.qrSlug as string;
  const link1 = gen1.body.deepLink as string;

  // (2) Regenerate WITH a reason — slug must change
  const gen2 = await http(`/api/merchant/staff/${cashier.id}/qr`, tok, {
    method: 'POST', body: JSON.stringify({ reason: 'Cashier lost the poster' }),
  });
  await assert('regen with reason succeeds',
    gen2.status === 200 && typeof gen2.body.qrSlug === 'string',
    `status=${gen2.status}`);
  const slug2 = gen2.body.qrSlug as string;
  await assert('regen produces a DIFFERENT qrSlug (Genesis repro)',
    slug2 !== slug1,
    `slug1=${slug1} slug2=${slug2}`);

  // (3) Old slug no longer resolves
  const oldResolves = await parseStaffAttribution(`Valee Ref: ${tenant.slug} Cjr: ${slug1}`, tenant.id);
  await assert('old slug no longer resolves to a staffId',
    oldResolves === null,
    `resolved=${oldResolves}`);

  // (4) New slug resolves to the cashier
  const newResolves = await parseStaffAttribution(`Valee Ref: ${tenant.slug} Cjr: ${slug2}`, tenant.id);
  await assert('new slug resolves to the cashier staffId',
    newResolves === cashier.id,
    `resolved=${newResolves}`);

  // (5) The deep link text encodes the new slug
  const link2 = gen2.body.deepLink as string;
  await assert('deepLink contains the NEW slug and not the old one',
    link2.includes(encodeURIComponent(`Cjr: ${slug2}`)) && !link2.includes(encodeURIComponent(`Cjr: ${slug1}`)),
    `link2=${link2}`);
  // Sanity: the two links differ
  await assert('link1 and link2 differ',
    link1 !== link2, `same=${link1 === link2}`);

  // (6) Regen without reason fails 400 (pre-existing rule, must not regress)
  const badRegen = await http(`/api/merchant/staff/${cashier.id}/qr`, tok, {
    method: 'POST', body: JSON.stringify({}),
  });
  await assert('regen without reason rejected 400',
    badRegen.status === 400, `status=${badRegen.status}`);

  // (7) Third regen caps at 2 (existing business rule)
  const gen3 = await http(`/api/merchant/staff/${cashier.id}/qr`, tok, {
    method: 'POST', body: JSON.stringify({ reason: 'second regen attempt' }),
  });
  await assert('second regen still allowed (2 total)',
    gen3.status === 200, `status=${gen3.status}`);
  const slug3 = gen3.body.qrSlug as string;
  await assert('second regen also rotates',
    slug3 !== slug2, `slug2=${slug2} slug3=${slug3}`);

  const gen4 = await http(`/api/merchant/staff/${cashier.id}/qr`, tok, {
    method: 'POST', body: JSON.stringify({ reason: 'third attempt should fail' }),
  });
  await assert('third regen blocked by existing 2-regen cap',
    gen4.status === 403, `status=${gen4.status}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
