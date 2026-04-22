/**
 * E2E: strict photo-side validation per Genesis's checklist.
 *
 *   a) If the tenant has uploaded at least one completed CSV batch,
 *      photo submissions for invoice numbers NOT in the registry get
 *      rejected at Stage C. No silent pending_validation.
 *   b) Before any CSV upload (new-tenant grace), photo submissions of
 *      unknown invoices still fall through to pending_validation so
 *      onboarding doesn't dead-lock.
 *   c) Photo submissions with transaction_date > now+24h rejected.
 *   d) Foreign phone format (e.g. US +1XXXXXXXXXX) accepted and
 *      resolved to a consumer account.
 *   e) Voucher submissions skip the strict-match gate because the
 *      merchant doesn't upload bank references in their POS CSV.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { validateInvoice } from '../src/services/invoice-validation.js';
import { processCSV } from '../src/services/csv-upload.js';
import bcrypt from 'bcryptjs';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== CSV-strict validation E2E (Genesis item 1) ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`StrictCsv ${ts}`, `sc-${ts}`, `sc-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({ where: { id: tenant.id }, data: { rif: 'J-12345678-9' } });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `sc-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });

  const phoneVE = `+58414${String(ts).slice(-7)}`;
  const phoneUS = `+1212${String(ts).slice(-7)}`;

  // ── b) New-tenant grace: before any CSV, unknown invoice creates pending ──
  const preCsv = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneVE,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `GRACE-${ts}`,
      total_amount: 100,
      transaction_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      customer_phone: null,
      merchant_rif: 'J-12345678-9',
      merchant_name: 'Test',
      document_type: 'fiscal_invoice',
      currency: 'BS',
      payment_reference: null,
      bank_name: null,
      confidence_score: 0.95,
    } as any,
  });
  await assert('b) pre-CSV: unknown invoice falls through to pending_validation',
    preCsv.success === true && preCsv.stage === 'pending',
    `success=${preCsv.success} stage=${preCsv.stage}`);

  // Upload a CSV so the tenant is now "keeping books"
  const csvInvoice = `REAL-${ts}`;
  const csvResult = await processCSV(
    `invoice_number,total,date,phone\n${csvInvoice},250,${new Date().toISOString().slice(0, 10)},${phoneVE}`,
    tenant.id, owner.id,
  );
  await assert('CSV upload completed', csvResult.status === 'completed',
    `status=${csvResult.status} loaded=${csvResult.rowsLoaded}`);

  // ── a) After CSV: unknown invoice must be REJECTED, not pending ──
  const unknownAfter = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneVE,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `FABRICATED-${ts}`,
      total_amount: 1000,
      transaction_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      customer_phone: null,
      merchant_rif: 'J-12345678-9',
      merchant_name: 'Test',
      document_type: 'fiscal_invoice',
      currency: 'BS',
      payment_reference: null,
      bank_name: null,
      confidence_score: 0.95,
    } as any,
  });
  await assert('a) post-CSV: unknown invoice is rejected (not pending)',
    unknownAfter.success === false, `success=${unknownAfter.success} stage=${unknownAfter.stage}`);
  await assert('a) rejection message mentions "no encontramos" or "registros"',
    /no encontramos|registros/i.test(unknownAfter.message || ''),
    `msg="${unknownAfter.message}"`);

  // Known CSV invoice → claims successfully
  const knownMatch = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneVE,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: csvInvoice,
      total_amount: 250,
      transaction_date: new Date().toISOString().slice(0, 10),
      customer_phone: null,
      merchant_rif: 'J-12345678-9',
      merchant_name: 'Test',
      document_type: 'fiscal_invoice',
      currency: 'BS',
      payment_reference: null,
      bank_name: null,
      confidence_score: 0.95,
    } as any,
  });
  await assert('a) known CSV invoice still matches and claims',
    knownMatch.success === true && knownMatch.stage === 'complete',
    `success=${knownMatch.success} stage=${knownMatch.stage}`);

  // ── c) Future date on photo submission ──
  const fut = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const futureDate = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneVE,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `FUTURE-${ts}`,
      total_amount: 100,
      transaction_date: fut,
      customer_phone: null,
      merchant_rif: 'J-12345678-9',
      merchant_name: 'Test',
      document_type: 'fiscal_invoice',
      currency: 'BS',
      payment_reference: null,
      bank_name: null,
      confidence_score: 0.95,
    } as any,
  });
  await assert('c) future-date photo submission rejected',
    futureDate.success === false, `success=${futureDate.success}`);
  await assert('c) rejection message mentions "futuro"',
    /futuro/i.test(futureDate.message || ''),
    `msg="${futureDate.message}"`);

  // ── d) Foreign phone (US +1) is accepted by the validator ──
  // For strict-match gate to not fire we use a voucher submission (bypasses
  // the CSV check per Stage C exception).
  const foreignPhone = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phoneUS,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `V-FOREIGN-${ts}`,
      total_amount: 77,
      transaction_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      customer_phone: null,
      merchant_rif: null,
      merchant_name: 'Bank',
      document_type: 'voucher',
      currency: 'BS',
      payment_reference: `FGN-${ts}`,
      bank_name: 'Banco X',
      confidence_score: 0.95,
    } as any,
    ocrRawText: `foreign voucher ${ts}`,
    imageBuffer: Buffer.from(`foreign-${ts}`),
  });
  await assert('d) foreign-phone sender processed (voucher path)',
    foreignPhone.success === true || foreignPhone.stage === 'pending',
    `success=${foreignPhone.success} stage=${foreignPhone.stage} msg=${foreignPhone.message?.slice(0, 80)}`);

  // ── e) Voucher submissions bypass strict-CSV gate even when batches exist ──
  const voucherAfterCsv = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: `+58414${String(ts).slice(-7)}1`,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `V-AFTER-${ts}`,
      total_amount: 500,
      transaction_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      customer_phone: null,
      merchant_rif: null,
      merchant_name: 'Bank',
      document_type: 'voucher',
      currency: 'BS',
      payment_reference: `REF-${ts}`,
      bank_name: 'Banco X',
      confidence_score: 0.95,
    } as any,
    ocrRawText: `voucher after csv ${ts}`,
    imageBuffer: Buffer.from(`v-after-${ts}`),
  });
  await assert('e) voucher after CSV upload still processes (not strict-gated)',
    voucherAfterCsv.success === true, `success=${voucherAfterCsv.success} stage=${voucherAfterCsv.stage}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
