/**
 * E2E: voucher dedup by exact amount ignores transaction_date noise
 * (Genesis H10 Re Do).
 *
 * Her reproduction: two submissions of what she believed was the same
 * Banco de Venezuela voucher. The OCR parsed the date segment
 * differently each time — first as 2026-08-04, second as 2026-04-08
 * (4 months apart). Both synthesised different invoice_numbers, both
 * landed past the B2 payment_reference check (it was null on her
 * receipts), and both slipped past the B3 48h semantic window because
 * the two dates were 4 months apart. Result: two provisional credits
 * for the same voucher.
 *
 * The fix: for document_type='voucher', dedup on exact amount (±0.005
 * cents) + same consumer + same tenant across ANY date. A customer
 * doesn't repeat-deposit the exact-centavo-same amount to the same
 * merchant via bank voucher without it being the same transaction.
 *
 * Fiscal invoices keep the 48h window because a shop CAN genuinely
 * have multiple purchases of the same amount within days.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { validateInvoice } from '../src/services/invoice-validation.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Voucher exact-amount dedup across dates E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`VExact ${ts}`, `ve-${ts}`, `ve-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const phoneA = `+19100${String(ts).slice(-7)}1`;
  const phoneB = `+19100${String(ts).slice(-7)}2`;

  // First voucher: submitted with transaction_date in February 2026 (4
  // months before the "April 2026" parse of the second submission).
  const r1 = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneA,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `V-FEB-${ts}`,
      total_amount: 103893.31,
      transaction_date: '2026-02-04T15:08:30Z',
      customer_phone: null,
      merchant_name: 'Banco',
      merchant_rif: null,
      currency: 'BS',
      document_type: 'voucher',
      bank_name: 'Banco de Venezuela',
      payment_reference: null, // Genesis's OCR wasn't stamping this
      confidence_score: 0.9,
    } as any,
    ocrRawText: `VOUCHER 103893.31 aug-parse`,
    imageBuffer: Buffer.from(`v-aug-${ts}`),
  });
  await assert('A: first voucher accepted (Feb date)',
    r1.success === true, `stage=${r1.stage} msg=${r1.message?.slice(0, 80)}`);

  // Second voucher: same amount, same consumer, but transaction_date is
  // 4 months earlier (OCR parsed the date differently). The old 48h
  // window wouldn't catch this; the new exact-amount voucher guard does.
  const r2 = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneA,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `V-APR-${ts}`,
      total_amount: 103893.31,
      transaction_date: '2026-04-08T03:08:30Z',
      customer_phone: null,
      merchant_name: 'Banco',
      merchant_rif: null,
      currency: 'BS',
      document_type: 'voucher',
      bank_name: 'Banco de Venezuela',
      payment_reference: null,
      confidence_score: 0.9,
    } as any,
    ocrRawText: `VOUCHER 103893.31 apr-parse`,
    imageBuffer: Buffer.from(`v-apr-${ts}`),
  });
  await assert('A: second voucher (different date, same amount) REJECTED',
    r2.success === false, `stage=${r2.stage}`);
  await assert('A: rejection message communicates voucher duplicate',
    /voucher.*enviado|procesar dos|dos veces/i.test(r2.message || ''),
    `msg="${r2.message}"`);

  // Control: a DIFFERENT consumer with the same amount should still
  // pass — the dedup is scoped to consumer+tenant, not globally.
  const r3 = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneB,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `V-OTHER-${ts}`,
      total_amount: 103893.31,
      transaction_date: '2026-04-08T03:08:30Z',
      customer_phone: null,
      merchant_name: 'Banco',
      merchant_rif: null,
      currency: 'BS',
      document_type: 'voucher',
      bank_name: 'Banco de Venezuela',
      payment_reference: null,
      confidence_score: 0.9,
    } as any,
    ocrRawText: `VOUCHER 103893.31 other-user`,
    imageBuffer: Buffer.from(`v-other-${ts}`),
  });
  await assert('B: different consumer, same amount, still accepted',
    r3.success === true, `stage=${r3.stage} msg=${r3.message?.slice(0, 80)}`);

  // Control: fiscal invoice with same amount but same consumer + different
  // date > 48h ≠ rejected (fiscal keeps the 48h window — legitimate repeat
  // purchases of a fixed-price item shouldn't block).
  await prisma.tenant.update({ where: { id: tenant.id }, data: { rif: 'J-12345678-9' } });
  const phoneC = `+19100${String(ts).slice(-7)}3`;
  const r4a = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneC,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `F-DAY1-${ts}`,
      total_amount: 500,
      transaction_date: '2026-03-01T10:00:00Z',
      customer_phone: null,
      merchant_name: 'Tienda',
      merchant_rif: 'J-12345678-9',
      currency: 'BS',
      document_type: 'fiscal_invoice',
      confidence_score: 0.9,
    } as any,
    ocrRawText: `FACTURA day1 500`,
    imageBuffer: Buffer.from(`f-day1-${ts}`),
  });
  await assert('C: first fiscal invoice accepted',
    r4a.success === true, `stage=${r4a.stage}`);

  const r4b = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneC,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `F-DAY30-${ts}`,
      total_amount: 500,
      transaction_date: '2026-04-01T10:00:00Z', // 31 days later
      customer_phone: null,
      merchant_name: 'Tienda',
      merchant_rif: 'J-12345678-9',
      currency: 'BS',
      document_type: 'fiscal_invoice',
      confidence_score: 0.9,
    } as any,
    ocrRawText: `FACTURA day30 500`,
    imageBuffer: Buffer.from(`f-day30-${ts}`),
  });
  await assert('C: fiscal invoice 30 days later, same amount, still accepted',
    r4b.success === true, `stage=${r4b.stage} msg=${r4b.message?.slice(0, 80)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
