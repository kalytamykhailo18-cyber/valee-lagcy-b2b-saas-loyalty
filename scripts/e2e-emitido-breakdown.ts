/**
 * E2E: the merchant dashboard 'Emitido' tile breaks down into 3
 * sub-lines — Facturas, Bienvenidas, Manuales — so the owner sees
 * where the emitted points came from (Genesis M2).
 *
 * Seeds all 3 kinds of emission on one tenant, then asserts the
 * /api/merchant/metrics response exposes the three fields and that
 * Emitido = Facturas + Bienvenidas + Manuales. Also chunk-greps the
 * frontend /merchant build for the three new labels.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { grantWelcomeBonus } from '../src/services/welcome-bonus.js';
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
  console.log('=== Merchant Emitido breakdown E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Emitido BD ${ts}`, `emitido-bd-${ts}`, `emitido-bd-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { welcomeBonusAmount: 50 },
  });

  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;
  const phone = `+19000${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);

  // Invoice emission — 240 pts
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '240', assetTypeId: asset.id,
    referenceId: `INV-${ts}`, referenceType: 'invoice',
    metadata: { source: 'e2e' },
  });

  // Welcome bonus — 50 pts via the service (guarantees WELCOME- prefix)
  const grant = await grantWelcomeBonus(consumer.id, tenant.id, asset.id);
  await assert('welcome bonus seeded', grant.granted === true && grant.amount.startsWith('50'),
    `granted=${grant.granted} amount=${grant.amount}`);

  // Manual admin adjustment — 17 pts
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '17', assetTypeId: asset.id,
    referenceId: `MANUAL-${ts}`, referenceType: 'manual_adjustment',
    metadata: { type: 'admin_correction', reason: 'test' },
  });

  // Auth as owner so we hit the real metrics endpoint
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `emitido-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  const res = await fetch(`${API}/api/merchant/metrics`, {
    headers: { 'Authorization': `Bearer ${ownerToken}` },
  });
  const body: any = await res.json();
  await assert('/api/merchant/metrics 200', res.status === 200, `status=${res.status}`);

  const invoices = parseFloat(body.valueIssuedInvoices || '0');
  const welcome  = parseFloat(body.valueIssuedWelcome  || '0');
  const manual   = parseFloat(body.valueIssuedManual   || '0');
  const total    = parseFloat(body.valueIssued         || '0');

  await assert('Facturas equals 240', invoices === 240, `invoices=${invoices}`);
  await assert('Bienvenidas equals 50', welcome === 50, `welcome=${welcome}`);
  await assert('Manuales equals 17', manual === 17, `manual=${manual}`);
  await assert('Emitido total equals sum of the 3 buckets',
    Math.abs(total - (invoices + welcome + manual)) < 0.001,
    `total=${total} sum=${invoices + welcome + manual}`);
  await assert('Emitido total equals 307 (240 + 50 + 17)',
    Math.abs(total - 307) < 0.001,
    `total=${total}`);
  await assert('netCirculation reflects new total',
    Math.abs(parseFloat(body.netCirculation) - 307) < 0.001,
    `netCirculation=${body.netCirculation}`);

  // Branch filter also returns the 3 fields (no branch used here, so all 0)
  const resBr = await fetch(`${API}/api/merchant/metrics?branch=_unassigned`, {
    headers: { 'Authorization': `Bearer ${ownerToken}` },
  });
  const bodyBr: any = await resBr.json();
  await assert('unassigned slice also returns 3 breakdown fields',
    'valueIssuedInvoices' in bodyBr && 'valueIssuedWelcome' in bodyBr && 'valueIssuedManual' in bodyBr,
    `keys=${Object.keys(bodyBr).filter(k => k.startsWith('valueIssued')).join(',')}`);

  // Frontend chunk-grep: the 3 labels ship to /merchant
  const html = await (await fetch(`${FRONTEND}/merchant`)).text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('merchant chunk carries "Facturas" label',
    chunkBodies.some(js => js.includes('Facturas')),
    `scanned=${chunkUrls.length}`);
  await assert('merchant chunk carries "Bienvenidas" label',
    chunkBodies.some(js => js.includes('Bienvenidas')),
    'verified');
  await assert('merchant chunk carries "Manuales" label',
    chunkBodies.some(js => js.includes('Manuales')),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
