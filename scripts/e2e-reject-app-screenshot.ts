/**
 * E2E for Eric's 2026-04-23 Notion ask "Pagos en efectivo - WhatsApp":
 *
 *   "El QR que genera el comercio no debe pasar el canje por whatsapp.
 *    Estos son los QR que se generaron y se pasaron por WA."
 *
 * A customer sent the screenshot of the cashier-generated dual-scan QR
 * (the "pago en efectivo" flow) via WhatsApp, and the invoice pipeline
 * happily parsed the $10 label and created a VOUCHER- row. That must not
 * happen — those QRs are meant to be scanned from inside the app, never
 * sent to the bot as a factura.
 *
 * validateInvoice now inspects the OCR raw text for Valee's in-app
 * screen copy ("Muestra este codigo al cliente" / "...al cajero" /
 * "Dile este codigo al cajero") and short-circuits with an
 * `app_screenshot` rejection before any ledger row or invoice is touched.
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
  console.log('=== Reject in-app screenshot E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`App Screenshot ${ts}`, `app-ss-${ts}`, `app-ss-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const phone = `+19200${String(ts).slice(-7)}`;

  // Shared extracted-data shim — the OCR pattern check runs BEFORE extraction
  // so the content of `extractedData` doesn't matter for these assertions.
  const extractedData = {
    invoice_number: null,
    total_amount: 10,
    transaction_date: '2026-04-23',
    customer_phone: null,
    merchant_name: 'Valee',
    confidence_score: 0.99,
    document_type: 'voucher' as const,
  };

  // ── Dual-scan merchant screen (Eric's exact evidence) ──
  const merchantScreenOcr = `$10
Muestra este codigo al cliente
10s`;
  const rMerchant = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phone,
    assetTypeId: asset.id,
    extractedData,
    ocrRawText: merchantScreenOcr,
  });
  await assert('dual-scan merchant screenshot rejected',
    rMerchant.success === false && rMerchant.stage === 'app_screenshot',
    `success=${rMerchant.success} stage=${rMerchant.stage}`);
  await assert('rejection message mentions "QR de la app Valee"',
    /qr\s+de\s+la\s+app\s+valee/i.test(rMerchant.message),
    `msg=${rMerchant.message}`);

  // ── Consumer redemption QR screen ──
  const consumerScreenOcr = `Tu codigo QR de canje
Muestra este codigo al cajero
50 pts`;
  const rConsumer = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phone,
    assetTypeId: asset.id,
    extractedData,
    ocrRawText: consumerScreenOcr,
  });
  await assert('consumer redemption QR screenshot rejected',
    rConsumer.success === false && rConsumer.stage === 'app_screenshot',
    `stage=${rConsumer.stage}`);

  // ── Short-code fallback screen ──
  const shortCodeScreenOcr = `Codigo manual: 123456
Dile este codigo al cajero si no puede escanear`;
  const rShort = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phone,
    assetTypeId: asset.id,
    extractedData,
    ocrRawText: shortCodeScreenOcr,
  });
  await assert('short-code fallback screenshot rejected',
    rShort.success === false && rShort.stage === 'app_screenshot',
    `stage=${rShort.stage}`);

  // ── Real invoice OCR text should NOT trigger the rejection ──
  const realInvoiceOcr = `TIENDA EL SOL
Factura 00012345
Fecha: 23/04/2026
Total: Bs 50
Gracias por su compra`;
  const rReal = await validateInvoice({
    tenantId: tenant.id,
    senderPhone: phone,
    assetTypeId: asset.id,
    extractedData: { ...extractedData, invoice_number: '00012345', total_amount: 50, document_type: 'fiscal_invoice' },
    ocrRawText: realInvoiceOcr,
  });
  await assert('real invoice OCR does NOT trigger app_screenshot rejection',
    rReal.stage !== 'app_screenshot',
    `stage=${rReal.stage}`);

  // ── No voucher/ledger row was created for any of the rejected submissions ──
  const voucherRowsForTenant = await prisma.invoice.count({
    where: { tenantId: tenant.id },
  });
  await assert('no invoice rows created for the rejected screenshots',
    voucherRowsForTenant === 0,
    `rows=${voucherRowsForTenant}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
