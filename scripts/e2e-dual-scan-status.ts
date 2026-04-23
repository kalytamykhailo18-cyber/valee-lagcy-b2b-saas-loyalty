/**
 * E2E for Eric's 2026-04-23 Notion ask on "Pago en efectivo":
 *
 *   "Al hacer el pago en efectivo y tener la aprobacion del lado de
 *    consumer, tengo que tener la misma animacion del lado del merchant
 *    para saber si el codigo se escaneo exitosamente y no esperar que
 *    venza el codigo."
 *
 * The new GET /api/merchant/dual-scan/status/:nonce lets the merchant
 * dashboard poll for confirmation. Before the consumer confirms, it
 * returns { consumed: false }. After confirm it returns the payer phone,
 * amount, and timestamp so the dashboard can swap to a green success
 * animation without waiting for the TTL to expire.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { issueStaffTokens, issueConsumerTokens } from '../src/services/auth.js';
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

function decodeNonce(token: string): string {
  const raw = Buffer.from(token, 'base64').toString('utf-8');
  const { payload } = JSON.parse(raw);
  return payload.nonce;
}

async function main() {
  console.log('=== Dual-scan status-poll E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Dual Poll ${ts}`, `dual-poll-${ts}`, `dual-poll-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  // Owner (for initiate) and consumer
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `o-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  const phone = `+19300${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);
  const consumerToken = issueConsumerTokens({
    accountId: consumer.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;

  // --- Cashier initiates a dual-scan for $20 ---
  const init = await http('/api/merchant/dual-scan/initiate', ownerToken, {
    method: 'POST',
    body: JSON.stringify({ amount: '20' }),
  });
  await assert('dual-scan initiate succeeds',
    init.status === 200 && typeof init.body?.token === 'string',
    `status=${init.status}`);
  const dualToken: string = init.body.token;
  const nonce = decodeNonce(dualToken);
  await assert('nonce decodes from token',
    /^[a-f0-9]{16}$/.test(nonce),
    `nonce=${nonce}`);

  // --- Status BEFORE confirm → consumed: false ---
  const pre = await http(`/api/merchant/dual-scan/status/${nonce}`, ownerToken);
  await assert('status before confirm returns consumed=false',
    pre.status === 200 && pre.body.consumed === false,
    `status=${pre.status} body=${JSON.stringify(pre.body)}`);

  // --- Invalid nonce → 400 ---
  const bad = await http('/api/merchant/dual-scan/status/not-a-valid-nonce', ownerToken);
  await assert('invalid nonce returns 400',
    bad.status === 400,
    `status=${bad.status}`);

  // --- Consumer confirms (simulates them scanning the QR from the PWA) ---
  const confirm = await http('/api/consumer/dual-scan/confirm', consumerToken, {
    method: 'POST',
    body: JSON.stringify({ token: dualToken }),
  });
  await assert('consumer confirm succeeds',
    confirm.status === 200 && confirm.body.success === true,
    `status=${confirm.status} msg=${confirm.body?.message}`);

  // --- Status AFTER confirm → consumed: true with payer info ---
  const post = await http(`/api/merchant/dual-scan/status/${nonce}`, ownerToken);
  await assert('status after confirm returns consumed=true',
    post.status === 200 && post.body.consumed === true,
    `body=${JSON.stringify(post.body)}`);
  await assert('response carries payer phone and value',
    post.body.consumerPhone === phone
      && Number(post.body.valueAssigned) > 0
      && typeof post.body.confirmedAt === 'string',
    `payer=${post.body.consumerPhone} value=${post.body.valueAssigned} ts=${post.body.confirmedAt}`);

  // --- Cross-tenant isolation: a second tenant's owner cannot read this nonce ---
  const otherTenant = await createTenant(`Other ${ts}`, `other-${ts}`, `other-${ts}@e2e.local`);
  await createSystemAccounts(otherTenant.id);
  const otherOwner = await prisma.staff.create({
    data: {
      tenantId: otherTenant.id, name: 'Other', email: `x-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const otherToken = issueStaffTokens({
    staffId: otherOwner.id, tenantId: otherTenant.id, role: 'owner', type: 'staff',
  }).accessToken;
  const cross = await http(`/api/merchant/dual-scan/status/${nonce}`, otherToken);
  await assert('different tenant sees consumed=false (isolation)',
    cross.status === 200 && cross.body.consumed === false,
    `body=${JSON.stringify(cross.body)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
