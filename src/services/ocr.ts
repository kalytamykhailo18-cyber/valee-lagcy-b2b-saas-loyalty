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
        messages: [{
          role: 'user',
          content: `You are extracting data from a Latin American sales document. The text below is the raw OCR output.
The document may be one of three types:
- "fiscal_invoice": a traditional sales receipt (FACTURA DE VENTA, with invoice number, items, RIF, etc.)
- "mobile_payment": a screenshot of a mobile bank payment confirmation (Pago Móvil, transferencia bancaria, with bank name, reference number, amount, beneficiary)
- "voucher": a small printed voucher with just the amount and date, no items

CRITICAL RULES:
1. NEVER invent, guess, or hallucinate values. If a field is not clearly visible in the OCR text, return null for that field.
2. The invoice_number must be copied VERBATIM from the text. Do not normalize, reformat, or prepend anything (no "INV-" prefix unless it's literally in the text). Common Latin American formats include: "00-000000", "FAC-1234", "N. 123456", "Control: 01-0000123", "Factura No. 123".
3. The total_amount must be the final amount in the document's native currency. Do not convert currencies. If you see both a Bs amount and a USD reference, use the Bs amount (it's the primary currency).
4. For mobile_payment screenshots: invoice_number must be set to the bank reference number (the unique identifier the bank assigns to the transaction). bank_name must be the bank that processed the payment (Banesco, BDV, Mercantil, BBVA Provincial, Banco Plaza, Banco del Tesoro, etc.). payment_reference is the same as the bank reference.
5. For voucher documents: invoice_number can be null if no number is printed. The system will generate a synthetic reference.
6. Set confidence_score to 0.0-0.3 if the text is blurry or fields are missing; 0.4-0.7 if some fields are unclear; 0.8-1.0 only if everything is clearly readable.

Return ONLY a JSON object with these exact fields:
- document_type: one of "fiscal_invoice", "mobile_payment", "voucher" (string)
- invoice_number: exact identifier as shown (string or null). For mobile_payment, use the bank reference number.
- total_amount: final total in document's currency (number or null)
- transaction_date: date in ISO format YYYY-MM-DD (string or null)
- transaction_time: time if visible, e.g. "14:30" (string or null)
- customer_phone: customer phone if printed (string or null)
- merchant_name: business name or beneficiary name (string or null)
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

    // Parse the JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        invoice_number: null, total_amount: null, transaction_date: null,
        customer_phone: null, merchant_name: null, confidence_score: 0,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      invoice_number: parsed.invoice_number || null,
      total_amount: parsed.total_amount != null ? Number(parsed.total_amount) : null,
      transaction_date: parsed.transaction_date || null,
      transaction_time: parsed.transaction_time || null,
      customer_phone: parsed.customer_phone || null,
      merchant_name: parsed.merchant_name || null,
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
