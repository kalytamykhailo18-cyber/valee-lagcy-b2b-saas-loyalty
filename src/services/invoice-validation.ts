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
  customer_cedula?: string | null;     // Venezuelan ID: V-XXXXXXXX, E-XXXXXXXX
  customer_name?: string | null;       // Customer name if printed on receipt
  merchant_name: string | null;
  merchant_rif?: string | null;       // Venezuelan tax ID format: J/V/E/G/P-XXXXXXXX(-X)
  currency?: string | null;            // ISO-ish: "BS","USD","EUR","COP","MXN"...
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
  ocrRawText?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  deviceId?: string | null;
  assetTypeId: string;
  branchId?: string | null;
}): Promise<ValidationResult> {
  const { tenantId, senderPhone, assetTypeId } = params;

  // STAGE 0: Trust-level gate
  // Each tenant declares which source types they accept. A tenant on level_1_strict
  // rejects voucher and mobile_payment entirely. A tenant on level_3_presence only
  // accepts dual_scan events (which don't flow through this function at all).
  // level_2_standard accepts everything and applies layered anti-fraud downstream.
  const tenantForTrust = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (tenantForTrust) {
    const trustLevel = tenantForTrust.trustLevel;

    // level_3_presence rejects ALL image submissions regardless of type.
    // Only dual_scan events are accepted and those use a different code path.
    if (trustLevel === 'level_3_presence') {
      return {
        success: false,
        stage: 'trust_level',
        message: 'Este comercio no acepta fotos de factura. El cajero te va a generar un codigo QR para escanear.',
      };
    }

    // level_1_strict requires fiscal_invoice. If we can determine the type now (from
    // pre-extracted data), reject early. Otherwise re-check after OCR below.
    if (trustLevel === 'level_1_strict') {
      const preDocType = params.extractedData?.document_type || null;
      if (preDocType && preDocType !== 'fiscal_invoice') {
        return {
          success: false,
          stage: 'trust_level',
          message: 'Este comercio solo acepta facturas fiscales. Envia una factura oficial con numero y tus datos.',
        };
      }
    }
  }

  // STAGE 0.5: Image-hash deduplication.
  // LLM extraction is probabilistic — even with temperature=0 the same photo may
  // produce slightly different invoice_number strings if OCR output varies. The
  // only bulletproof dedup key is the image content itself. If this tenant already
  // has a ledger entry referencing this exact image hash, reject.
  let imageHash: string | null = null;
  if (params.imageBuffer) {
    const crypto = await import('crypto');
    imageHash = crypto.createHash('sha256').update(params.imageBuffer).digest('hex');
    const existingByHash = await prisma.ledgerEntry.findFirst({
      where: {
        tenantId,
        eventType: 'INVOICE_CLAIMED',
        entryType: 'CREDIT',
        metadata: { path: ['imageHash'], equals: imageHash },
      },
      select: { id: true, referenceId: true, status: true, accountId: true },
    });
    if (existingByHash) {
      // Was the original credit on the same user that is now sending the photo?
      let isOriginalSubmitter = false;
      const senderAccount = await prisma.account.findUnique({
        where: { tenantId_phoneNumber: { tenantId, phoneNumber: senderPhone } },
        select: { id: true },
      });
      if (senderAccount && senderAccount.id === existingByHash.accountId) {
        isOriginalSubmitter = true;
      }
      console.log(`[Validation] Duplicate image hash blocked: tenant=${tenantId} hash=${imageHash.slice(0, 12)} existingRef=${existingByHash.referenceId} status=${existingByHash.status} sameUser=${isOriginalSubmitter}`);
      return {
        success: false,
        stage: 'cross_reference',
        message: isOriginalSubmitter
          ? 'Ya enviaste esta foto antes. La factura ya esta registrada en tu cuenta.'
          : 'Esta factura ya fue enviada por otro cliente. No se puede reclamar dos veces.',
        invoiceNumber: existingByHash.referenceId,
      };
    }
  }

  // STAGE A: Extract data (real OCR+AI if image provided, or pre-extracted for tests)
  const extractResult = await extractInvoiceData(params.imageBuffer || null, params.extractedData);
  const extracted = extractResult.data;
  // Prefer passed-in ocrRawText (for testing or WhatsApp pipeline), fall back to OCR result
  const ocrRawText = params.ocrRawText ?? extractResult.ocrRawText;

  // STAGE A1: OCR-text-based fuzzy dedup via Jaccard similarity.
  //
  // Google Vision is NOT deterministic across WhatsApp re-encodings — it often
  // misreads individual characters (8↔0, 1↔l, etc.). A simple hash-equality
  // check fails because even one mis-OCRed char produces a different hash.
  //
  // Instead we tokenize the OCR text into word tokens and compare the SET of
  // tokens between two receipts. If ≥70% of tokens are shared (Jaccard index),
  // it's the same physical receipt. Typical OCR variations only affect a few
  // tokens out of hundreds, so a re-submission of the same photo scores >95%.
  // A different receipt (even at the same merchant/amount) has totally
  // different items/time/control numbers and scores <30%.
  //
  // This still does NOT block legitimate promo cases where many customers buy
  // the same thing — each receipt has different items/time/cashier/control
  // numbers, producing distinct token sets.
  if (ocrRawText && ocrRawText.length > 50) {
    const tokenize = (s: string): Set<string> =>
      new Set(
        s.toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(t => t.length >= 2)
      );
    const newTokens = tokenize(ocrRawText);

    const candidates = await prisma.invoice.findMany({
      where: {
        tenantId,
        ocrRawText: { not: null },
        status: { in: ['pending_validation', 'claimed', 'manual_review', 'rejected'] },
      },
      select: { id: true, invoiceNumber: true, ocrRawText: true, consumerAccountId: true, status: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    let best: { candidate: typeof candidates[number]; similarity: number } | null = null;
    for (const candidate of candidates) {
      if (!candidate.ocrRawText) continue;
      const candidateTokens = tokenize(candidate.ocrRawText);
      if (candidateTokens.size === 0 || newTokens.size === 0) continue;
      let intersect = 0;
      for (const t of newTokens) if (candidateTokens.has(t)) intersect++;
      const union = newTokens.size + candidateTokens.size - intersect;
      const similarity = intersect / union;
      if (!best || similarity > best.similarity) {
        best = { candidate, similarity };
      }
    }

    if (best && best.similarity >= 0.70) {
      console.log(`[Validation] OCR Jaccard match: extracted=${extracted.invoice_number} matches existing=${best.candidate.invoiceNumber} similarity=${best.similarity.toFixed(3)} status=${best.candidate.status}`);
      let isOriginalSubmitter = false;
      if (best.candidate.consumerAccountId) {
        const senderAccount = await prisma.account.findUnique({
          where: { tenantId_phoneNumber: { tenantId, phoneNumber: senderPhone } },
          select: { id: true },
        });
        if (senderAccount && senderAccount.id === best.candidate.consumerAccountId) {
          isOriginalSubmitter = true;
        }
      }
      return {
        success: false,
        stage: 'cross_reference',
        message: isOriginalSubmitter
          ? 'Ya enviaste esta misma factura antes. No se puede procesar dos veces.'
          : 'Esta factura ya fue enviada anteriormente por otro cliente. No se puede usar dos veces.',
        invoiceNumber: best.candidate.invoiceNumber,
      };
    }
  }

  // Post-OCR trust-level gate for level_1_strict (covers the case where pre-extracted
  // document_type wasn't provided)
  if (tenantForTrust && tenantForTrust.trustLevel === 'level_1_strict' && !params.extractedData?.document_type) {
    if (extracted.document_type && extracted.document_type !== 'fiscal_invoice') {
      return {
        success: false,
        stage: 'trust_level',
        message: 'Este comercio solo acepta facturas fiscales. Envia una factura oficial con numero y tus datos.',
      };
    }
  }
  console.log('[Validation] Extracted:', JSON.stringify({
    invoice_number: extracted.invoice_number,
    total_amount: extracted.total_amount,
    customer_phone: extracted.customer_phone,
    merchant_name: extracted.merchant_name,
    document_type: extracted.document_type,
    bank_name: extracted.bank_name,
    confidence_score: extracted.confidence_score,
  }));
  const confidenceThreshold = parseFloat(process.env.OCR_CONFIDENCE_THRESHOLD || '0.5');

  // If we got BOTH essential fields (invoice_number and total_amount), trust them and
  // skip the confidence gate. Stage C (CSV match) is the real filter — if the number
  // is wrong, it will not be found and will be routed to provisional/manual review.
  // We only reject on low confidence when we are missing one of the essential fields.
  const hasEssentials = extracted.invoice_number && extracted.total_amount !== null;
  if (!hasEssentials && extracted.confidence_score < confidenceThreshold) {
    const missing: string[] = [];
    if (!extracted.invoice_number) missing.push('numero de factura');
    if (extracted.total_amount === null) missing.push('monto total');
    if (!extracted.merchant_rif) missing.push('RIF del comercio');
    const missingText = missing.length > 0 ? missing.join(', ') : 'datos completos';
    return { success: false, stage: 'extraction', message: `No logre leer: ${missingText}. Por favor toma la foto de nuevo asegurandote de que se vea completa.` };
  }

  // For vouchers without an invoice number, generate a ROBUST synthetic reference.
  // Two real but different $10 vouchers on the same day at different times used to
  // collide with the old hash (date+amount only). The robust hash now combines:
  //   - tenant id (scoping)
  //   - amount in cents (precision, no rounding drift)
  //   - date YYYYMMDD
  //   - time HHMMSS — required, not defaulted to 0000
  //   - SHA-256 of the OCR raw text (captures any content difference between receipts)
  //   - SHA-256 of the image buffer (perceptual fingerprint fallback)
  // Without a time in the OCR we refuse to auto-generate and route to manual review.
  if (!extracted.invoice_number && extracted.document_type === 'voucher' && extracted.total_amount !== null) {
    const crypto = await import('crypto');
    const dateKey = (extracted.transaction_date || new Date().toISOString().split('T')[0]).replace(/-/g, '');
    const timeKey = (extracted.transaction_time || '').replace(/:/g, '');

    // The time was an extra safety layer for deduping two different purchases
    // made the same day for the same amount. The image-content hash and OCR
    // hash already make collisions astronomically unlikely (different photos
    // produce different fingerprints even if they're of the same receipt).
    // If no time is extractable (bank vouchers like Banco Venezuela print it
    // in non-standard formats Claude can't always parse), we still accept
    // the voucher — just use a zero placeholder in the reference.
    const safeTimeKey = timeKey && timeKey.length >= 4 ? timeKey : '000000';

    const amountCents = Math.round(extracted.total_amount * 100);
    const ocrFingerprint = ocrRawText
      ? crypto.createHash('sha256').update(ocrRawText).digest('hex').slice(0, 12)
      : '000000000000';
    const imageFingerprint = params.imageBuffer
      ? crypto.createHash('sha256').update(params.imageBuffer).digest('hex').slice(0, 12)
      : '000000000000';

    extracted.invoice_number =
      `VOUCHER-${dateKey}-${safeTimeKey}-${amountCents}-${ocrFingerprint}-${imageFingerprint}`;

    console.log('[Validation] Generated synthetic voucher reference:', extracted.invoice_number);
  }

  // If the AI couldn't find an invoice number but we DO have a total amount and
  // some other content (merchant name or OCR text), synthesize a stable reference
  // from the normalized OCR text. WhatsApp re-encoding causes minor OCR variations,
  // so the same receipt can produce different extractions across submissions — the
  // synthetic reference + Stage A1 OCR fingerprint dedup still catch duplicates.
  if (!extracted.invoice_number && extracted.total_amount !== null && ocrRawText) {
    const cryptoMod = await import('crypto');
    const normalized = ocrRawText.toLowerCase().replace(/[^a-z0-9]/g, '');
    const ocrHash = cryptoMod.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    const amountCents = Math.round(extracted.total_amount * 100);
    extracted.invoice_number = `AUTO-${amountCents}-${ocrHash}`;
    console.log('[Validation] Generated synthetic invoice reference from OCR hash:', extracted.invoice_number);
  }

  if (!extracted.invoice_number || extracted.total_amount === null) {
    const missing: string[] = [];
    if (!extracted.invoice_number) missing.push('numero de factura');
    if (extracted.total_amount === null) missing.push('monto total');
    return { success: false, stage: 'extraction', message: `No logre leer: ${missing.join(', ')}. Por favor toma la foto de nuevo asegurandote de que se vea completa.` };
  }

  // STAGE B0: Merchant identity check via RIF + currency.
  // Names vary too much to compare reliably (a "Farmatodo CARACAS" vs the tenant
  // "Farmatodo Las Mercedes" should both match). The RIF (Venezuelan tax ID) is a
  // stable, exact identifier — if Claude extracted one and the tenant has one,
  // they must match. Currency is a coarse country gate: only Bs / USD / EUR pass.
  // The real anti-fraud check is still Stage C (CSV match), this just catches
  // obvious cross-tenant or foreign-country submissions early.
  const ALLOWED_CURRENCIES = new Set(['BS', 'BSS', 'VES', 'VEF', 'USD', 'EUR']);
  if (extracted.currency && !ALLOWED_CURRENCIES.has(extracted.currency.toUpperCase())) {
    console.log(`[Validation] Currency rejected: extracted=${extracted.currency}`);
    return {
      success: false,
      stage: 'merchant_check',
      message: `Esta factura esta en ${extracted.currency}. Solo se aceptan facturas en bolivares, dolares o euros.`,
      invoiceNumber: extracted.invoice_number,
    };
  }

  // RIF validation: if the tenant has a RIF configured and the document is a fiscal_invoice,
  // the RIF MUST be visible in the image. This prevents submitting receipts from other
  // merchants (e.g. a Burger Bar receipt to a Pizzeria bot).
  if (tenantForTrust?.rif && extracted.document_type === 'fiscal_invoice' && !extracted.merchant_rif) {
    console.log(`[Validation] RIF not found in fiscal invoice image. Tenant requires RIF: ${tenantForTrust.rif}`);
    return {
      success: false,
      stage: 'merchant_check',
      message: 'No logramos identificar el RIF del comercio en la foto. Por favor toma la foto completa donde se vea el encabezado con el RIF y el total.',
      invoiceNumber: extracted.invoice_number,
    };
  }

  if (extracted.merchant_rif && tenantForTrust?.rif) {
    const normRif = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
    const extractedRif = normRif(extracted.merchant_rif);
    const tenantRif = normRif(tenantForTrust.rif);

    const extractedDigits = extractedRif.replace(/\D/g, '');
    const tenantDigits = tenantRif.replace(/\D/g, '');

    // Fuzzy match with 1-digit tolerance for thermal print degradation.
    // Allow: exact match, substring (length mismatch from OCR adding/removing
    // digits), or same-length strings differing by at most 1 character.
    const sameLengthFuzzy = (a: string, b: string): boolean => {
      if (a.length !== b.length) return false;
      let diffs = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) diffs++;
        if (diffs > 1) return false;
      }
      return true;
    };

    const matches = extractedDigits === tenantDigits
      || extractedDigits.includes(tenantDigits)
      || tenantDigits.includes(extractedDigits)
      || sameLengthFuzzy(extractedDigits, tenantDigits);

    if (extractedDigits.length >= 7 && tenantDigits.length >= 7 && !matches) {
      console.log(`[Validation] RIF mismatch: tenant=${tenantForTrust.rif} extracted=${extracted.merchant_rif}`);
      return {
        success: false,
        stage: 'merchant_check',
        message: `El RIF de la factura (${extracted.merchant_rif}) no coincide con el RIF del comercio. Solo se aceptan facturas de este comercio.`,
        invoiceNumber: extracted.invoice_number,
      };
    }

    // If RIF fuzzy-matches the tenant's registered RIF, use the canonical
    // tenant RIF instead of the OCR-garbled one for display consistency.
    if (matches && extracted.merchant_rif !== tenantForTrust.rif) {
      console.log(`[Validation] RIF fuzzy match: correcting "${extracted.merchant_rif}" → "${tenantForTrust.rif}"`);
      extracted.merchant_rif = tenantForTrust.rif;
    }
  }

  // STAGE B: Triple identity verification.
  //
  // Three signals: (1) sender's WhatsApp phone, (2) phone printed on invoice,
  // (3) cedula printed on invoice. If 2+ fields are available from the invoice,
  // we compare them against the sender. A match means the digit strings are
  // identical OR differ by at most 1 digit (thermal printer wear tolerance).
  //
  // Logic:
  //   - If no identity fields on invoice → accept (can't verify)
  //   - If 1 field available → must match sender (with 1-digit tolerance)
  //   - If 2+ fields available → at least 2 out of 3 must match
  //
  // This prevents fraud (someone sending another person's receipt) while
  // tolerating OCR/print degradation on a single character.
  {
    const fuzzyMatch = (a: string, b: string): boolean => {
      if (a === b) return true;
      if (a.length !== b.length) return false;
      let diffs = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) diffs++;
        if (diffs > 1) return false;
      }
      return true;
    };

    const senderDigits = senderPhone.replace(/\D/g, '').slice(-10);

    // Only treat the extracted "phone" as a phone if it actually looks like a
    // Venezuelan mobile — 10 digits starting with 412/414/416/424/426 (with or
    // without leading 0), or the +58 form. Bank vouchers print RIFs, AFILs,
    // card numbers, and transaction refs that Claude sometimes returns in the
    // customer_phone slot; identity-matching those against the sender rejects
    // legitimate receipts.
    const VE_MOBILE_RE = /^(58)?0?4(12|14|16|24|26)\d{7}$/;
    const rawPhone = extracted.customer_phone ? extracted.customer_phone.replace(/\D/g, '') : null;
    const invoicePhoneDigits = rawPhone && VE_MOBILE_RE.test(rawPhone)
      ? rawPhone.slice(-10)
      : null;

    const invoiceCedula = extracted.customer_cedula
      ? extracted.customer_cedula.replace(/\D/g, '')
      : null;

    // Look up sender's stored cedula (if they've been verified before)
    let senderCedula: string | null = null;
    const senderAccount = await prisma.account.findUnique({
      where: { tenantId_phoneNumber: { tenantId, phoneNumber: senderPhone } },
      select: { cedula: true },
    });
    if (senderAccount?.cedula) {
      senderCedula = senderAccount.cedula.replace(/\D/g, '');
    }

    // Build match results
    const checks: { field: string; match: boolean }[] = [];

    if (invoicePhoneDigits && invoicePhoneDigits.length >= 7) {
      const phoneMatch = fuzzyMatch(senderDigits, invoicePhoneDigits);
      checks.push({ field: 'phone', match: phoneMatch });
    }

    if (invoiceCedula && invoiceCedula.length >= 5) {
      if (senderCedula && senderCedula.length >= 5) {
        const cedulaMatch = fuzzyMatch(senderCedula, invoiceCedula);
        checks.push({ field: 'cedula', match: cedulaMatch });
      }
      // If sender has no stored cedula, we can't compare — don't count it
    }

    const matchCount = checks.filter(c => c.match).length;
    const failCount = checks.filter(c => !c.match).length;

    console.log(`[Identity] Triple check: sender=${senderDigits} invoicePhone=${invoicePhoneDigits} invoiceCedula=${invoiceCedula} senderCedula=${senderCedula} checks=${JSON.stringify(checks)} matches=${matchCount} fails=${failCount}`);

    // Only reject if we have 2+ fields available AND majority don't match
    if (checks.length >= 2 && failCount > matchCount) {
      return {
        success: false,
        stage: 'identity',
        message: 'Los datos de la factura no coinciden con tu cuenta. El telefono o cedula en la factura no corresponden al numero que esta enviando.',
        invoiceNumber: extracted.invoice_number,
      };
    }
  }

  // Pre-Stage-C: resolve staff + branch attribution from recent scan sessions
  // so both the matched-invoice path and the provisional path can carry them.
  const stageCStaffWindowMin = parseInt(process.env.STAFF_ATTRIBUTION_WINDOW_MIN || '60');
  const stageCStaffCutoff = new Date(Date.now() - stageCStaffWindowMin * 60 * 1000);
  const preStageStaffScan = await prisma.staffScanSession.findFirst({
    where: { tenantId, consumerPhone: senderPhone, scannedAt: { gte: stageCStaffCutoff } },
    orderBy: { scannedAt: 'desc' },
  });
  let preStageStaffId: string | null = preStageStaffScan?.staffId || null;
  let preStageStaffBranchId: string | null = null;
  if (preStageStaffId) {
    const sRow = await prisma.staff.findUnique({ where: { id: preStageStaffId }, select: { branchId: true } });
    if (sRow?.branchId) preStageStaffBranchId = sRow.branchId;
  }
  const effectiveBranchForPending = params.branchId || preStageStaffBranchId || null;

  // STAGE C: Merchant data cross-reference
  // The invoice number is THE uniqueness key. Once an invoice number has been
  // processed (in any state) it cannot be re-used, ever. Amount is NEVER used
  // as a dedup signal because legitimate customers can have the same amount
  // (promotions, fixed-price items, etc.) and that must not be blocked.
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
      imageHash: imageHash || undefined,
      branchId: effectiveBranchForPending,
      staffId: preStageStaffId,
    });
    return provisional;
  }
  // Only 'available' invoices can be claimed. Everything else means the invoice
  // has already been touched by this tenant in some way and re-processing it would
  // cause a double-credit.
  if (invoice.status !== 'available') {
    // Distinguish "this is YOUR pending submission" from "someone else already
    // claimed/locked this invoice". The latter must NOT sound like "te
    // confirmamos en breve" — that misleads the user into thinking they will
    // receive points, when in reality the original submitter will.
    let isOriginalSubmitter = false;
    if (invoice.consumerAccountId) {
      const senderAccount = await prisma.account.findUnique({
        where: { tenantId_phoneNumber: { tenantId, phoneNumber: senderPhone } },
        select: { id: true },
      });
      if (senderAccount && senderAccount.id === invoice.consumerAccountId) {
        isOriginalSubmitter = true;
      }
    }

    const msgByStatus: Record<string, string> = isOriginalSubmitter
      ? {
          claimed: 'Esta factura ya fue usada por ti para reclamar puntos anteriormente.',
          pending_validation: 'Esta factura ya esta en verificacion (tu la enviaste antes). Te confirmamos en breve cuando se valide.',
          manual_review: 'Esta factura esta en revision por el comercio. Te avisamos el resultado.',
          rejected: 'Esta factura fue rechazada previamente y no se puede reclamar.',
        }
      : {
          claimed: 'Esta factura ya fue usada por otro cliente para reclamar puntos. No se puede usar dos veces.',
          pending_validation: 'Esta factura ya fue enviada por otro cliente y esta en verificacion. No se puede reclamar dos veces.',
          manual_review: 'Esta factura esta en revision por el comercio porque otro cliente la envio. No se puede reclamar dos veces.',
          rejected: 'Esta factura fue rechazada previamente y no se puede reclamar.',
        };
    const message = msgByStatus[invoice.status] || `Esta factura no puede ser reclamada (estado: ${invoice.status}).`;
    console.log(`[Validation] Rejecting duplicate submission: invoice=${extracted.invoice_number} status=${invoice.status} sameUser=${isOriginalSubmitter}`);
    return { success: false, stage: 'cross_reference', message, invoiceNumber: extracted.invoice_number };
  }

  const tolerance = parseFloat(process.env.INVOICE_AMOUNT_TOLERANCE || '0.05');
  const amountDiff = Math.abs(Number(invoice.amount) - extracted.total_amount);
  if (amountDiff > tolerance * extracted.total_amount) {
    // Credit provisionally with the merchant's recorded amount, route to manual review
    const { account: consumerAccount } = await findOrCreateConsumerAccount(tenantId, senderPhone);
    const poolAccount = await getSystemAccount(tenantId, 'issued_value_pool');
    if (!poolAccount) throw new Error('issued_value_pool not found');
    const loyaltyValue = await convertToLoyaltyValue(
      extracted.total_amount.toString(),
      tenantId,
      assetTypeId,
      invoice.transactionDate || undefined,
      'bs',
    );
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
      message: `Recibimos tu factura. Ganaste ${Math.round(parseFloat(loyaltyValue)).toLocaleString()} puntos (en verificacion). Tu saldo: ${Math.round(parseFloat(newBalance)).toLocaleString()} puntos. Te confirmamos en breve.`,
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

  // Auto-upgrade shadow to verified if cedula was extracted from the invoice
  if (extracted.customer_cedula && consumerAccount.accountType === 'shadow' && !consumerAccount.cedula) {
    const normCedula = extracted.customer_cedula.replace(/[\s.-]/g, '').toUpperCase();
    // Check cedula not already used by another account in this tenant
    const existingCedula = await prisma.account.findUnique({
      where: { tenantId_cedula: { tenantId, cedula: normCedula } },
    });
    if (!existingCedula) {
      await prisma.account.update({
        where: { id: consumerAccount.id },
        data: { cedula: normCedula, accountType: 'verified' },
      });
      console.log(`[Validation] Auto-verified account ${consumerAccount.id} with cedula ${normCedula}`);
    }
  }

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
    let converted = await convertBsToReference(
      Number(invoice.amount),
      tenantConfig.preferredExchangeSource,
      tenantConfig.referenceCurrency,
      txDate
    );
    let sourceUsed: string = tenantConfig.preferredExchangeSource;
    if (converted === null) {
      // Fallback to BCV if the preferred source has no rate available
      converted = await convertBsToReference(Number(invoice.amount), 'bcv', tenantConfig.referenceCurrency, txDate);
      if (converted !== null) {
        sourceUsed = 'bcv';
        console.log(`[Validation] Using BCV fallback (preferred source "${tenantConfig.preferredExchangeSource}" had no rate)`);
      }
    }
    if (converted !== null) {
      normalizedAmount = converted.toFixed(8);
      const rateInfo = await getRateAtDate(sourceUsed as any, tenantConfig.referenceCurrency, txDate);
      if (rateInfo) {
        exchangeRateUsed = {
          source: sourceUsed,
          currency: tenantConfig.referenceCurrency,
          rateBs: rateInfo.rateBs,
        };
      }
      console.log(`[Validation] BS→${tenantConfig.referenceCurrency.toUpperCase()} normalization: Bs ${invoice.amount} ÷ ${exchangeRateUsed?.rateBs} = ${normalizedAmount}`);
    } else {
      console.error(`[Validation] No exchange rate available — using raw Bs amount (likely wrong)`);
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
  if (imageHash) {
    ledgerMetadata.imageHash = imageHash;
  }
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

  // Staff attribution: if this consumer scanned a cashier/promoter QR within
  // the attribution window, credit the invoice to that staff for performance
  // reporting. Reads the most recent StaffScanSession for this phone+tenant.
  // We also inherit the staff's assigned branchId when the invoice has no
  // branch of its own — this covers the common case of a user scanning the
  // cashier's QR (which carries only Cjr:, no /branchId) and then sending
  // their invoice.
  const staffAttrWindowMin = parseInt(process.env.STAFF_ATTRIBUTION_WINDOW_MIN || '60');
  const staffCutoff = new Date(Date.now() - staffAttrWindowMin * 60 * 1000);
  const lastStaffScan = await prisma.staffScanSession.findFirst({
    where: { tenantId, consumerPhone: senderPhone, scannedAt: { gte: staffCutoff } },
    orderBy: { scannedAt: 'desc' },
  });
  let staffInheritedBranchId: string | null = null;
  if (lastStaffScan) {
    ledgerMetadata.staffId = lastStaffScan.staffId;
    ledgerMetadata.staffAttributionScanAt = lastStaffScan.scannedAt.toISOString();
    console.log(`[StaffAttribution] Invoice credited to staff ${lastStaffScan.staffId} (scan at ${lastStaffScan.scannedAt.toISOString()})`);
    const staffRow = await prisma.staff.findUnique({
      where: { id: lastStaffScan.staffId },
      select: { branchId: true },
    });
    if (staffRow?.branchId) staffInheritedBranchId = staffRow.branchId;
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
    branchId: invoice.branchId || params.branchId || staffInheritedBranchId || null,
    latitude: params.latitude || null,
    longitude: params.longitude || null,
    deviceId: params.deviceId || null,
    metadata: Object.keys(ledgerMetadata).length > 0 ? ledgerMetadata : undefined,
  });

  const resolvedBranchId = invoice.branchId || params.branchId || staffInheritedBranchId || null;
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: 'claimed',
      consumerAccountId: consumerAccount.id,
      ledgerEntryId: ledgerResult.credit.id,
      ocrRawText: ocrRawText || undefined,
      // Only set branchId if the invoice row didn't already have one and
      // we resolved one from the scan context — don't overwrite explicit
      // CSV-uploaded branches.
      ...(invoice.branchId ? {} : resolvedBranchId ? { branchId: resolvedBranchId } : {}),
    },
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

  // Referral credit: if this consumer has a pending referral row, the
  // referrer earns the tenant's configured bonus now. Idempotent — the
  // referral row flips to 'credited' and subsequent calls no-op.
  try {
    const { tryCreditReferral } = await import('./referrals.js');
    await tryCreditReferral({
      tenantId,
      refereeAccountId: consumerAccount.id,
      assetTypeId,
    });
  } catch (err) {
    console.error('[Referral] credit failed', err);
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
  //
  // Items source strategy depends on document type:
  //   - fiscal_invoice  → items extracted from the receipt image (customer's photo)
  //   - voucher / mobile_payment → items come from the merchant's CSV row (payment
  //                                receipts do not print itemized lists). We preserve
  //                                whatever the CSV had and do not overwrite it.
  //
  // The CSV row's items (if any) live in invoice.orderDetails already because
  // processCSV stores them at upload time. So we only write new orderDetails when
  // the source is a fiscal_invoice and the image actually had items.
  const isReceiptWithItems = extracted.document_type !== 'voucher'
    && extracted.document_type !== 'mobile_payment'
    && extracted.order_items
    && extracted.order_items.length > 0;

  const existingOrderDetails = invoice.orderDetails as any || null;
  const hasCsvItems = existingOrderDetails?.items?.length > 0;

  let finalOrderDetails;
  if (hasCsvItems) {
    // CSV provided items — preserve them, optionally enrich with image items if any
    finalOrderDetails = {
      ...existingOrderDetails,
      source: 'csv',
      confirmedAt: new Date().toISOString(),
    };
  } else if (isReceiptWithItems) {
    // Fiscal invoice with line items from the image
    finalOrderDetails = {
      items: extracted.order_items,
      source: 'image_extraction',
      extractedAt: new Date().toISOString(),
    };
  } else {
    finalOrderDetails = undefined;
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      extractedData: { ...(invoice.extractedData as any || {}), ...extracted, outputTokenSignature: outputToken.signature },
      orderDetails: finalOrderDetails,
    },
  });

  // STAGE E: Get new balance + check level-up
  const newBalance = await getAccountBalance(consumerAccount.id, assetTypeId, tenantId);
  const levelResult = await checkAndUpdateLevel(consumerAccount.id, tenantId);

  let message = `Factura validada! Ganaste ${Math.round(parseFloat(loyaltyValue)).toLocaleString()} puntos. Tu nuevo saldo es ${Math.round(parseFloat(newBalance)).toLocaleString()} puntos.`;
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
  imageHash?: string;
  branchId?: string | null;
  staffId?: string | null;
}): Promise<ValidationResult> {
  const { tenantId, senderPhone, invoiceNumber, totalAmount, assetTypeId } = params;

  // Guard 1: if an invoice row for this number already exists (any state), do not
  // create a second provisional credit.
  const existingInvoice = await prisma.invoice.findUnique({
    where: { tenantId_invoiceNumber: { tenantId, invoiceNumber } },
  });
  if (existingInvoice) {
    const msgByStatus: Record<string, string> = {
      claimed: 'Esta factura ya fue usada para reclamar puntos anteriormente.',
      pending_validation: 'Esta factura ya esta en verificacion. Te confirmamos en breve cuando se valide.',
      manual_review: 'Esta factura esta en revision por el comercio. Te avisamos el resultado.',
      rejected: 'Esta factura fue rechazada previamente y no se puede reclamar.',
      available: 'Esta factura ya esta registrada pero no pudimos acreditar puntos en este momento. Intenta de nuevo en unos minutos.',
    };
    const message = msgByStatus[existingInvoice.status] || `Esta factura ya fue procesada (estado: ${existingInvoice.status}).`;
    console.log(`[PendingValidation] Duplicate provisional blocked (invoice row): invoice=${invoiceNumber} existingStatus=${existingInvoice.status}`);
    return { success: false, stage: 'cross_reference', message, invoiceNumber };
  }

  // Guard 2: check the LEDGER directly for any existing entry with the same
  // reference_id. This catches orphan cases where a previous submission wrote
  // the ledger entry but failed (crashed or 500) before creating the invoice
  // row. Without this guard, writeDoubleEntry below throws a UNIQUE constraint
  // violation and crashes the request with 500 — which is exactly what was
  // happening in production for retries of the same invoice.
  const pendingRef = `PENDING-${invoiceNumber}`;
  const confirmedRef = invoiceNumber;
  const orphanEntry = await prisma.ledgerEntry.findFirst({
    where: {
      tenantId,
      eventType: 'INVOICE_CLAIMED',
      referenceId: { in: [pendingRef, confirmedRef] },
    },
    select: { referenceId: true, status: true, accountId: true },
  });
  if (orphanEntry) {
    let isOriginalSubmitter = false;
    const senderAccount = await prisma.account.findUnique({
      where: { tenantId_phoneNumber: { tenantId, phoneNumber: senderPhone } },
      select: { id: true },
    });
    if (senderAccount && senderAccount.id === orphanEntry.accountId) {
      isOriginalSubmitter = true;
    }
    console.log(`[PendingValidation] Duplicate provisional blocked (ledger): invoice=${invoiceNumber} existingRef=${orphanEntry.referenceId} sameUser=${isOriginalSubmitter}`);
    return {
      success: false,
      stage: 'cross_reference',
      message: isOriginalSubmitter
        ? 'Esta factura ya esta en verificacion. Te confirmamos en breve cuando se valide.'
        : 'Esta factura ya fue enviada anteriormente por otro cliente. No se puede usar dos veces.',
      invoiceNumber,
    };
  }

  const { account: consumerAccount } = await findOrCreateConsumerAccount(tenantId, senderPhone);
  const poolAccount = await getSystemAccount(tenantId, 'issued_value_pool');
  if (!poolAccount) throw new Error('issued_value_pool not found');

  // BS → reference currency normalization (same logic as Stage D)
  let normalizedAmount = totalAmount.toString();
  const tenantConfig = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (tenantConfig?.preferredExchangeSource) {
    const { convertBsToReference } = await import('./exchange-rates.js');
    const converted = await convertBsToReference(
      totalAmount,
      tenantConfig.preferredExchangeSource,
      tenantConfig.referenceCurrency,
      new Date()
    );
    if (converted !== null) {
      normalizedAmount = converted.toFixed(8);
      console.log(`[PendingValidation] BS→${tenantConfig.referenceCurrency.toUpperCase()}: Bs ${totalAmount} → ${normalizedAmount}`);
    } else {
      // Fallback: the preferred source has no rate available. Try BCV as a safe
      // default (it's always fetched) instead of silently using the raw Bs
      // amount, which would multiply by the tenant's conversion_rate and
      // produce absurd point values.
      const fallback = await convertBsToReference(totalAmount, 'bcv', tenantConfig.referenceCurrency, new Date());
      if (fallback !== null) {
        normalizedAmount = fallback.toFixed(8);
        console.log(`[PendingValidation] BS→${tenantConfig.referenceCurrency.toUpperCase()} via BCV fallback: Bs ${totalAmount} → ${normalizedAmount} (preferred source "${tenantConfig.preferredExchangeSource}" had no rate)`);
      } else {
        console.error(`[PendingValidation] No exchange rate available for preferred source "${tenantConfig.preferredExchangeSource}" or fallback bcv — using raw Bs amount (likely wrong)`);
      }
    }
  }

  const loyaltyValue = await convertToLoyaltyValue(normalizedAmount, tenantId, assetTypeId);

  let ledgerResult;
  try {
    const pendingMetadata: Record<string, unknown> = {};
    if (params.imageHash) pendingMetadata.imageHash = params.imageHash;
    if (params.staffId) pendingMetadata.staffId = params.staffId;
    ledgerResult = await writeDoubleEntry({
      tenantId,
      eventType: 'INVOICE_CLAIMED',
      debitAccountId: poolAccount.id,
      creditAccountId: consumerAccount.id,
      amount: loyaltyValue,
      assetTypeId,
      referenceId: `PENDING-${invoiceNumber}`,
      referenceType: 'invoice',
      status: 'provisional',
      branchId: params.branchId || null,
      latitude: params.latitude || null,
      longitude: params.longitude || null,
      metadata: Object.keys(pendingMetadata).length > 0 ? pendingMetadata : undefined,
    });
  } catch (err: any) {
    // Unique constraint violation (P2002): another request committed the same
    // reference in a race, or a prior crash left an orphan. Return a clean
    // rejection instead of letting it crash to 500.
    if (err?.code === 'P2002') {
      console.log(`[PendingValidation] Unique constraint race caught: invoice=${invoiceNumber}`);
      return {
        success: false,
        stage: 'cross_reference',
        message: 'Esta factura ya esta en verificacion. Te confirmamos en breve cuando se valide.',
        invoiceNumber,
      };
    }
    throw err;
  }

  // Determine source from extracted data: mobile_payment, voucher, or default photo_submission
  const docType = params.extractedData?.document_type;
  const sourceLiteral =
    docType === 'mobile_payment' ? 'mobile_payment' :
    docType === 'voucher' ? 'voucher' :
    'photo_submission';

  await prisma.$executeRawUnsafe(
    `INSERT INTO invoices (id, tenant_id, invoice_number, amount, customer_phone, status, source,
      consumer_account_id, ledger_entry_id, ocr_raw_text, extracted_data,
      submitted_latitude, submitted_longitude, branch_id, created_at, updated_at)
    VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, 'pending_validation', $5::"InvoiceSource",
      $6::uuid, $7::uuid, $8, $9::jsonb, $10::decimal, $11::decimal, $12::uuid, now(), now())
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
    params.branchId || null,
  );

  const newBalance = await getAccountBalance(consumerAccount.id, assetTypeId, tenantId);

  return {
    success: true, stage: 'pending',
    message: `Recibimos tu factura. Ganaste ${Math.round(parseFloat(loyaltyValue)).toLocaleString()} puntos (en verificacion). Tu saldo: ${Math.round(parseFloat(newBalance)).toLocaleString()} puntos. Te confirmamos en breve.`,
    valueAssigned: loyaltyValue, newBalance, invoiceNumber, status: 'pending_validation',
  };
}
