/**
 * OCR via Google Cloud Vision API + AI extraction via Anthropic Claude.
 * All API keys from .env — never hardcoded.
 */

import type { ExtractedInvoiceData } from './invoice-validation.js';

/**
 * Stage A: Send image to Google Cloud Vision API → extract raw text.
 */
export async function ocrExtractText(imageBase64: string): Promise<string | null> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    console.log('[OCR] GOOGLE_VISION_API_KEY not configured — skipping OCR');
    return null;
  }

  try {
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: imageBase64 },
            features: [{ type: 'TEXT_DETECTION' }],
          }],
        }),
      }
    );

    if (!res.ok) {
      console.error('[OCR] Vision API error:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const text = data.responses?.[0]?.fullTextAnnotation?.text || null;
    return text;
  } catch (err) {
    console.error('[OCR] Vision API call failed:', err);
    return null;
  }
}

/**
 * Best-effort parser for Claude's JSON responses. Handles:
 * - Markdown code fences (```json ... ```)
 * - Leading/trailing prose
 * - Trailing commas before ] or }
 * - Missing commas between array objects (most common cause of SyntaxError
 *   "Expected ',' or ']' after array element")
 */
function parseClaudeJson(raw: string): any | null {
  if (!raw) return null;

  // 1. Strip markdown code fences if present.
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1].trim();

  // 2. Extract the outermost balanced object.
  const firstBrace = text.indexOf('{');
  if (firstBrace < 0) return null;
  let depth = 0;
  let endIdx = -1;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx < 0) return null;
  const candidate = text.slice(firstBrace, endIdx + 1);

  // 3. First try as-is.
  try { return JSON.parse(candidate); } catch {}

  // 4. Strip trailing commas before ] or }.
  const noTrailingCommas = candidate.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(noTrailingCommas); } catch {}

  // 5. Add missing commas between adjacent array objects: `} {` → `}, {`.
  const withCommas = noTrailingCommas.replace(/}(\s*){/g, '},$1{');
  try { return JSON.parse(withCommas); } catch {}

  return null;
}

/**
 * Post-processing: fix common Google Vision OCR character confusions.
 *
 * Google Vision frequently confuses visually similar characters on Venezuelan
 * thermal receipts:
 *   0 ↔ 8  (the slashed zero on fiscal printers looks like 8)
 *   S ↔ 5  (curvy S vs angular 5)
 *   O ↔ 0  (letter O vs digit zero)
 *   l ↔ 1  (lowercase L vs one)
 *   I ↔ 1  (uppercase I vs one)
 *   B ↔ 8  (letter B vs eight)
 *
 * Rather than trying to fix these in the prompt (Claude extracts what Vision
 * gives it), we post-process the extracted fields using structural knowledge:
 *   - RIF format: J/V/E/G/P + dash + 8-9 digits + optional check digit
 *   - Phone numbers: 04XX-XXXXXXX pattern
 *   - Cedula: V/E + digits
 *   - Invoice numbers: cross-reference against the raw OCR text to find the
 *     best matching candidate
 */
function postProcessOcrFields(data: ExtractedInvoiceData, ocrText: string): ExtractedInvoiceData {
  // --- RIF normalization ---
  // Venezuelan RIF format: [JVEGP]-XXXXXXXX-X (letter, dash, 7-9 digits, dash, check digit)
  // Google Vision garbles digits (0↔8, S↔5) but the RIF is printed on every
  // fiscal receipt and also appears in the raw OCR. Find the best RIF candidate
  // from the raw text and use it instead of Claude's interpretation.
  if (ocrText && data.merchant_rif) {
    // Look for RIF patterns in raw OCR: J-XXXXXXXX, J XXXXXXXX, JXXXXXXXX
    const rifCandidates = ocrText.match(/[JVEGP][\s\-]?\d[\d\s\-]{6,12}/gi) || [];
    if (rifCandidates.length > 0) {
      // Normalize all candidates: strip spaces/dashes, keep letter + digits
      const normalized = rifCandidates.map(r => {
        const clean = r.replace(/[\s]/g, '');
        // Re-insert dashes in standard format: X-XXXXXXXX-X
        const letter = clean[0].toUpperCase();
        const rest = clean.slice(1).replace(/-/g, '');
        if (rest.length >= 8) {
          const body = rest.slice(0, rest.length - 1);
          const check = rest.slice(-1);
          return `${letter}-${body}-${check}`;
        }
        return `${letter}-${rest}`;
      });
      // Pick the first one that starts with J (company RIF) for merchant
      const companyRif = normalized.find(r => r.startsWith('J')) || normalized[0];
      if (companyRif && companyRif !== data.merchant_rif) {
        console.log(`[OCR-PostProcess] RIF corrected: "${data.merchant_rif}" → "${companyRif}"`);
        data.merchant_rif = companyRif;
      }
    }
  }

  // --- Cedula normalization ---
  // Format: V-XXXXXXXX or E-XXXXXXXX. Extract from raw OCR if available.
  if (ocrText && data.customer_cedula) {
    // Look for CI/cedula patterns: V12345678, V-12345678, V 12345678
    const ciMatches = ocrText.match(/(?:RIF\/C\.?\s*I\.?:|CI:|C\.I\.:|Cedula:)\s*([VE][\s\-]?\d{5,10})/gi) || [];
    if (ciMatches.length > 0 && ciMatches[0]) {
      const raw = ciMatches[0].replace(/^.*?([VE])/i, '$1');
      const clean = raw.replace(/[\s\-]/g, '').toUpperCase();
      if (clean !== data.customer_cedula.replace(/[\s\-]/g, '').toUpperCase()) {
        console.log(`[OCR-PostProcess] Cedula corrected: "${data.customer_cedula}" → "${clean}"`);
        data.customer_cedula = clean;
      }
    }
  }

  // --- Phone normalization ---
  // Venezuelan phones: 04XX-XXXXXXX. Fix common l→1, O→0 confusions.
  if (data.customer_phone) {
    data.customer_phone = data.customer_phone
      .replace(/[Oo]/g, '0')
      .replace(/[lI]/g, '1')
      .replace(/[Ss]/g, '5');
  }

  // --- Invoice number: try to match against raw OCR text ---
  // If the extracted invoice_number has OCR garbling, find the closest match
  // in the raw text.
  if (ocrText && data.invoice_number) {
    const invNum = data.invoice_number;
    // Only attempt correction if invoice_number is purely numeric
    if (/^\d+$/.test(invNum) && invNum.length >= 5) {
      // Search raw OCR for all standalone numbers of similar length
      const allNumbers = ocrText.match(/\b\d{5,}\b/g) || [];
      // Find the raw OCR number that best matches (fewest char differences)
      let bestMatch = invNum;
      let bestDist = 0;
      for (const candidate of allNumbers) {
        if (candidate.length !== invNum.length) continue;
        let matches = 0;
        for (let i = 0; i < candidate.length; i++) {
          if (candidate[i] === invNum[i]) matches++;
        }
        if (matches > bestDist) {
          bestDist = matches;
          bestMatch = candidate;
        }
      }
      if (bestMatch !== invNum && bestDist >= invNum.length - 2) {
        console.log(`[OCR-PostProcess] Invoice number corrected: "${invNum}" → "${bestMatch}" (${bestDist}/${invNum.length} chars match)`);
        data.invoice_number = bestMatch;
      }
    }
  }

  return data;
}

/**
 * Shared extraction prompt used by both the text-based (Haiku) and multimodal
 * (vision) paths. The intro differs but the rules and output schema are the same.
 */
const EXTRACTION_RULES = `CRITICAL RULES:
1. NEVER invent, guess, or hallucinate values. If a field is not clearly visible, return null for that field.
   IMPORTANT: "SENIAT" is the Venezuelan tax authority (Servicio Nacional Integrado de Administracion Aduanera y Tributaria). It appears at the top of ALL Venezuelan fiscal receipts as a regulatory header. It is NEVER the merchant name. The actual merchant/business name appears BELOW "SENIAT", usually on the next line (e.g. "FARMATODO, C.A.", "EL CHAKAL, C.A.", "TODO BOMBILLO C.A.").
2. The invoice_number is the FISCAL INVOICE NUMBER — the official document number assigned by the fiscal printer or tax system. Follow this priority:
   PRIORITY ORDER for invoice_number:
   1. Look for a standalone number (5+ digits, on its own line or clearly separate, NOT followed by a product name) that appears AFTER "FACTURA:" and near "FECHA:" or "HORA:". This is the fiscal invoice number.
   2. If no standalone number found after FACTURA:, check labeled fields: "Recibo de Pago:", "Factura Nro.", "Nro. Factura", etc.
   3. "Ticket:" and "ID de orden:" are NOT the fiscal invoice number — they are internal POS identifiers. Do NOT use them.
   FORBIDDEN — NEVER use these as invoice_number:
   - "Numero:" — this is ALWAYS the fiscal printer serial or machine ID. NEVER use it.
   - "Ticket:", "ID de orden:" — internal POS identifiers, not fiscal numbers.
   - "Tienda:" — store number.
   - "RIF:", "CI:", "V-", "J-", "E-", "G-", "P-" numbers (tax/identity IDs).
   - "HORA:", "FECHA:" values.
   - "No. Autor.", "Lote", "Terminal", "CAJA", "Cajera" numbers.
   - "MH", "ZZP", "Z1F" followed by digits — fiscal machine serials.
   - Product barcodes/SKUs: a number immediately followed by a product description on the same line.
   - Phone numbers, cashier IDs, batch numbers, authorization codes.
   - "Tlf:", "Tel:" numbers.
3. The total_amount must be the BOLIVARES amount when both Bs and USD/foreign amounts are shown. Only use USD/EUR/other when the document is EXCLUSIVELY in that currency (Zelle, Binance P2P).
4. For mobile_payment screenshots: invoice_number = bank reference number. bank_name = issuing bank. "Cedula Destino" is NOT a merchant RIF.
5. For crypto payments (Binance P2P): total_amount = crypto amount (e.g. 50 USDT). Currency = "USD".
6. For voucher documents: invoice_number can be null.
7. Set confidence_score: 0.0-0.3 if blurry/missing fields; 0.4-0.7 if some unclear; 0.8-1.0 if everything clear.

Return ONLY a JSON object with these exact fields:
- document_type: one of "fiscal_invoice", "mobile_payment", "voucher" (string)
- invoice_number: the FISCAL invoice number as shown (string or null). NOT Ticket or ID de orden.
- total_amount: final total in document's currency (number or null)
- transaction_date: date in ISO format YYYY-MM-DD (string or null)
- transaction_time: time if visible, e.g. "14:30" (string or null)
- customer_phone: the customer/buyer phone number. On Venezuelan receipts, look for "Tlf:" or "Tel:" that appears in the CUSTOMER section (near "RIF/CI:", "RAZON SOCIAL:", "Nombre:", "Cliente:"). This is the customer's phone, not the store's. Do NOT return the store's 0800 number or the phone in the merchant header. Return in format 04XX-XXXXXXX if visible. (string or null)
- customer_cedula: customer's Venezuelan ID (cedula). Look for "RIF/C.I.:", "CI:", "Cedula:" labels. Starts with V or E + digits. NOT the merchant's RIF (J-). (string or null)
- customer_name: customer name if labeled ("RAZON SOCIAL:", "Cliente:", "Nombre:"). (string or null)
- merchant_name: business name (string or null)
- merchant_rif: Venezuelan tax ID. Format: J/V/E/G/P + dash + digits, e.g. "J-30058671-2". (string or null)
- currency: "BS" for Bolivares, "USD", "EUR", "COP", etc. (string or null)
- bank_name: bank that processed payment (string or null, mobile_payment only)
- payment_reference: bank reference number (string or null, mobile_payment only)
- order_items: array of { name: string, quantity: number, unit_price: number } for line items. (array or null)
- confidence_score: 0.0 to 1.0 (number)`;

const EXTRACTION_PROMPT = `You are extracting data from a Latin American sales document image.
The image may be rotated, upside down, or at an angle — read the text in whatever orientation it appears.
The document may be one of three types:
- "fiscal_invoice": a traditional sales receipt (FACTURA DE VENTA, with invoice number, items, RIF, etc.)
- "mobile_payment": a screenshot of a mobile bank payment confirmation (Pago Movil, transferencia bancaria)
- "voucher": a small printed voucher with just the amount and date

IMPORTANT VISUAL RULES:
- The merchant RIF is in the HEADER of the receipt near "SENIAT" and the merchant name. It starts with J- followed by 8-9 digits. Do NOT confuse it with other RIFs on the receipt.
- The invoice number appears AFTER "FACTURA:" label, near "FECHA:" and "HORA:". It is NOT the barcode number at the bottom. It is NOT the "Ticket:" or "ID de orden:" number.
- Barcodes at the bottom of receipts are NOT invoice numbers. They are long strings of digits/letters often near "MH", "ZZP", "Z1F", or printed as actual barcode graphics.
- Numbers on item lines (followed by product descriptions) are product SKUs/barcodes, NOT the invoice number.

${EXTRACTION_RULES}

Return ONLY the JSON object, no explanations.`;

/**
 * Stage A (part 2): Send raw OCR text to Claude API → extract structured fields.
 * Legacy path — used when MULTIMODAL_MODEL=disabled.
 */
export async function aiExtractInvoiceFields(ocrText: string): Promise<ExtractedInvoiceData> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[AI] ANTHROPIC_API_KEY not configured — returning low-confidence result');
    return {
      invoice_number: null, total_amount: null, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0,
    };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        // temperature=0 → deterministic output. Same OCR text ⇒ same extraction,
        // so duplicate submissions produce the same invoice_number and can be
        // caught by the UNIQUE(tenant, reference) constraint and status check.
        temperature: 0,
        messages: [{
          role: 'user',
          content: `You are extracting data from a Latin American sales document. The text below is the raw OCR output.

${EXTRACTION_RULES}

OCR text:
---
${ocrText}
---

Return ONLY the JSON object, no explanations.`,
        }],
      }),
    });

    if (!res.ok) {
      console.error('[AI] Claude API error:', res.status, await res.text());
      return {
        invoice_number: null, total_amount: null, transaction_date: null,
        customer_phone: null, merchant_name: null, confidence_score: 0,
      };
    }

    const data = await res.json();
    const content = data.content?.[0]?.text || '';

    // Parse the JSON response. Claude sometimes wraps it in ```json fences or
    // emits trailing commas / missing commas in arrays. Be defensive.
    const parsed = parseClaudeJson(content);
    if (!parsed) {
      console.error('[AI] Could not parse JSON from Claude response. Raw content:', content.slice(0, 800));
      return {
        invoice_number: null, total_amount: null, transaction_date: null,
        customer_phone: null, merchant_name: null, confidence_score: 0,
      };
    }
    const raw = {
      invoice_number: parsed.invoice_number || null,
      total_amount: parsed.total_amount != null ? Number(parsed.total_amount) : null,
      transaction_date: parsed.transaction_date || null,
      transaction_time: parsed.transaction_time || null,
      customer_phone: parsed.customer_phone || null,
      customer_cedula: parsed.customer_cedula || null,
      customer_name: parsed.customer_name || null,
      merchant_name: parsed.merchant_name || null,
      merchant_rif: parsed.merchant_rif || null,
      currency: parsed.currency ? String(parsed.currency).toUpperCase() : null,
      order_items: parsed.order_items || null,
      confidence_score: parsed.confidence_score != null ? Number(parsed.confidence_score) : 0,
      document_type: parsed.document_type || null,
      bank_name: parsed.bank_name || null,
      payment_reference: parsed.payment_reference || null,
    };
    return postProcessOcrFields(raw, ocrText);
  } catch (err) {
    console.error('[AI] Claude API call failed:', err);
    return {
      invoice_number: null, total_amount: null, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0,
    };
  }
}

/**
 * Claude Multimodal: send the image directly to Claude's vision model.
 * No Google Vision OCR step — Claude reads the receipt image visually,
 * eliminating character confusion (0↔8, S↔5) and line-order issues.
 */
function detectMediaType(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('R0lG')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg'; // default for WhatsApp
}

export async function multimodalExtract(imageBase64: string): Promise<ExtractedInvoiceData> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[Multimodal] ANTHROPIC_API_KEY not configured');
    return {
      invoice_number: null, total_amount: null, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0,
    };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.MULTIMODAL_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1500,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: detectMediaType(imageBase64),
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: EXTRACTION_PROMPT,
            },
          ],
        }],
      }),
    });

    if (!res.ok) {
      console.error('[Multimodal] Claude API error:', res.status, await res.text());
      return {
        invoice_number: null, total_amount: null, transaction_date: null,
        customer_phone: null, merchant_name: null, confidence_score: 0,
      };
    }

    const data = await res.json();
    const content = data.content?.[0]?.text || '';
    const parsed = parseClaudeJson(content);
    if (!parsed) {
      console.error('[Multimodal] Could not parse JSON. Raw:', content.slice(0, 800));
      return {
        invoice_number: null, total_amount: null, transaction_date: null,
        customer_phone: null, merchant_name: null, confidence_score: 0,
      };
    }

    console.log('[Multimodal] Extracted:', JSON.stringify({
      invoice_number: parsed.invoice_number,
      total_amount: parsed.total_amount,
      merchant_rif: parsed.merchant_rif,
      customer_cedula: parsed.customer_cedula,
      confidence_score: parsed.confidence_score,
    }));

    return {
      invoice_number: parsed.invoice_number || null,
      total_amount: parsed.total_amount != null ? Number(parsed.total_amount) : null,
      transaction_date: parsed.transaction_date || null,
      transaction_time: parsed.transaction_time || null,
      customer_phone: parsed.customer_phone || null,
      customer_cedula: parsed.customer_cedula || null,
      customer_name: parsed.customer_name || null,
      merchant_name: parsed.merchant_name || null,
      merchant_rif: parsed.merchant_rif || null,
      currency: parsed.currency ? String(parsed.currency).toUpperCase() : null,
      order_items: parsed.order_items || null,
      confidence_score: parsed.confidence_score != null ? Number(parsed.confidence_score) : 0,
      document_type: parsed.document_type || null,
      bank_name: parsed.bank_name || null,
      payment_reference: parsed.payment_reference || null,
    };
  } catch (err) {
    console.error('[Multimodal] Claude API call failed:', err);
    return {
      invoice_number: null, total_amount: null, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0,
    };
  }
}

/**
 * Full Stage A: image buffer → structured data.
 *
 * Uses Claude Multimodal (vision) by default — sends the image directly to
 * Claude, which reads the receipt visually. No Google Vision OCR step, so no
 * character confusion (0↔8, S↔5) or line-order garbling.
 *
 * Falls back to Google Vision + Claude Haiku text extraction if the
 * MULTIMODAL_MODEL env var is set to "disabled".
 */
export async function extractFromImage(imageBuffer: Buffer): Promise<{
  extractedData: ExtractedInvoiceData;
  ocrRawText: string | null;
}> {
  const imageBase64 = imageBuffer.toString('base64');
  const useMultimodal = (process.env.MULTIMODAL_MODEL || '') !== 'disabled';

  if (useMultimodal) {
    console.log('[OCR] Using Claude Multimodal (vision) — skipping Google Vision');
    const extractedData = await multimodalExtract(imageBase64);

    // Still run Google Vision in parallel to get raw text for Jaccard dedup
    const ocrRawText = await ocrExtractText(imageBase64);
    if (ocrRawText) {
      console.log('[OCR] Vision text for dedup (first 300 chars):', ocrRawText.slice(0, 300).replace(/\n/g, ' | '));
    }

    return { extractedData, ocrRawText };
  }

  // Legacy path: Google Vision OCR → Claude Haiku text extraction
  console.log('[OCR] Using legacy Google Vision + Claude Haiku text path');
  const ocrRawText = await ocrExtractText(imageBase64);
  if (ocrRawText) {
    console.log('[OCR] Vision extracted text (first 500 chars):', ocrRawText.slice(0, 500).replace(/\n/g, ' | '));
  }

  if (!ocrRawText) {
    return {
      ocrRawText: null,
      extractedData: {
        invoice_number: null, total_amount: null, transaction_date: null,
        customer_phone: null, merchant_name: null, confidence_score: 0,
      },
    };
  }

  const extractedData = await aiExtractInvoiceFields(ocrRawText);
  return { ocrRawText, extractedData };
}
