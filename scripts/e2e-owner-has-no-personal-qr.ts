/**
 * E2E for Genesis's 2026-04-24 ask: no personal QR for the owner role.
 *
 * Verifies two guarantees:
 *   - tenant signup flow never writes staff.qrCodeUrl for the owner
 *     (ownly the tenant QR ends up populated)
 *   - POST /api/merchant/staff/:id/qr on an owner row is rejected with
 *     400 (defense-in-depth: the UI hides the button, but a stale client
 *     couldn't slip one through either)
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { generateMerchantQR } from '../src/services/merchant-qr.js';
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
  let body: any = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== Owner has no personal QR E2E ===\n');

  const ts = Date.now();
  const tenant = await createTenant(`NoOwnerQR ${ts}`, `no-owner-qr-${ts}`, `no-owner-qr-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);

  // Mimic the signup sequence: create owner + generate merchant QR.
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `o-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  await generateMerchantQR(tenant.id);

  // ── Post-signup state: tenant has its QR, owner does NOT ──
  const tenantAfter = await prisma.tenant.findUnique({
    where: { id: tenant.id }, select: { qrCodeUrl: true },
  });
  const ownerAfter = await prisma.staff.findUnique({
    where: { id: owner.id }, select: { qrCodeUrl: true, qrSlug: true, qrGeneratedAt: true },
  });
  await assert('tenant QR was created at signup',
    !!tenantAfter?.qrCodeUrl && tenantAfter.qrCodeUrl.length > 0,
    `tenant.qrCodeUrl=${tenantAfter?.qrCodeUrl?.slice(0, 40)}...`);
  await assert('owner has NO personal QR after signup',
    ownerAfter?.qrCodeUrl === null && ownerAfter?.qrSlug === null && ownerAfter?.qrGeneratedAt === null,
    `qrCodeUrl=${ownerAfter?.qrCodeUrl} qrSlug=${ownerAfter?.qrSlug}`);

  // ── Owner tries to generate a personal QR via the API → 400 ──
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  const res = await http(`/api/merchant/staff/${owner.id}/qr`, ownerToken, { method: 'POST' });
  await assert('POST /staff/:ownerId/qr returns 400',
    res.status === 400,
    `status=${res.status}`);
  await assert('rejection message mentions owner + QR del comercio',
    typeof res.body?.error === 'string'
      && /owner/i.test(res.body.error)
      && /QR del comercio/i.test(res.body.error),
    `error=${res.body?.error}`);

  // ── DB confirmation: still no personal QR on owner after the rejected call ──
  const ownerFinal = await prisma.staff.findUnique({
    where: { id: owner.id }, select: { qrCodeUrl: true },
  });
  await assert('owner still has no personal QR after rejected request',
    ownerFinal?.qrCodeUrl === null,
    `qrCodeUrl=${ownerFinal?.qrCodeUrl}`);

  // ── A cashier on the same tenant CAN still get a personal QR (regression guard) ──
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cashier', email: `c-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
    },
  });
  const okRes = await http(`/api/merchant/staff/${cashier.id}/qr`, ownerToken, { method: 'POST' });
  await assert('cashier personal QR generation still works',
    okRes.status === 200 && typeof okRes.body?.qrCodeUrl === 'string',
    `status=${okRes.status} qrCodeUrl=${okRes.body?.qrCodeUrl?.slice(0, 40)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
