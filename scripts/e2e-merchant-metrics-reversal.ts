/**
 * E2E: merchant 'Emitido' metric (valueIssued) subtracts REVERSAL debits
 * so a factura that was claimed and later reversed doesn't inflate the
 * dashboard total.
 *
 * Eric's Kozmo2 showed 'Emitido: 172,933' after the Bs→EUR fix
 * reversed a 172,327 provisional credit — the sum-of-credits query
 * ignored the reversal because it was a separate event (the original's
 * status can't be updated to 'reversed' on an immutable ledger).
 *
 * Covers both the analytics endpoint and getMerchantMetrics (used by
 * the metrics page + branch drilldown).
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
  console.log('=== Merchant metrics: REVERSAL subtracts from valueIssued ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Metrics Rev ${ts}`, `metrics-rev-${ts}`, `metrics-rev-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;
  const phone = `+19200${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);

  // Two INVOICE_CLAIMED credits, one large (will be reversed) and one small
  // (stays live). Expected Emitido = small only after the reversal.
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '1000', assetTypeId: asset.id,
    referenceId: `METREV-BIG-${ts}`, referenceType: 'invoice',
    status: 'provisional',
    metadata: { seed: 'big' },
  });
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '50', assetTypeId: asset.id,
    referenceId: `METREV-SMALL-${ts}`, referenceType: 'invoice',
    status: 'provisional',
    metadata: { seed: 'small' },
  });

  const m1 = await getMerchantMetrics(tenant.id);
  await assert('before reversal: valueIssued = 1050 (1000 + 50)',
    Number(m1.valueIssued) === 1050, `valueIssued=${m1.valueIssued}`);

  // Reverse the big one
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REVERSAL',
    debitAccountId: consumer.id, creditAccountId: pool.id,
    amount: '1000', assetTypeId: asset.id,
    referenceId: `REV-BIG-${ts}`, referenceType: 'invoice',
    metadata: { seed: 'reverse-big' },
  });

  const m2 = await getMerchantMetrics(tenant.id);
  await assert('after reversal: valueIssued drops to 50',
    Number(m2.valueIssued) === 50, `valueIssued=${m2.valueIssued}`);
  await assert('reversed amount is NOT 1050',
    Number(m2.valueIssued) !== 1050, `valueIssued=${m2.valueIssued}`);
  await assert('netCirculation also reflects the drop',
    Number(m2.netCirculation) === 50, `netCirculation=${m2.netCirculation}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
