/**
 * One-off correction: Kozmo2's single pending factura was credited with
 * 172,327 pts (= 8616.35 Bs × 20x multiplier, skipping the Bs→EUR step).
 * Correct value with 20x rate is ~303 pts (15.15 EUR × 20).
 *
 * We already reversed the 172,327. This script recomputes the correct
 * amount via convertBsToReference + the tenant's rate and writes a fresh
 * provisional credit with the right number.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { getSystemAccount } from '../src/services/accounts.js';
import { convertBsToReference, defaultExchangeSource } from '../src/services/exchange-rates.js';
import { getConversionRate } from '../src/services/assets.js';

async function main() {
  const INVOICE_NUMBER = 'VOUCHER-20260418-1111-861635-68945f721c53-26c5cfda9881';

  // The invoice row was deleted in the first backfill pass; the original
  // consumer account + reversal sit on the ledger. Resolve both by
  // referenceId so we can target the same subject.
  const originalEntry = await prisma.ledgerEntry.findFirst({
    where: { referenceId: `PENDING-${INVOICE_NUMBER}`, entryType: 'CREDIT' },
    orderBy: { createdAt: 'asc' },
  });
  const reversalEntry = await prisma.ledgerEntry.findFirst({
    where: { referenceId: `REVERSAL-FX-FIX-${INVOICE_NUMBER}`, entryType: 'DEBIT' },
  });
  if (!originalEntry || !reversalEntry) {
    console.log('Could not find original + reversal entries. Aborting.');
    process.exit(1);
  }

  const tenantId = originalEntry.tenantId;
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const pool = await getSystemAccount(tenantId, 'issued_value_pool');
  if (!pool) { console.log('Pool account missing'); process.exit(1); }

  const source = (tenant.preferredExchangeSource as any) || defaultExchangeSource(tenant.referenceCurrency);
  if (!source) { console.log('No exchange source resolvable'); process.exit(1); }

  const bsAmount = 8616.35;
  const refAmount = await convertBsToReference(bsAmount, source, tenant.referenceCurrency, new Date());
  if (refAmount == null) { console.log('No rate available'); process.exit(1); }

  const rateStr = await getConversionRate(tenantId, originalEntry.assetTypeId);
  const correctPoints = Math.max(1, Math.round(refAmount * parseFloat(rateStr)));
  console.log(`Correct value: Bs ${bsAmount} → ${refAmount.toFixed(4)} ${tenant.referenceCurrency.toUpperCase()} × ${rateStr} = ${correctPoints} pts`);

  const result = await writeDoubleEntry({
    tenantId,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id,
    creditAccountId: originalEntry.accountId,
    amount: correctPoints.toFixed(8),
    assetTypeId: originalEntry.assetTypeId,
    referenceId: `PENDING-FIX-${INVOICE_NUMBER}`,
    referenceType: 'invoice',
    status: 'provisional',
    metadata: {
      invoiceNumber: INVOICE_NUMBER,
      backfill: 'bs_to_ref_default_source_fix',
      originalPoints: Number(originalEntry.amount),
      correctedPoints: correctPoints,
      bsAmount,
      refAmount: Number(refAmount.toFixed(8)),
      rate: rateStr,
    },
  });

  // Recreate the invoice row so the consumer's history + reconciliation
  // still track this factura.
  await prisma.$executeRaw`
    INSERT INTO invoices (id, tenant_id, invoice_number, amount, status, source, consumer_account_id, ledger_entry_id, created_at, updated_at)
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${INVOICE_NUMBER}, ${bsAmount}, 'pending_validation', 'photo_submission', ${originalEntry.accountId}::uuid, ${result.credit.id}::uuid, ${originalEntry.createdAt}, now())
  `;

  console.log(`Done. New provisional credit: ${result.credit.id}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
