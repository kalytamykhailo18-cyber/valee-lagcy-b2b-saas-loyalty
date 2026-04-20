/**
 * E2E: voucher dedup by payment_reference + semantic same-amount /
 * same-day dedup catch the 'resubmit with slight OCR noise' bypass
 * Genesis demonstrated (H8/H10).
 *
 * Scenarios:
 *   A. Two voucher submissions with the same bank payment_reference but
 *      different invoice_numbers and different image bytes → second is
 *      rejected with 'Ya enviaste este voucher antes'.
 *   B. Different consumer submitting the same voucher reference →
 *      rejected with 'por otro cliente'.
 *   C. Same consumer submits two fiscal_invoice photos same day + same
 *      amount (±tolerance) + no overlap in reference → second rejected
 *      by the semantic same-consumer / same-day / same-amount guard.
 *   D. Two DIFFERENT customers submitting same-amount-same-day facturas
 *      both get accepted (it's only a dedup when consumer matches).
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
  console.log('=== Voucher dedup by payment_reference + semantic dedup E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Voucher Dedup ${ts}`, `vd-${ts}`, `vd-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const txDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const paymentRef = `REF-E2E-${ts}`;

  // ── A. Same voucher ref, different invoice_number + different bytes ──
  const phoneA = `+19100${String(ts).slice(-7)}1`;
  const buf1 = Buffer.from(`voucher-first-${ts}`);
  const r1 = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneA,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `V-FIRST-${ts}`,
      total_amount: 103893.31,
      transaction_date: txDate,
      customer_phone: null,
      merchant_name: 'Banco',
      merchant_rif: null,
      currency: 'BS',
      document_type: 'voucher',
      bank_name: 'Banco de Venezuela',
      payment_reference: paymentRef,
      confidence_score: 0.9,
    },
    ocrRawText: `VOUCHER ${paymentRef} 103893.31`,
    imageBuffer: buf1,
  });
  await assert('A: first voucher accepted', r1.success === true, `stage=${r1.stage}`);

  // Second voucher: same payment_reference, different invoice_number,
  // different image bytes, slightly different OCR text.
  const buf2 = Buffer.from(`voucher-resubmit-${ts}`);
  const r2 = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneA,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `V-RESUBMIT-${ts}`,
      total_amount: 103893.31,
      transaction_date: txDate,
      customer_phone: null,
      merchant_name: 'Banco',
      merchant_rif: null,
      currency: 'BS',
      document_type: 'voucher',
      bank_name: 'Banco de Venezuela',
      payment_reference: paymentRef,
      confidence_score: 0.9,
    },
    ocrRawText: `VOUCHER ${paymentRef} 103893.31 slight noise`,
    imageBuffer: buf2,
  });
  await assert('A: resubmit SAME payment_reference rejected',
    r2.success === false, `stage=${r2.stage}`);
  await assert('A: rejection message communicates duplicate / already sent',
    /(voucher|enviaste|procesar dos|ya fue)/i.test(r2.message || ''),
    `msg="${r2.message}"`);

  // ── B. Different consumer, same voucher ref → rejected ──
  const phoneB = `+19100${String(ts).slice(-7)}2`;
  const buf3 = Buffer.from(`voucher-other-user-${ts}`);
  const r3 = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneB,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `V-OTHER-${ts}`,
      total_amount: 103893.31,
      transaction_date: txDate,
      customer_phone: null,
      merchant_name: 'Banco',
      merchant_rif: null,
      currency: 'BS',
      document_type: 'voucher',
      payment_reference: paymentRef,
      confidence_score: 0.9,
    },
    ocrRawText: `VOUCHER ${paymentRef}`,
    imageBuffer: buf3,
  });
  await assert('B: different user + same payment_reference rejected',
    r3.success === false, `stage=${r3.stage}`);
  await assert('B: rejection mentions "otro cliente"',
    /otro cliente/i.test(r3.message || ''), `msg="${r3.message}"`);

  // ── C. Semantic dedup: same consumer, same-day, same-amount fiscal ──
  const phoneC = `+19100${String(ts).slice(-7)}3`;
  const amt = 321.50;
  const fiscalTxDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  const buf4 = Buffer.from(`fiscal-first-${ts}`);
  const rc1 = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneC,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `F-FIRST-${ts}`,
      total_amount: amt,
      transaction_date: fiscalTxDate,
      customer_phone: null,
      merchant_name: 'Tienda',
      merchant_rif: null,
      currency: 'USD',
      document_type: 'fiscal_invoice',
      confidence_score: 0.95,
    },
    ocrRawText: `FACTURA F-FIRST-${ts} ${amt}`,
    imageBuffer: buf4,
  });
  await assert('C: first fiscal invoice accepted', rc1.success === true, `stage=${rc1.stage}`);

  const buf5 = Buffer.from(`fiscal-second-${ts}`);
  const rc2 = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneC,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `F-DIFFERENT-${ts}`,
      total_amount: amt,
      transaction_date: fiscalTxDate,
      customer_phone: null,
      merchant_name: 'Tienda',
      merchant_rif: null,
      currency: 'USD',
      document_type: 'fiscal_invoice',
      confidence_score: 0.95,
    },
    ocrRawText: `FACTURA F-DIFFERENT-${ts} ${amt}`,
    imageBuffer: buf5,
  });
  await assert('C: same-user same-day same-amount rejected by semantic dedup',
    rc2.success === false, `msg="${rc2.message?.slice(0, 80)}"`);
  await assert('C: semantic dedup message mentions "parecida"',
    /parecida/i.test(rc2.message || ''), `msg="${rc2.message}"`);

  // ── D. Different consumer, same-day, same-amount → BOTH accepted ──
  const phoneD = `+19100${String(ts).slice(-7)}4`;
  const rd = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneD,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `F-OTHER-USER-${ts}`,
      total_amount: amt,
      transaction_date: fiscalTxDate,
      customer_phone: null,
      merchant_name: 'Tienda',
      merchant_rif: null,
      currency: 'USD',
      document_type: 'fiscal_invoice',
      confidence_score: 0.95,
    },
    ocrRawText: `FACTURA F-OTHER-USER-${ts} ${amt}`,
    imageBuffer: Buffer.from(`fiscal-other-user-${ts}`),
  });
  await assert('D: different user + same amount/day still accepted',
    rd.success === true, `stage=${rd.stage} msg=${rd.message?.slice(0,60)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
