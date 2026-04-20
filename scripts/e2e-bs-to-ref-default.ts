/**
 * E2E: fresh tenant with reference_currency set but preferred_exchange_source
 * null still converts Bs → reference before applying the points multiplier.
 *
 * Eric hit this on Kozmo2: reference=eur, preferredSource=null, rate=20x →
 * a Bs 8,616.35 factura came out as 172,327 pts (8616.35 × 20), instead of
 * ~15 EUR × 20 = 303 pts. Fix: when preferredSource is null, use the
 * default source for the reference currency (bcv for USD, euro_bcv for EUR).
 *
 * Three scenarios:
 *   A. Tenant with ref=eur, preferredSource=null, rate=20x → factura 8616.35
 *      Bs credits ≈ (8616.35 / euro_bcv_rate) × 20 pts (not 172,327).
 *   B. Tenant with ref=usd, preferredSource=null, rate=10x → uses BCV by
 *      default.
 *   C. Tenant with ref=eur, preferredSource='promedio' still respects the
 *      explicit choice (doesn't silently switch to the default).
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { createPendingValidation } from '../src/services/invoice-validation.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function setupTenant(slug: string, refCurrency: string, preferredSource: string | null, conversionRate: number) {
  const t = await createTenant(`Default FX ${slug}`, slug, `${slug}@e2e.local`);
  await createSystemAccounts(t.id);
  await prisma.tenant.update({
    where: { id: t.id },
    data: {
      referenceCurrency: refCurrency as any,
      preferredExchangeSource: preferredSource as any,
    },
  });
  const asset = await prisma.assetType.findFirstOrThrow();
  await prisma.tenantAssetConfig.create({
    data: { tenantId: t.id, assetTypeId: asset.id, conversionRate },
  });
  return { t, asset };
}

async function latestRate(source: string, currency: string) {
  const row = await prisma.exchangeRate.findFirst({
    where: { source: source as any, currency: currency as any },
    orderBy: { fetchedAt: 'desc' },
  });
  return row?.rateBs ? Number(row.rateBs) : null;
}

async function main() {
  console.log('=== Bs → ref default exchange source E2E ===\n');

  const ts = Date.now();
  const bsAmount = 8616.35;
  const multiplier = 20;

  // ── A. ref=eur, no preferredSource → default to euro_bcv ──
  const eurRate = await latestRate('euro_bcv', 'eur');
  if (!eurRate) { console.error('no euro_bcv rate available — populate rates first'); process.exit(1); }

  const { t: ta } = await setupTenant(`fx-a-${ts}`, 'eur', null, multiplier);
  const ra = await createPendingValidation({
    tenantId: ta.id,
    senderPhone: `+19100${String(ts).slice(-7)}1`,
    invoiceNumber: `FX-A-${ts}`,
    totalAmount: bsAmount,
    assetTypeId: (await prisma.assetType.findFirstOrThrow()).id,
    extractedData: undefined,
  });
  const expectedA = Math.max(1, Math.round((bsAmount / eurRate) * multiplier));
  await assert('A: pending validation succeeded', ra.success === true, `stage=${ra.stage}`);
  await assert('A: ref=eur + no source → points use euro_bcv default',
    Number(ra.valueAssigned) === expectedA,
    `got=${ra.valueAssigned} expected=${expectedA} (bs=${bsAmount}, rate=${eurRate}, mult=${multiplier})`);
  await assert('A: points are NOT the raw Bs × multiplier',
    Number(ra.valueAssigned) !== Math.round(bsAmount * multiplier),
    `got=${ra.valueAssigned} raw=${Math.round(bsAmount * multiplier)}`);

  // ── B. ref=usd, no preferredSource → default to bcv ──
  const usdRate = await latestRate('bcv', 'usd');
  if (!usdRate) { console.error('no bcv rate available'); process.exit(1); }

  const { t: tb } = await setupTenant(`fx-b-${ts}`, 'usd', null, 10);
  const rb = await createPendingValidation({
    tenantId: tb.id,
    senderPhone: `+19100${String(ts).slice(-7)}2`,
    invoiceNumber: `FX-B-${ts}`,
    totalAmount: bsAmount,
    assetTypeId: (await prisma.assetType.findFirstOrThrow()).id,
    extractedData: undefined,
  });
  const expectedB = Math.max(1, Math.round((bsAmount / usdRate) * 10));
  await assert('B: ref=usd + no source → points use bcv default',
    Number(rb.valueAssigned) === expectedB,
    `got=${rb.valueAssigned} expected=${expectedB} (bs=${bsAmount}, rate=${usdRate}, mult=10)`);

  // ── C. explicit preferredSource is still respected ──
  const promedioRate = await latestRate('promedio', 'usd');
  if (!promedioRate) { console.error('no promedio/usd rate'); process.exit(1); }

  const { t: tc } = await setupTenant(`fx-c-${ts}`, 'usd', 'promedio', 10);
  const rc = await createPendingValidation({
    tenantId: tc.id,
    senderPhone: `+19100${String(ts).slice(-7)}3`,
    invoiceNumber: `FX-C-${ts}`,
    totalAmount: bsAmount,
    assetTypeId: (await prisma.assetType.findFirstOrThrow()).id,
    extractedData: undefined,
  });
  const expectedC = Math.max(1, Math.round((bsAmount / promedioRate) * 10));
  await assert('C: explicit preferredSource=promedio still wins',
    Number(rc.valueAssigned) === expectedC,
    `got=${rc.valueAssigned} expected=${expectedC} (rate=${promedioRate})`);
  await assert('C: promedio result differs from bcv default',
    Math.abs(Number(rc.valueAssigned) - Math.round((bsAmount / usdRate) * 10)) >= 1,
    `promedio=${rc.valueAssigned} bcvDefault=${Math.round((bsAmount / usdRate) * 10)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
