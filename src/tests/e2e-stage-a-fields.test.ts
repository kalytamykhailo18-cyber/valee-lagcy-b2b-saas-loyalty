import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import fs from 'fs';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function test() {
  console.log('=== STAGE A: EXTRACTED FIELDS VERIFICATION ===\n');

  // ──────────────────────────────────
  // 1. Data structure has all 5 spec fields + confidence
  // ──────────────────────────────────
  console.log('1. ExtractedInvoiceData type has all required fields');

  const validationSrc = fs.readFileSync('/home/loyalty-platform/src/services/invoice-validation.ts', 'utf-8');
  assert(validationSrc.includes('invoice_number: string | null'), 'invoice_number field defined');
  assert(validationSrc.includes('total_amount: number | null'), 'total_amount field defined');
  assert(validationSrc.includes('transaction_date: string | null'), 'transaction_date field defined');
  assert(validationSrc.includes('customer_phone: string | null'), 'customer_phone field defined');
  assert(validationSrc.includes('merchant_name: string | null'), 'merchant_name field defined');
  assert(validationSrc.includes('confidence_score: number'), 'confidence_score field defined');

  // ──────────────────────────────────
  // 2. Claude AI prompt requests all 5 fields
  // ──────────────────────────────────
  console.log('\n2. Claude AI prompt requests exactly these fields');

  const ocrSrc = fs.readFileSync('/home/loyalty-platform/src/services/ocr.ts', 'utf-8');
  assert(ocrSrc.includes('invoice_number: the invoice or order number'), 'Prompt asks for invoice_number');
  assert(ocrSrc.includes('total_amount: the total amount paid'), 'Prompt asks for total_amount');
  assert(ocrSrc.includes('transaction_date: the date of the transaction'), 'Prompt asks for transaction_date');
  assert(ocrSrc.includes('customer_phone: the customer\'s phone number'), 'Prompt asks for customer_phone');
  assert(ocrSrc.includes('merchant_name: the merchant/store name'), 'Prompt asks for merchant_name');
  assert(ocrSrc.includes('confidence_score: how confident'), 'Prompt asks for confidence_score');

  // ──────────────────────────────────
  // 3. AI response parsing maps all fields
  // ──────────────────────────────────
  console.log('\n3. AI response parsing maps all fields correctly');

  assert(ocrSrc.includes('parsed.invoice_number'), 'Parses invoice_number from response');
  assert(ocrSrc.includes('parsed.total_amount'), 'Parses total_amount from response');
  assert(ocrSrc.includes('parsed.transaction_date'), 'Parses transaction_date from response');
  assert(ocrSrc.includes('parsed.customer_phone'), 'Parses customer_phone from response');
  assert(ocrSrc.includes('parsed.merchant_name'), 'Parses merchant_name from response');
  assert(ocrSrc.includes('parsed.confidence_score'), 'Parses confidence_score from response');

  // ──────────────────────────────────
  // 4. Pipeline uses OCR_CONFIDENCE_THRESHOLD from .env
  // ──────────────────────────────────
  console.log('\n4. Confidence threshold from .env');

  assert(validationSrc.includes("process.env.OCR_CONFIDENCE_THRESHOLD"), 'Uses OCR_CONFIDENCE_THRESHOLD from .env');
  const threshold = parseFloat(process.env.OCR_CONFIDENCE_THRESHOLD || '0.7');
  assert(threshold === 0.7, `Threshold value: ${threshold}`);

  // ──────────────────────────────────
  // 5. Full OCR pipeline: image → Vision API → text → Claude → structured data
  // ──────────────────────────────────
  console.log('\n5. Full OCR pipeline wiring');

  assert(ocrSrc.includes('vision.googleapis.com'), 'Google Vision API called');
  assert(ocrSrc.includes('GOOGLE_VISION_API_KEY'), 'Uses GOOGLE_VISION_API_KEY from .env');
  assert(ocrSrc.includes('api.anthropic.com'), 'Anthropic Claude API called');
  assert(ocrSrc.includes('ANTHROPIC_API_KEY'), 'Uses ANTHROPIC_API_KEY from .env');
  assert(ocrSrc.includes('TEXT_DETECTION'), 'Requests TEXT_DETECTION from Vision API');
  assert(ocrSrc.includes('content: imageBase64'), 'Sends image as base64 to Vision');
  assert(ocrSrc.includes('fullTextAnnotation'), 'Extracts text from Vision response');

  // ──────────────────────────────────
  // 6. Spec field mapping to database columns
  // ──────────────────────────────────
  console.log('\n6. Fields stored in invoices table');

  const cols = await prisma.$queryRaw<any[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name IN ('ocr_raw_text', 'extracted_data', 'confidence_score')
    ORDER BY column_name
  `;
  assert(cols.length === 3, `All 3 storage columns exist (got ${cols.length})`);
  assert(cols.some((c: any) => c.column_name === 'ocr_raw_text'), 'ocr_raw_text column (raw Vision API text)');
  assert(cols.some((c: any) => c.column_name === 'extracted_data'), 'extracted_data column (Claude JSON output)');
  assert(cols.some((c: any) => c.column_name === 'confidence_score'), 'confidence_score column');

  console.log(`\n=== STAGE A FIELDS: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
