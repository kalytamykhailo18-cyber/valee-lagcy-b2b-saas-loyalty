/**
 * E2E: CSV reconciliation flips consumer's provisional credit to
 * confirmed (Genesis QA item 2).
 *
 * Scenario: consumer sends a photo factura BEFORE the merchant has
 * uploaded the CSV. The validator creates a pending_validation
 * invoice + a ledger entry with status='provisional'. The consumer
 * sees "X en verificación" on their PWA.
 *
 * The merchant then uploads a CSV that includes that invoice number.
 * csv-upload.ts flips the invoice.status='claimed' — previously the
 * ledger entry stayed status='provisional' forever, so the consumer
 * kept seeing the "en verificación" chip even though the invoice
 * was resolved. The ledger is append-only and can't be mutated; the
 * balance query now joins with invoices.status to treat those
 * effective-confirmed entries correctly.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { validateInvoice } from '../src/services/invoice-validation.js';
import { processCSV } from '../src/services/csv-upload.js';
import { getAccountBalanceBreakdown } from '../src/services/ledger.js';
import bcrypt from 'bcryptjs';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== CSV reconcile: provisional → confirmed flip ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Reconcile ${ts}`, `rec-${ts}`, `rec-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { rif: 'J-12345678-9', referenceCurrency: 'usd', preferredExchangeSource: 'bcv' },
  });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `rec-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });

  const phone = `+58414${String(ts).slice(-7)}`;
  const invoiceNumber = `INV-REC-${ts}`;
  const amount = 100;

  // Step 1: consumer submits photo BEFORE any CSV upload. Goes to pending.
  const result = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phone,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: invoiceNumber,
      total_amount: amount,
      transaction_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      customer_phone: null,
      merchant_rif: 'J-12345678-9',
      merchant_name: 'Tienda',
      document_type: 'fiscal_invoice',
      currency: 'BS',
      payment_reference: null,
      bank_name: null,
      confidence_score: 0.95,
    } as any,
  });
  await assert('Step 1: photo accepted as pending',
    result.success === true && result.stage === 'pending',
    `success=${result.success} stage=${result.stage}`);

  // Verify the pending state
  const consumerAcct = await prisma.account.findFirst({
    where: { tenantId: tenant.id, phoneNumber: phone },
  });
  const balBefore = await getAccountBalanceBreakdown(consumerAcct!.id, asset.id, tenant.id);
  await assert('provisional bucket shows the pending credit (not zero)',
    Number(balBefore.provisional) > 0,
    `confirmed=${balBefore.confirmed} provisional=${balBefore.provisional}`);
  await assert('confirmed bucket is 0 before reconcile',
    Number(balBefore.confirmed) === 0,
    `confirmed=${balBefore.confirmed}`);

  const invBefore = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber },
  });
  await assert('invoice row is pending_validation before CSV',
    invBefore?.status === 'pending_validation',
    `status=${invBefore?.status}`);

  // Step 2: merchant uploads CSV with the matching invoice number
  const txDate = new Date().toISOString().slice(0, 10);
  const csvResult = await processCSV(
    `invoice_number,total,date,phone\n${invoiceNumber},${amount},${txDate},${phone}`,
    tenant.id, owner.id,
  );
  await assert('Step 2: CSV upload completed',
    csvResult.status === 'completed', `status=${csvResult.status}`);

  // Step 3: verify the reconciliation happened
  const invAfter = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber },
  });
  await assert('Step 3: invoice row flipped to claimed',
    invAfter?.status === 'claimed', `status=${invAfter?.status}`);

  const balAfter = await getAccountBalanceBreakdown(consumerAcct!.id, asset.id, tenant.id);
  await assert('consumer provisional bucket is now 0',
    Number(balAfter.provisional) === 0,
    `provisional=${balAfter.provisional}`);
  await assert('consumer confirmed bucket absorbed the credit',
    Number(balAfter.confirmed) > 0,
    `confirmed=${balAfter.confirmed}`);
  await assert('total balance preserved through reconciliation',
    Math.abs(Number(balAfter.total) - Number(balBefore.total)) < 0.0001,
    `before_total=${balBefore.total} after_total=${balAfter.total}`);

  // Regression in a fresh tenant (before any CSV upload, the strict-match
  // gate from item 1 is dormant, so photo submissions of unknown invoices
  // still land as pending_validation — the condition we need to test).
  const tenant2 = await createTenant(`Reconcile2 ${ts}`, `rec2-${ts}`, `rec2-${ts}@e2e.local`);
  await createSystemAccounts(tenant2.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant2.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({
    where: { id: tenant2.id },
    data: { rif: 'J-87654321-0', referenceCurrency: 'usd', preferredExchangeSource: 'bcv' },
  });
  const owner2 = await prisma.staff.create({
    data: {
      tenantId: tenant2.id, name: 'Owner', email: `rec2-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });

  const phone2 = `+58414${String(ts).slice(-7)}2`;
  const invoiceNumber2 = `INV-REC2-${ts}`;
  await validateInvoice({
    tenantId: tenant2.id,
    senderPhone: phone2,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: invoiceNumber2,
      total_amount: 100,
      transaction_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      customer_phone: null,
      merchant_rif: 'J-87654321-0',
      merchant_name: 'Tienda2',
      document_type: 'fiscal_invoice',
      currency: 'BS',
      payment_reference: null,
      bank_name: null,
      confidence_score: 0.95,
    } as any,
  });

  // Upload CSV with a DIFFERENT amount — reconcile guard (5% tolerance) rejects the flip
  await processCSV(
    `invoice_number,total,date,phone\n${invoiceNumber2},200,${txDate},${phone2}`,
    tenant2.id, owner2.id,
  );
  const invMismatch = await prisma.invoice.findFirst({
    where: { tenantId: tenant2.id, invoiceNumber: invoiceNumber2 },
  });
  await assert('regression: amount mismatch leaves invoice as pending_validation',
    invMismatch?.status === 'pending_validation',
    `status=${invMismatch?.status}`);

  const consumer2 = await prisma.account.findFirst({
    where: { tenantId: tenant2.id, phoneNumber: phone2 },
  });
  const bal2 = await getAccountBalanceBreakdown(consumer2!.id, asset.id, tenant2.id);
  await assert('regression: provisional bucket still populated when no reconcile',
    Number(bal2.provisional) > 0 && Number(bal2.confirmed) === 0,
    `confirmed=${bal2.confirmed} provisional=${bal2.provisional}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
