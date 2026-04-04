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
  const confidenceThreshold = parseFloat(process.env.OCR_CONFIDENCE_THRESHOLD || '0.7');

  if (extracted.confidence_score < confidenceThreshold) {
    return { success: false, stage: 'extraction', message: 'Could not read the invoice clearly. Please send a clearer photo.' };
  }
  if (!extracted.invoice_number || extracted.total_amount === null) {
    return { success: false, stage: 'extraction', message: 'Could not extract invoice number or amount from the image. Please try again.' };
  }

  // STAGE B: Identity cross-check
  if (extracted.customer_phone) {
    const normalizedExtracted = extracted.customer_phone.replace(/[^\d]/g, '');
    const normalizedSender = senderPhone.replace(/[^\d]/g, '');
    if (normalizedExtracted !== normalizedSender) {
      return { success: false, stage: 'identity_check', message: 'The phone number on the invoice does not match your account. This invoice cannot be claimed by this number.', invoiceNumber: extracted.invoice_number };
    }
  }

  // STAGE C: Merchant data cross-reference
  const invoice = await prisma.invoice.findUnique({
    where: { tenantId_invoiceNumber: { tenantId, invoiceNumber: extracted.invoice_number } },
  });

  if (!invoice) {
    return { success: false, stage: 'cross_reference', message: 'This invoice was not found in the merchant records. It may not have been uploaded yet.', invoiceNumber: extracted.invoice_number, status: 'pending_validation' };
  }
  if (invoice.status === 'claimed') {
    return { success: false, stage: 'cross_reference', message: 'This invoice has already been used to claim rewards.', invoiceNumber: extracted.invoice_number };
  }

  const tolerance = parseFloat(process.env.INVOICE_AMOUNT_TOLERANCE || '0.05');
  const amountDiff = Math.abs(Number(invoice.amount) - extracted.total_amount);
  if (amountDiff > tolerance * extracted.total_amount) {
    return { success: false, stage: 'cross_reference', message: `The amount on the invoice ($${extracted.total_amount}) does not match the merchant records ($${invoice.amount}). This submission has been flagged for review.`, invoiceNumber: extracted.invoice_number, status: 'manual_review' };
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
      message: 'Your submission is under review due to a location discrepancy. We will notify you of the result.',
      invoiceNumber: extracted.invoice_number, status: 'manual_review',
    };
  }

  // STAGE D: Value assignment
  const { account: consumerAccount } = await findOrCreateConsumerAccount(tenantId, senderPhone);
  const poolAccount = await getSystemAccount(tenantId, 'issued_value_pool');
  if (!poolAccount) throw new Error(`System account 'issued_value_pool' not found for tenant ${tenantId}`);

  const loyaltyValue = await convertToLoyaltyValue(invoice.amount.toString(), tenantId, assetTypeId);

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
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: 'claimed', consumerAccountId: consumerAccount.id, ledgerEntryId: ledgerResult.credit.id },
  });

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

  let message = `Invoice validated! You earned ${loyaltyValue} points. Your new balance is ${newBalance} points.`;
  if (levelResult.leveled) {
    message += ` Congratulations — you reached level ${levelResult.newLevel}!`;
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

  await prisma.$executeRaw`
    INSERT INTO invoices (id, tenant_id, invoice_number, amount, customer_phone, status, source,
      consumer_account_id, ledger_entry_id, ocr_raw_text, extracted_data,
      submitted_latitude, submitted_longitude, created_at, updated_at)
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${invoiceNumber}, ${totalAmount},
      ${senderPhone}, 'pending_validation', 'photo_submission',
      ${consumerAccount.id}::uuid, ${ledgerResult.credit.id}::uuid,
      ${params.ocrRawText || null}, ${params.extractedData ? JSON.stringify(params.extractedData) : null}::jsonb,
      ${params.latitude || null}::decimal, ${params.longitude || null}::decimal, now(), now())
    ON CONFLICT (tenant_id, invoice_number) DO NOTHING
  `;

  const newBalance = await getAccountBalance(consumerAccount.id, assetTypeId, tenantId);

  return {
    success: true, stage: 'pending',
    message: `Your invoice is being verified. You have a provisional balance of ${newBalance} points. We will notify you when confirmed.`,
    valueAssigned: loyaltyValue, newBalance, invoiceNumber, status: 'pending_validation',
  };
}
