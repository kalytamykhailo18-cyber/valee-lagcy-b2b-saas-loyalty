/**
 * E2E: Branch view shows global CIRCULACION, not per-branch
 * (Genesis QA item 3).
 *
 * Points live at the tenant, not per-branch, so when the owner
 * switches to a specific sucursal in the dropdown the CIRCULACION
 * tile must still reflect the whole merchant's figure. Only EMITIDO
 * and CANJEADO filter per-branch.
 *
 * Genesis's evidence (image 13): Luxor Valencia shows CIRCULACION=432
 * when the tenant-level view shows CIRCULACION=10,543,474. That's
 * the bug. This test builds a 2-branch tenant with a deterministic
 * mix of events and checks the three views agree on CIRCULACION.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { getMerchantMetrics } from '../src/services/metrics.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Branch view global CIRCULACION E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`BranchCirc ${ts}`, `bc-${ts}`, `bc-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;
  const holding = (await getSystemAccount(tenant.id, 'redemption_holding'))!;

  const branchA = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal A', active: true },
  });
  const branchB = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal B', active: true },
  });

  const phone = `+58414${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);

  // Emit 400 points at Branch A (INVOICE_CLAIMED)
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '400', assetTypeId: asset.id,
    referenceId: `INV-A-${ts}`, referenceType: 'invoice',
    branchId: branchA.id,
    metadata: { source: 'e2e' },
  });

  // Emit 300 points at Branch B
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '300', assetTypeId: asset.id,
    referenceId: `INV-B-${ts}`, referenceType: 'invoice',
    branchId: branchB.id,
    metadata: { source: 'e2e' },
  });

  // Redeem 100 at Branch A (REDEMPTION_PENDING + REDEMPTION_CONFIRMED)
  const tokenId = `${ts}-redeem`;
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_PENDING',
    debitAccountId: consumer.id, creditAccountId: holding.id,
    amount: '100', assetTypeId: asset.id,
    referenceId: `REDEEM-${tokenId}`, referenceType: 'redemption_token',
    branchId: branchA.id,
    metadata: { source: 'e2e' },
  });
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_CONFIRMED',
    debitAccountId: holding.id, creditAccountId: pool.id,
    amount: '100', assetTypeId: asset.id,
    referenceId: `CONFIRMED-${tokenId}`, referenceType: 'redemption_token',
    branchId: branchA.id,
    metadata: { source: 'e2e' },
  });

  // Expected tenant-global figures:
  //   EMITIDO (invoices) = 400 + 300 = 700
  //   CANJEADO = 100
  //   CIRCULACION = 700 - 100 = 600

  const tenantView = await getMerchantMetrics(tenant.id);
  await assert('tenant view: EMITIDO invoices = 700',
    Number(tenantView.valueIssuedInvoices) === 700,
    `valueIssuedInvoices=${tenantView.valueIssuedInvoices}`);
  await assert('tenant view: CANJEADO = 100',
    Number(tenantView.valueRedeemed) === 100,
    `valueRedeemed=${tenantView.valueRedeemed}`);
  await assert('tenant view: CIRCULACION = 600',
    Number(tenantView.netCirculation) === 600,
    `netCirculation=${tenantView.netCirculation}`);

  const branchAView = await getMerchantMetrics(tenant.id, branchA.id);
  await assert('branch A: EMITIDO invoices = 400 (per-branch)',
    Number(branchAView.valueIssuedInvoices) === 400,
    `valueIssuedInvoices=${branchAView.valueIssuedInvoices}`);
  await assert('branch A: CANJEADO = 100 (per-branch)',
    Number(branchAView.valueRedeemed) === 100,
    `valueRedeemed=${branchAView.valueRedeemed}`);
  await assert('branch A: CIRCULACION = 600 (GLOBAL, not per-branch)',
    Number(branchAView.netCirculation) === 600,
    `netCirculation=${branchAView.netCirculation}`);

  const branchBView = await getMerchantMetrics(tenant.id, branchB.id);
  await assert('branch B: EMITIDO invoices = 300 (per-branch)',
    Number(branchBView.valueIssuedInvoices) === 300,
    `valueIssuedInvoices=${branchBView.valueIssuedInvoices}`);
  await assert('branch B: CANJEADO = 0 (per-branch)',
    Number(branchBView.valueRedeemed) === 0,
    `valueRedeemed=${branchBView.valueRedeemed}`);
  await assert('branch B: CIRCULACION = 600 (GLOBAL, matches tenant view)',
    Number(branchBView.netCirculation) === 600,
    `netCirculation=${branchBView.netCirculation}`);

  // Also check the _unassigned sentinel keeps CIRCULACION at global
  const unassignedView = await getMerchantMetrics(tenant.id, '_unassigned');
  await assert('_unassigned sentinel: CIRCULACION is GLOBAL',
    Number(unassignedView.netCirculation) === 600,
    `netCirculation=${unassignedView.netCirculation}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
