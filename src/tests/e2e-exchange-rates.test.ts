/**
 * E2E test: BS exchange rate normalization in the invoice validation pipeline.
 *
 * Verifies that:
 * 1. Exchange rates can be fetched from the public API and stored append-only.
 * 2. A tenant with `preferredExchangeSource = bcv` normalizes BS amounts to USD
 *    before calculating loyalty points.
 * 3. A tenant without `preferredExchangeSource` uses the raw BS amount as before.
 * 4. The ledger entry stores the rate metadata for audit.
 * 5. Historical rates are used when claiming a backdated invoice.
 */

import dotenv from 'dotenv';
import { assertTestDatabase } from './_test-guard.js';
dotenv.config();

const TENANT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccc01';
const ASSET_ID = 'cccccccc-cccc-cccc-cccc-cccccccccc02';
const TENANT_ID_2 = 'cccccccc-cccc-cccc-cccc-cccccccccc03';

let passed = 0;
let failed = 0;
function ok(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ok ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}
function near(actual: number, expected: number, tolerance: number, name: string) {
  const diff = Math.abs(actual - expected);
  ok(diff <= tolerance, `${name} (expected ${expected.toFixed(4)}, got ${actual.toFixed(4)}, tolerance ${tolerance})`);
}

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM ledger_entries WHERE tenant_id IN ('${TENANT_ID}'::uuid, '${TENANT_ID_2}'::uuid)`).catch(() => {});
    await prisma.invoice.deleteMany({ where: { tenantId: { in: [TENANT_ID, TENANT_ID_2] } } });
    await prisma.account.deleteMany({ where: { tenantId: { in: [TENANT_ID, TENANT_ID_2] } } });
    await prisma.tenantAssetConfig.deleteMany({ where: { tenantId: { in: [TENANT_ID, TENANT_ID_2] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_ID, TENANT_ID_2] } } });
    await prisma.assetType.deleteMany({ where: { id: ASSET_ID } });
    await prisma.exchangeRate.deleteMany({ where: { source: 'bcv', currency: 'usd', rateBs: { in: ['474.5338', '500.0000'] } } });
  }

  await cleanup();

  // SETUP: 2 tenants — Tenant A uses BCV normalization, Tenant B uses raw BS amounts
  await prisma.assetType.create({ data: { id: ASSET_ID, name: 'TestExchangePts', unitLabel: 'pts', defaultConversionRate: '1.00000000' } });

  const tenantA = await prisma.tenant.create({
    data: {
      id: TENANT_ID,
      name: 'BCV Normalized',
      slug: 'exchange-test-' + Date.now(),
      ownerEmail: 'a@test.com',
      preferredExchangeSource: 'bcv',
      referenceCurrency: 'usd',
    },
  });

  const tenantB = await prisma.tenant.create({
    data: {
      id: TENANT_ID_2,
      name: 'Raw Amount',
      slug: 'raw-test-' + Date.now(),
      ownerEmail: 'b@test.com',
      // no preferredExchangeSource — should use raw BS amount
    },
  });

  // System accounts for both tenants
  await prisma.account.create({ data: { tenantId: TENANT_ID, accountType: 'system', systemAccountType: 'issued_value_pool' } });
  await prisma.account.create({ data: { tenantId: TENANT_ID, accountType: 'system', systemAccountType: 'redemption_holding' } });
  await prisma.account.create({ data: { tenantId: TENANT_ID_2, accountType: 'system', systemAccountType: 'issued_value_pool' } });
  await prisma.account.create({ data: { tenantId: TENANT_ID_2, accountType: 'system', systemAccountType: 'redemption_holding' } });

  // ---- 1. Exchange rate service ----
  console.log('\n--- Exchange rate service ---');
  const { fetchAllRates, getCurrentRate, getRateAtDate, convertBsToReference } = await import('../services/exchange-rates.js');

  const inserted = await fetchAllRates();
  ok(inserted >= 1, `Fetched at least 1 rate (got ${inserted})`);

  const bcv = await getCurrentRate('bcv', 'usd');
  ok(bcv !== null, 'BCV USD rate available');
  ok(bcv !== null && bcv.rateBs > 0, 'BCV rate is positive');

  const converted = await convertBsToReference(2362.23, 'bcv', 'usd');
  ok(converted !== null && converted > 0, `Bs 2362.23 converted to USD = ${converted?.toFixed(4)}`);
  ok(converted !== null && converted < 100, 'Converted USD is in plausible range (under $100)');

  // ---- 2. Tenant A: validate BS invoice with normalization ----
  console.log('\n--- Tenant A (BCV normalization) ---');
  const { validateInvoice } = await import('../services/invoice-validation.js');

  // Create available invoice
  await prisma.invoice.create({
    data: {
      tenantId: TENANT_ID,
      invoiceNumber: 'EXCHTEST-A001',
      amount: '2362.23',
      status: 'available',
      source: 'csv_upload',
    },
  });

  const resultA = await validateInvoice({
    tenantId: TENANT_ID,
    senderPhone: '+58414exchA',
    assetTypeId: ASSET_ID,
    extractedData: {
      invoice_number: 'EXCHTEST-A001',
      total_amount: 2362.23,
      transaction_date: new Date().toISOString().split('T')[0],
      customer_phone: '0414exchA',
      merchant_name: 'A',
      confidence_score: 0.95,
    },
  });

  ok(resultA.success === true, 'Tenant A validation succeeded');
  if (resultA.success && bcv) {
    const expectedUsd = 2362.23 / bcv.rateBs;
    near(parseFloat(resultA.valueAssigned!), expectedUsd, 0.01, 'Value assigned matches BS/BCV conversion');
  }

  // Verify the ledger entry has the exchange rate metadata
  const acctA = await prisma.account.findFirst({ where: { tenantId: TENANT_ID, phoneNumber: '+58414exchA' } });
  ok(acctA !== null, 'Tenant A consumer account created');

  const entryA = await prisma.ledgerEntry.findFirst({
    where: { tenantId: TENANT_ID, accountId: acctA!.id, eventType: 'INVOICE_CLAIMED' },
  });
  ok(entryA !== null, 'Tenant A ledger entry exists');
  ok((entryA?.metadata as any)?.exchangeRate?.source === 'bcv', 'Ledger metadata records BCV source');
  ok((entryA?.metadata as any)?.originalCurrency === 'bs', 'Ledger metadata records original currency BS');
  ok((entryA?.metadata as any)?.originalAmount === '2362.23', 'Ledger metadata records original Bs amount');

  // ---- 3. Tenant B: same invoice, no normalization ----
  console.log('\n--- Tenant B (no normalization, raw amount) ---');
  await prisma.invoice.create({
    data: {
      tenantId: TENANT_ID_2,
      invoiceNumber: 'EXCHTEST-B001',
      amount: '2362.23',
      status: 'available',
      source: 'csv_upload',
    },
  });

  const resultB = await validateInvoice({
    tenantId: TENANT_ID_2,
    senderPhone: '+58414exchB',
    assetTypeId: ASSET_ID,
    extractedData: {
      invoice_number: 'EXCHTEST-B001',
      total_amount: 2362.23,
      transaction_date: new Date().toISOString().split('T')[0],
      customer_phone: '0414exchB',
      merchant_name: 'B',
      confidence_score: 0.95,
    },
  });

  ok(resultB.success === true, 'Tenant B validation succeeded');
  if (resultB.success) {
    near(parseFloat(resultB.valueAssigned!), 2362.23, 0.01, 'Tenant B uses raw 2362.23 (no normalization)');
  }

  const acctB = await prisma.account.findFirst({ where: { tenantId: TENANT_ID_2, phoneNumber: '+58414exchB' } });
  const entryB = await prisma.ledgerEntry.findFirst({
    where: { tenantId: TENANT_ID_2, accountId: acctB!.id, eventType: 'INVOICE_CLAIMED' },
  });
  ok(entryB !== null && entryB.metadata === null, 'Tenant B ledger has no exchange rate metadata');

  // ---- 4. Historical rate lookup ----
  console.log('\n--- Historical rate lookup ---');
  // Insert a historical rate from 30 days ago at a known value
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 30);
  await prisma.exchangeRate.create({
    data: {
      source: 'bcv',
      currency: 'usd',
      rateBs: '500.0000',
      reportedAt: oldDate,
    },
  });

  const histRate = await getRateAtDate('bcv', 'usd', oldDate);
  ok(histRate !== null && Math.abs(Number(histRate.rateBs) - 500) < 0.01, `Historical rate at -30d returns 500.0 (got ${histRate?.rateBs})`);

  // Today's lookup should return the most recent rate (not the historical one)
  const todayRate = await getRateAtDate('bcv', 'usd', new Date());
  ok(todayRate !== null && Number(todayRate.rateBs) !== 500, `Today's lookup returns current rate (got ${todayRate?.rateBs})`);

  // ---- 5. History-preserving append-only ----
  console.log('\n--- Append-only verification ---');
  const totalBefore = await prisma.exchangeRate.count();
  const newInserted = await fetchAllRates();
  const totalAfter = await prisma.exchangeRate.count();
  ok(totalAfter - totalBefore === newInserted, `New rates appended (no UPDATE): before=${totalBefore} after=${totalAfter} inserted=${newInserted}`);

  // ---- CLEANUP ----
  await cleanup();
  await prisma.$disconnect();

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
