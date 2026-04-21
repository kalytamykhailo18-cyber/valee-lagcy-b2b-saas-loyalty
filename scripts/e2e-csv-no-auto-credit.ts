/**
 * E2E: CSV no longer auto-credits points (Genesis H6 Re Do).
 *
 * Before: a CSV row with a customer_phone was immediately credited —
 * the merchant could invent an invoice_number plus any phone and get
 * points into the system with no consumer action. Genesis reproduced
 * it by pasting invoice 12323131231 for Bs 10.5M, which landed as
 * 'Canjeada' without any photo ever being submitted.
 *
 * After: CSV rows always land status='available'. No ledger entry.
 * Points only credit when the consumer sends the photo and Stage C
 * matches the row (the consumer-photo flow writes INVOICE_CLAIMED).
 *
 * This test uploads a CSV with phones, confirms no ledger entries
 * were written, confirms the invoice rows are status='available',
 * confirms the consumer account's balance is zero, and then confirms
 * the consumer-photo path still works end-to-end against the same
 * CSV row so legitimate crediting isn't broken.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { getAccountBalance } from '../src/services/ledger.js';
import { processCSV } from '../src/services/csv-upload.js';
import { validateInvoice } from '../src/services/invoice-validation.js';
import bcrypt from 'bcryptjs';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== CSV no auto-credit E2E (Genesis H6 Re Do) ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`NoAutoCredit ${ts}`, `nac-${ts}`, `nac-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({ where: { id: tenant.id }, data: { rif: 'J-12345678-9' } });

  const phone = `+19100${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);

  // Fake CSV with two rows — both with a customer_phone. Previously either
  // would have auto-credited; we now expect both to stay 'available'.
  const invoiceNumber1 = `INV-NAC1-${ts}`;
  const invoiceNumber2 = `INV-NAC2-${ts}`;
  const csvText = [
    'invoice_number,total,date,phone',
    `${invoiceNumber1},500,2026-04-20,${phone}`,
    `${invoiceNumber2},1200,2026-04-20,${phone}`,
  ].join('\n');

  // processCSV needs a staffId for the UploadBatch FK — seed a throwaway owner.
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `nac-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const result = await processCSV(csvText, tenant.id, owner.id);
  await assert('CSV upload completed', result.status === 'completed',
    `status=${result.status}`);
  await assert('both rows loaded', result.rowsLoaded === 2,
    `loaded=${result.rowsLoaded}`);
  await assert('rowsAutoCredited is zero (backwards-compat field)',
    result.rowsAutoCredited === 0,
    `rowsAutoCredited=${result.rowsAutoCredited}`);

  // Invoice rows must be 'available', not 'claimed'
  const rows = await prisma.invoice.findMany({
    where: { tenantId: tenant.id, invoiceNumber: { in: [invoiceNumber1, invoiceNumber2] } },
  });
  await assert('both invoices persisted',
    rows.length === 2, `count=${rows.length}`);
  await assert('both invoices are status=available',
    rows.every(r => r.status === 'available'),
    `statuses=${rows.map(r => r.status).join(',')}`);

  // NO ledger entries from the CSV path
  const ledger = await prisma.ledgerEntry.findMany({
    where: {
      tenantId: tenant.id,
      referenceId: { startsWith: 'CSV-' },
    },
  });
  await assert('no CSV-prefixed ledger entries exist',
    ledger.length === 0, `count=${ledger.length}`);

  // Consumer balance must be zero (no phantom points from CSV)
  const bal = await getAccountBalance(consumer.id, asset.id, tenant.id);
  await assert('consumer balance is zero after CSV upload',
    Number(bal) === 0, `balance=${bal}`);

  // Consumer photo flow still works — sending a matching invoice credits points
  const photoResult = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phone,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: invoiceNumber1,
      total_amount: 500,
      transaction_date: '2026-04-20',
      customer_phone: phone,
      customer_cedula: null,
      merchant_rif: 'J-12345678-9',
      merchant_name: `NoAutoCredit ${ts}`,
      document_type: 'fiscal_invoice',
      currency: 'BS',
      payment_reference: null,
      bank_name: null,
      confidence_score: 0.95,
    } as any,
  });
  await assert('consumer photo flow still credits points (legitimate path works)',
    photoResult.success === true,
    `success=${photoResult.success} stage=${(photoResult as any).stage} msg=${photoResult.message?.slice(0, 80)}`);

  const balAfterPhoto = await getAccountBalance(consumer.id, asset.id, tenant.id);
  await assert('consumer balance > 0 only after photo submission',
    Number(balAfterPhoto) > 0,
    `balance=${balAfterPhoto}`);

  // Invoice should now be claimed
  const claimed = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: invoiceNumber1 },
  });
  await assert('invoice 1 flips to claimed after photo match',
    claimed?.status === 'claimed', `status=${claimed?.status}`);

  // Invoice 2 (never claimed by photo) stays available
  const unclaimed = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: invoiceNumber2 },
  });
  await assert('invoice 2 (no photo) stays available',
    unclaimed?.status === 'available', `status=${unclaimed?.status}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
