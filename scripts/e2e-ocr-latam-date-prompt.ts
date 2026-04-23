/**
 * E2E: the OCR prompt tells Claude that receipts use day-first dates.
 *
 * Genesis 2026-04-23 bug: a Farmatodo receipt dated 01/04/2026 (1 April)
 * was ingested as 2026-01-04 (4 January). Root cause — the Stage-A
 * prompt told Claude to emit ISO YYYY-MM-DD but never told it that
 * Venezuelan / LATAM receipts use DD/MM/YYYY, so it defaulted to the
 * US MM/DD reading. This is a regression guard on the prompt: if
 * someone strips the LATAM hint the test fails loudly.
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs/promises';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== OCR LATAM date prompt E2E ===\n');

  const src = await fs.readFile('/home/loyalty-platform/src/services/ocr.ts', 'utf8');

  await assert('prompt mentions day-first / DD/MM explicitly',
    /day-first|DD\/MM\/YYYY/.test(src),
    'verified');
  await assert('prompt gives the Genesis example (01/04 = 1 April)',
    /01\/04\/2026/.test(src) && /1 April/.test(src),
    'verified');
  await assert('prompt forbids US MM\\/DD interpretation',
    /NOT.*4\s*January|never.*US MM\/DD/i.test(src),
    'verified');
  await assert('prompt explains 2-digit year expansion',
    /two digits|two-digit|2 digits/i.test(src) && /20XX|20\d\d/.test(src),
    'verified');

  // Built chunk check — the backend is not a chunked app but we assert
  // the actual module loaded by node exposes the instruction string.
  const ocr = await import('/home/loyalty-platform/src/services/ocr.ts' as any);
  // ocr.ts exports EXTRACTION_RULES indirectly via the EXTRACTION_PROMPT
  // send path. We just verify the module loads cleanly.
  await assert('ocr.ts module loads without error',
    !!ocr,
    'module imported');

  // Frontend check — csv-upload still renders with timeZone:UTC so the
  // stored UTC midnight doesn't shift by a day in VE display. This
  // pairs with the OCR fix: AI emits the right calendar day, and the
  // UI keeps it there.
  const fe = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(merchant)/merchant/csv-upload/page.tsx',
    'utf8',
  );
  await assert('csv-upload still renders with timeZone:UTC',
    /toLocaleDateString\(\s*'es-VE'\s*,\s*\{\s*timeZone:\s*'UTC'\s*\}/.test(fe),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
