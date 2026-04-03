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
          content: `Extract the following fields from this invoice/receipt text. Return ONLY a JSON object with these fields:
- invoice_number: the invoice or order number (string or null)
- total_amount: the total amount paid (number or null)
- transaction_date: the date of the transaction in ISO format (string or null)
- transaction_time: the time of the transaction if visible (string or null, e.g. "14:30")
- customer_phone: the customer's phone number if present (string or null)
- merchant_name: the merchant/store name if present (string or null)
- order_items: an array of items ordered, each with { name: string, quantity: number, unit_price: number } (array or null). Extract every line item visible on the receipt.
- confidence_score: how confident you are in the extraction from 0.0 to 1.0 (number)

IMPORTANT: The order items are critical business data. Extract every product/item line you can find, including quantities and individual prices.

Receipt text:
${ocrText}

Return ONLY the JSON object, no other text.`,
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
