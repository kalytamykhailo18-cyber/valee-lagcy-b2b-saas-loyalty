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
 * Stage A (part 2): Send raw OCR text to Claude API → extract structured fields.
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
The document may be one of three types:
- "fiscal_invoice": a traditional sales receipt (FACTURA DE VENTA, with invoice number, items, RIF, etc.)
- "mobile_payment": a screenshot of a mobile bank payment confirmation (Pago Móvil, transferencia bancaria, with bank name, reference number, amount, beneficiary)
- "voucher": a small printed voucher with just the amount and date, no items

CRITICAL RULES:
1. NEVER invent, guess, or hallucinate values. If a field is not clearly visible in the OCR text, return null for that field.
2. The invoice_number is the unique identifier for this specific receipt. Follow this priority:
   PREFERRED LABELS (pick the value immediately after any of these, even if OCR garbled the label slightly):
   - "FACTURA:", "FACTURA N°", "FACTURA No.", "FACTURA #", "Factura Nro.", "Nro. Factura", "N. Factura", "Num. Factura"
   - "Control:", "N° Control:", "Nro Control" (Venezuelan fiscal control number)
   - OCR often garbles these labels. Accept close variants: "FACT.", "FCT:", "FACTU", "F. CTURA", "Cont:", etc.
   FORBIDDEN — NEVER use these as invoice_number:
   - "Numero:" — this is ALWAYS the fiscal printer serial or machine ID on Venezuelan receipts. It appears in the header ABOVE the "FACTURA:" label. NEVER use it as the invoice number, even if no other number is found.
   - "RIF:", "CI:", "V-", "J-", "E-", "G-", "P-" numbers (tax IDs).
   - "HORA:", "FECHA:" values.
   - "No. Autor.", "Lote", "Terminal", "CAJA", "Cajera", "Ticket" numbers.
   - "MH ZZP########" at the bottom of the receipt (fiscal printer serial).
   - "ZZP" followed by digits — this is the fiscal machine serial.
   - Line numbers at the start of each item ("1x", "2x", "3x", "1,00 UND").
   - Phone numbers, cashier IDs, batch numbers, authorization codes.
   - "RIF/CI:" numbers — these are tax/identity IDs, not invoice numbers.
   - "Tlf:" or "Tel:" numbers — these are phone numbers, not invoice numbers.
   IMPORTANT LAYOUT PATTERN: On Venezuelan thermal receipts, the structure is typically:
     [HEADER: merchant name, RIF, address]
     Numero: XXXXXXX        ← MACHINE SERIAL (forbidden!)
     FACTURA / FACTURA:
     FECHA: DD-MM-YYYY
     XXXXXXXX               ← THIS is the invoice number (after FACTURA: and near FECHA:)
   The actual invoice number is the number that appears AFTER the "FACTURA:" label, often on its own line near the date. It is NOT the "Numero:" value.
   FALLBACK (when no preferred label is found):
   - If the document is clearly a fiscal_invoice (has merchant name, items, total) but no labeled invoice number, look for a standalone number (5+ digits) that appears AFTER "FACTURA" or "FACTURA:" in the text. Do NOT pick the "Numero:" value.
   - Only return null if there are no valid candidates at all.
3. The total_amount must be the BOLIVARES amount when both Bs and USD/foreign amounts are shown on the same document. Venezuelan receipts commonly show a USD equivalent or a BCV exchange rate — always pick the Bs line as total_amount and set currency to "BS". Only use USD/EUR/other as total_amount when the document is EXCLUSIVELY in that currency (e.g. a Zelle screenshot in English with only dollar amounts, or a Binance P2P where the amount is stated in USDT/USD).
4. For mobile_payment screenshots: invoice_number must be set to the bank reference number (the unique identifier the bank assigns to the transaction). bank_name must be the bank that processed the payment (Banesco, BDV, Mercantil, BBVA Provincial, Banco Plaza, Banco del Tesoro, etc.). payment_reference is the same as the bank reference. IMPORTANT: for Pago Movil, the "Cedula Destino" (e.g. V-12345678) is the recipient's personal ID, NOT a merchant RIF — do NOT put it in merchant_rif. Only set merchant_rif if you see an actual business tax ID (J-XXXXXXXX format, starts with J for companies).
5. For crypto payment screenshots (Binance P2P, etc.): the total_amount is the crypto amount (e.g. 50 USDT), NOT the fiat equivalent. Set currency to "USD" for USDT payments. The order number is the invoice_number.
6. For voucher documents: invoice_number can be null if no number is printed. The system will generate a synthetic reference.
7. Set confidence_score to 0.0-0.3 if the text is blurry or fields are missing; 0.4-0.7 if some fields are unclear; 0.8-1.0 only if everything is clearly readable.

Return ONLY a JSON object with these exact fields:
- document_type: one of "fiscal_invoice", "mobile_payment", "voucher" (string)
- invoice_number: exact identifier as shown (string or null). For mobile_payment, use the bank reference number.
- total_amount: final total in document's currency (number or null)
- transaction_date: date in ISO format YYYY-MM-DD (string or null)
- transaction_time: time if visible, e.g. "14:30" (string or null)
- customer_phone: ONLY the customer/buyer phone if it is explicitly labeled as such (e.g. "Cliente", "Customer", "Buyer", "Comprador", "Telefono del cliente"). Do NOT return merchant service phones, 0800 support numbers, RIF-adjacent numbers, store contact numbers, or any phone that is not clearly labeled as belonging to the buyer. If in doubt, return null. (string or null)
- merchant_name: business name or beneficiary name (string or null)
- merchant_rif: Venezuelan tax ID exactly as printed. Format starts with one of J, V, E, G, P followed by a dash and 8-9 digits, e.g. "J-30058671-2", "J-300586712", "V-12345678". Strip whitespace but preserve the letter prefix and dashes. Return null if no RIF is visible. (string or null)
- currency: the currency code of total_amount. Use "BS" for Venezuelan Bolivares, "USD" for US dollars, "EUR" for euros, "COP" for Colombian pesos, "MXN" for Mexican pesos, etc. Look for symbols ($, Bs, €, ₡), explicit codes (USD, BSS, BS), or country context. If you cannot determine it, return null. (string or null)
- bank_name: bank that processed the payment (string or null, only for mobile_payment)
- payment_reference: bank reference number (string or null, only for mobile_payment)
- order_items: array of { name: string, quantity: number, unit_price: number } for each line item. Only for fiscal_invoice. (array or null)
- confidence_score: 0.0 to 1.0 based on text clarity (number)

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
    return {
      invoice_number: parsed.invoice_number || null,
      total_amount: parsed.total_amount != null ? Number(parsed.total_amount) : null,
      transaction_date: parsed.transaction_date || null,
      transaction_time: parsed.transaction_time || null,
      customer_phone: parsed.customer_phone || null,
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
    console.error('[AI] Claude API call failed:', err);
    return {
      invoice_number: null, total_amount: null, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0,
    };
  }
}

/**
 * Full Stage A: image buffer → OCR → AI → structured data.
 */
export async function extractFromImage(imageBuffer: Buffer): Promise<{
  extractedData: ExtractedInvoiceData;
  ocrRawText: string | null;
}> {
  const imageBase64 = imageBuffer.toString('base64');

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
