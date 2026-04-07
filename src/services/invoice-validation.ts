import prisma from '../db/client.js';
import { findOrCreateConsumerAccount, getSystemAccount } from './accounts.js';
import { writeDoubleEntry, getAccountBalance } from './ledger.js';
import { convertToLoyaltyValue } from './assets.js';
import { checkGeofence } from './geofencing.js';
import { extractFromImage } from './ocr.js';
import { generateOutputToken } from './qr-token.js';
import { checkAndUpdateLevel } from './levels.js';

export interface ExtractedInvoiceData {
  invoice_number: string | null;
  total_amount: number | null;
  transaction_date: string | null;
  transaction_time?: string | null;
  customer_phone: string | null;
  merchant_name: string | null;
  order_items?: Array<{ name: string; quantity: number; unit_price: number }> | null;
  confidence_score: number;
  // For mobile_payment screenshots:
  document_type?: 'fiscal_invoice' | 'mobile_payment' | 'voucher' | null;
  bank_name?: string | null;
  payment_reference?: string | null;
}

export interface ValidationResult {
  success: boolean;
  stage: string;
  message: string;
  valueAssigned?: string;
  newBalance?: string;
  invoiceNumber?: string;
  status?: string;
  outputToken?: string;
}

export async function extractInvoiceData(
  imageBuffer: Buffer | null,
  preExtracted?: ExtractedInvoiceData
): Promise<{ data: ExtractedInvoiceData; ocrRawText: string | null }> {
  if (preExtracted) return { data: preExtracted, ocrRawText: null };

  if (imageBuffer) {
    const result = await extractFromImage(imageBuffer);
    return { data: result.extractedData, ocrRawText: result.ocrRawText };
  }

  return {
    ocrRawText: null,
    data: {
      invoice_number: null, total_amount: null, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0,
    },
  };
}

export async function validateInvoice(params: {
  tenantId: string;
  senderPhone: string;
  imageBuffer?: Buffer | null;
  extractedData?: ExtractedInvoiceData;
  latitude?: string | null;
  longitude?: string | null;
  deviceId?: string | null;
  assetTypeId: string;
}): Promise<ValidationResult> {
  const { tenantId, senderPhone, assetTypeId } = params;

  // STAGE A: Extract data (real OCR+AI if image provided, or pre-extracted for tests)
  const { data: extracted, ocrRawText } = await extractInvoiceData(params.imageBuffer || null, params.extractedData);
  console.log('[Validation] Extracted:', JSON.stringify({
    invoice_number: extracted.invoice_number,
    total_amount: extracted.total_amount,
    customer_phone: extracted.customer_phone,
    merchant_name: extracted.merchant_name,
    document_type: extracted.document_type,
    bank_name: extracted.bank_name,
    confidence_score: extracted.confidence_score,
  }));
  const confidenceThreshold = parseFloat(process.env.OCR_CONFIDENCE_THRESHOLD || '0.7');

  if (extracted.confidence_score < confidenceThreshold) {
    return { success: false, stage: 'extraction', message: 'No pudimos leer la factura con claridad. Por favor envia una foto mas clara.' };
  }

  // For vouchers without an invoice number, generate a synthetic reference based on
  // tenant + amount + date hash so duplicate submissions are still rejected.
  if (!extracted.invoice_number && extracted.document_type === 'voucher' && extracted.total_amount !== null) {
    const dateKey = (extracted.transaction_date || new Date().toISOString().split('T')[0]).replace(/-/g, '');
    const timeKey = (extracted.transaction_time || '0000').replace(/:/g, '');
    extracted.invoice_number = `VOUCHER-${dateKey}-${timeKey}-${Math.round(extracted.total_amount * 100)}`;
    console.log('[Validation] Generated synthetic voucher reference:', extracted.invoice_number);
  }

  if (!extracted.invoice_number || extracted.total_amount === null) {
    return { success: false, stage: 'extraction', message: 'No pudimos extraer el numero de factura o el monto de la imagen. Por favor intenta de nuevo.' };
  }

  // STAGE B: Identity cross-check
  if (extracted.customer_phone) {
    // Normalize by stripping all non-digits then comparing the last 10 digits.
    // This handles variations: local format (04140446569), international (+584140446569),
    // with or without country code, with or without leading 0.
    // Last 10 digits = the actual phone number without country code, which is globally unique within a country.
    const digitsExtracted = extracted.customer_phone.replace(/[^\d]/g, '');
    const digitsSender = senderPhone.replace(/[^\d]/g, '');
    const last10Extracted = digitsExtracted.slice(-10);
    const last10Sender = digitsSender.slice(-10);

    if (last10Extracted.length >= 7 && last10Sender.length >= 7 && last10Extracted !== last10Sender) {
      console.log(`[Identity] Phone mismatch: invoice=${digitsExtracted} sender=${digitsSender} (last10: ${last10Extracted} vs ${last10Sender})`);
      return { success: false, stage: 'identity_check', message: 'El numero de telefono en la factura no coincide con tu cuenta. Esta factura no puede ser reclamada desde este numero.', invoiceNumber: extracted.invoice_number };
    }
  }

  // STAGE C: Merchant data cross-reference
  const invoice = await prisma.invoice.findUnique({
    where: { tenantId_invoiceNumber: { tenantId, invoiceNumber: extracted.invoice_number } },
  });

  if (!invoice) {
    // Auto-credit provisionally and queue for reconciliation
    const provisional = await createPendingValidation({
      tenantId,
      senderPhone,
      invoiceNumber: extracted.invoice_number,
      totalAmount: extracted.total_amount,
      assetTypeId,
      ocrRawText: ocrRawText || undefined,
      extractedData: extracted,
      latitude: params.latitude,
      longitude: params.longitude,
    });
    return provisional;
  }
  if (invoice.status === 'claimed') {
    return { success: false, stage: 'cross_reference', message: 'Esta factura ya fue usada para reclamar puntos anteriormente.', invoiceNumber: extracted.invoice_number };
  }

  const tolerance = parseFloat(process.env.INVOICE_AMOUNT_TOLERANCE || '0.05');
  const amountDiff = Math.abs(Number(invoice.amount) - extracted.total_amount);
  if (amountDiff > tolerance * extracted.total_amount) {
    // Credit provisionally with the merchant's recorded amount, route to manual review
    const { account: consumerAccount } = await findOrCreateConsumerAccount(tenantId, senderPhone);
    const poolAccount = await getSystemAccount(tenantId, 'issued_value_pool');
    if (!poolAccount) throw new Error('issued_value_pool not found');
    const loyaltyValue = await convertToLoyaltyValue(extracted.total_amount.toString(), tenantId, assetTypeId);
    await writeDoubleEntry({
      tenantId,
      eventType: 'INVOICE_CLAIMED',
      debitAccountId: poolAccount.id,
      creditAccountId: consumerAccount.id,
      amount: loyaltyValue,
      assetTypeId,
      referenceId: `REVIEW-${extracted.invoice_number}-${Date.now()}`,
      referenceType: 'invoice',
      status: 'provisional',
      latitude: params.latitude || null,
      longitude: params.longitude || null,
    });
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'manual_review', rejectionReason: `Amount mismatch: extracted ${extracted.total_amount} vs recorded ${invoice.amount}` },
    });
    const newBalance = await getAccountBalance(consumerAccount.id, assetTypeId, tenantId);
    return {
      success: true, stage: 'pending',
      message: `Recibimos tu factura. Ganaste ${parseFloat(loyaltyValue).toLocaleString()} puntos (en verificacion). Tu saldo: ${parseFloat(newBalance).toLocaleString()} puntos. Te confirmamos en breve.`,
      valueAssigned: loyaltyValue, newBalance, invoiceNumber: extracted.invoice_number, status: 'manual_review',
    };
  }

  // GEOFENCE CHECK: after cross-reference passes, before value assignment
  const geoCheck = await checkGeofence({
    consumerLat: params.latitude ? parseFloat(params.latitude) : null,
    consumerLon: params.longitude ? parseFloat(params.longitude) : null,
    tenantId,
    branchId: invoice.branchId,
    invoiceTimestamp: invoice.transactionDate || invoice.createdAt,
  });

  if (!geoCheck.plausible) {
    // Route to manual review instead of auto-approving
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'manual_review',
        rejectionReason: geoCheck.reason || 'Geographic discrepancy detected',
        submittedLatitude: params.latitude ? parseFloat(params.latitude) as any : null,
        submittedLongitude: params.longitude ? parseFloat(params.longitude) as any : null,
      },
    });
    return {
      success: false, stage: 'geofence',
      message: 'Tu envio esta en revision por una discrepancia de ubicacion. Te notificaremos el resultado.',
      invoiceNumber: extracted.invoice_number, status: 'manual_review',
    };
  }

  // STAGE D: Value assignment
  const { account: consumerAccount } = await findOrCreateConsumerAccount(tenantId, senderPhone);
  const poolAccount = await getSystemAccount(tenantId, 'issued_value_pool');
  if (!poolAccount) throw new Error(`System account 'issued_value_pool' not found for tenant ${tenantId}`);

  // BS → reference currency normalization (Venezuela multi-rate handling)
  // If tenant has a preferred exchange source, normalize the BS amount to USD/EUR
  // using the rate effective at the invoice's transaction date.
  // Otherwise use the raw invoice amount (for tenants billing in USD already, or
  // tenants outside Venezuela).
  const tenantConfig = await prisma.tenant.findUnique({ where: { id: tenantId } });
  let normalizedAmount = invoice.amount.toString();
  let exchangeRateUsed: { source: string; currency: string; rateBs: number } | null = null;

  if (tenantConfig?.preferredExchangeSource) {
    const { convertBsToReference, getRateAtDate } = await import('./exchange-rates.js');
    const txDate = invoice.transactionDate || invoice.createdAt;
    const converted = await convertBsToReference(
      Number(invoice.amount),
      tenantConfig.preferredExchangeSource,
      tenantConfig.referenceCurrency,
      txDate
    );
    if (converted !== null) {
      normalizedAmount = converted.toFixed(8);
      const rateInfo = await getRateAtDate(
        tenantConfig.preferredExchangeSource,
        tenantConfig.referenceCurrency,
        txDate
      );
      if (rateInfo) {
        exchangeRateUsed = {
          source: tenantConfig.preferredExchangeSource,
          currency: tenantConfig.referenceCurrency,
          rateBs: rateInfo.rateBs,
        };
      }
      console.log(`[Validation] BS→${tenantConfig.referenceCurrency.toUpperCase()} normalization: Bs ${invoice.amount} ÷ ${exchangeRateUsed?.rateBs} = ${normalizedAmount}`);
    }
  }

  const loyaltyValue = await convertToLoyaltyValue(normalizedAmount, tenantId, assetTypeId);

  // Sales attribution: was this invoice triggered by a recent Valee outreach?
  const { checkAttribution } = await import('./attribution.js');
  const attribution = await checkAttribution({
    tenantId,
    consumerAccountId: consumerAccount.id,
  });

  // Build the metadata payload merging exchange rate + attribution info
  const ledgerMetadata: Record<string, unknown> = {};
  if (exchangeRateUsed) {
    ledgerMetadata.originalAmount = invoice.amount.toString();
    ledgerMetadata.originalCurrency = 'bs';
    ledgerMetadata.normalizedAmount = normalizedAmount;
    ledgerMetadata.exchangeRate = exchangeRateUsed;
  }
  if (attribution.attributed) {
    ledgerMetadata.attribution = 'valee_influenced';
    ledgerMetadata.attributionNotificationId = attribution.notificationId;
    ledgerMetadata.attributionType = attribution.notificationType;
    ledgerMetadata.attributionSentAt = attribution.sentAt?.toISOString();
    console.log(`[Attribution] Invoice attributed to Valee outreach (${attribution.notificationType}, sent ${attribution.sentAt?.toISOString()})`);
  }

  const ledgerResult = await writeDoubleEntry({
    tenantId,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: poolAccount.id,
    creditAccountId: consumerAccount.id,
    amount: loyaltyValue,
    assetTypeId,
    referenceId: extracted.invoice_number,
    referenceType: 'invoice',
    branchId: invoice.branchId || null,
    latitude: params.latitude || null,
    longitude: params.longitude || null,
    deviceId: params.deviceId || null,
    metadata: Object.keys(ledgerMetadata).length > 0 ? ledgerMetadata : undefined,
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: 'claimed', consumerAccountId: consumerAccount.id, ledgerEntryId: ledgerResult.credit.id },
  });

  // Record platform revenue if this was an attributed sale
  if (attribution.attributed) {
    const { recordAttributedSaleFee } = await import('./platform-revenue.js');
    await recordAttributedSaleFee({
      tenantId,
      invoiceAmount: normalizedAmount,
      ledgerEntryId: ledgerResult.credit.id,
      attributionNotificationId: attribution.notificationId,
    });
  }

  // Generate output token — immediately after INVOICE_CLAIMED, attached to the ledger entry
  const outputToken = generateOutputToken(
    ledgerResult.credit.id,
    consumerAccount.id,
    loyaltyValue,
    tenantId
  );

  // Store token signature on the invoice record (ledger is immutable — can't UPDATE it)
  // The token is linked to the ledger entry via outputToken.payload.ledgerEntryId
  // Store token signature + full order details on the invoice record
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      extractedData: { ...(invoice.extractedData as any || {}), outputTokenSignature: outputToken.signature },
      orderDetails: extracted.order_items ? { items: extracted.order_items, extractedAt: new Date().toISOString() } : undefined,
    },
  });

  // STAGE E: Get new balance + check level-up
  const newBalance = await getAccountBalance(consumerAccount.id, assetTypeId, tenantId);
  const levelResult = await checkAndUpdateLevel(consumerAccount.id, tenantId);

  let message = `Factura validada! Ganaste ${loyaltyValue} puntos. Tu nuevo saldo es ${newBalance} puntos.`;
  if (levelResult.leveled) {
    message += ` Felicidades — alcanzaste el nivel ${levelResult.newLevel}!`;
  }

  return {
    success: true, stage: 'complete', message,
    valueAssigned: loyaltyValue, newBalance, invoiceNumber: extracted.invoice_number,
    outputToken: outputToken.token,
  };
}

export async function createPendingValidation(params: {
  tenantId: string;
  senderPhone: string;
  invoiceNumber: string;
  totalAmount: number;
  assetTypeId: string;
  ocrRawText?: string;
  extractedData?: ExtractedInvoiceData;
  latitude?: string | null;
  longitude?: string | null;
}): Promise<ValidationResult> {
  const { tenantId, senderPhone, invoiceNumber, totalAmount, assetTypeId } = params;

  const { account: consumerAccount } = await findOrCreateConsumerAccount(tenantId, senderPhone);
  const poolAccount = await getSystemAccount(tenantId, 'issued_value_pool');
  if (!poolAccount) throw new Error('issued_value_pool not found');

  const loyaltyValue = await convertToLoyaltyValue(totalAmount.toString(), tenantId, assetTypeId);

  const ledgerResult = await writeDoubleEntry({
    tenantId,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: poolAccount.id,
    creditAccountId: consumerAccount.id,
    amount: loyaltyValue,
    assetTypeId,
    referenceId: `PENDING-${invoiceNumber}`,
    referenceType: 'invoice',
    status: 'provisional',
    latitude: params.latitude || null,
    longitude: params.longitude || null,
  });

  // Determine source from extracted data: mobile_payment, voucher, or default photo_submission
  const docType = params.extractedData?.document_type;
  const sourceLiteral =
    docType === 'mobile_payment' ? 'mobile_payment' :
    docType === 'voucher' ? 'voucher' :
    'photo_submission';

  await prisma.$executeRawUnsafe(
    `INSERT INTO invoices (id, tenant_id, invoice_number, amount, customer_phone, status, source,
      consumer_account_id, ledger_entry_id, ocr_raw_text, extracted_data,
      submitted_latitude, submitted_longitude, created_at, updated_at)
    VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, 'pending_validation', $5::"InvoiceSource",
      $6::uuid, $7::uuid, $8, $9::jsonb, $10::decimal, $11::decimal, now(), now())
    ON CONFLICT (tenant_id, invoice_number) DO NOTHING`,
    tenantId,
    invoiceNumber,
    totalAmount,
    senderPhone,
    sourceLiteral,
    consumerAccount.id,
    ledgerResult.credit.id,
    params.ocrRawText || null,
    params.extractedData ? JSON.stringify(params.extractedData) : null,
    params.latitude || null,
    params.longitude || null,
  );

  const newBalance = await getAccountBalance(consumerAccount.id, assetTypeId, tenantId);

  return {
    success: true, stage: 'pending',
    message: `Recibimos tu factura. Ganaste ${parseFloat(loyaltyValue).toLocaleString()} puntos (en verificacion). Tu saldo: ${parseFloat(newBalance).toLocaleString()} puntos. Te confirmamos en breve.`,
    valueAssigned: loyaltyValue, newBalance, invoiceNumber, status: 'pending_validation',
  };
}
