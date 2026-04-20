/**
 * E2E: welcome-bonus rows surface as WELCOME_BONUS in both the consumer
 * history and the merchant transactions endpoints, and both UIs label
 * them 'Puntos de Bienvenida' (Genesis L3).
 *
 * Without this, the merchant dashboard rendered 'Ajuste manual +50'
 * when what really happened was the initial welcome bonus.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { grantWelcomeBonus } from '../src/services/welcome-bonus.js';
import { issueStaffTokens, issueConsumerTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== Welcome-bonus label E2E (consumer + merchant) ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Welcome Label ${ts}`, `welcome-label-${ts}`, `wl-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { welcomeBonusAmount: 50 },
  });

  // Seed owner + consumer + grant welcome bonus
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `wl-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const phone = `+19000${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);
  const grant = await grantWelcomeBonus(consumer.id, tenant.id, asset.id);
  await assert('welcome bonus granted', grant.granted === true, `amount=${grant.amount}`);

  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;
  const consumerToken = issueConsumerTokens({
    accountId: consumer.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;

  // Merchant transactions endpoint
  const tx = await http(`/api/merchant/transactions?limit=20`, ownerToken);
  await assert('merchant transactions 200', tx.status === 200, `status=${tx.status}`);
  const welcomeEntry = tx.body.entries.find((e: any) =>
    String(e.referenceId || '').startsWith(`WELCOME-${consumer.id}`)
  );
  await assert('merchant transactions surface the welcome row', !!welcomeEntry,
    `found=${!!welcomeEntry}`);
  await assert('merchant row emits WELCOME_BONUS event type (not ADJUSTMENT_MANUAL)',
    welcomeEntry?.eventType === 'WELCOME_BONUS',
    `eventType=${welcomeEntry?.eventType}`);

  // Consumer history endpoint
  const hist = await http(`/api/consumer/history`, consumerToken);
  await assert('consumer history 200', hist.status === 200, `status=${hist.status}`);
  const consumerWelcome = hist.body.entries.find((e: any) =>
    String(e.referenceId || '').startsWith(`WELCOME-${consumer.id}`)
  );
  await assert('consumer history emits WELCOME_BONUS too',
    consumerWelcome?.eventType === 'WELCOME_BONUS',
    `eventType=${consumerWelcome?.eventType}`);

  // UI: both chunks carry the 'Puntos de Bienvenida' label
  const merchantHtml = await (await fetch(`${FRONTEND}/merchant`)).text();
  const mChunks = Array.from(merchantHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const mBodies = await Promise.all(mChunks.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('merchant chunks contain "Puntos de Bienvenida"',
    mBodies.some(js => js.includes('Puntos de Bienvenida')),
    `scanned=${mChunks.length}`);

  const consumerHtml = await (await fetch(`${FRONTEND}/consumer`)).text();
  const cChunks = Array.from(consumerHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const cBodies = await Promise.all(cChunks.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('consumer chunks contain "Puntos de Bienvenida"',
    cBodies.some(js => js.includes('Puntos de Bienvenida')),
    `scanned=${cChunks.length}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
