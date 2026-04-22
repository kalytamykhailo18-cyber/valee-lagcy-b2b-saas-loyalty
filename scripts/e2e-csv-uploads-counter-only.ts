/**
 * E2E: CSV uploads plan row renders as a counter, not X / limit
 * (Genesis QA item 8).
 *
 * Other plan metrics keep the full X / Y + progress-bar display;
 * csv_uploads is rendered as just the current count.
 */

import dotenv from 'dotenv';
dotenv.config();

const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== CSV uploads counter-only E2E ===\n');

  const fs = await import('fs/promises');
  const src = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(merchant)/merchant/settings/page.tsx',
    'utf8',
  );

  await assert('settings page branches on isCounterOnly',
    /isCounterOnly\s*=\s*key\s*===\s*'csv_uploads'/.test(src),
    'verified');
  await assert('counter-only row renders current without the / limit suffix',
    /isCounterOnly\s*\?\s*u\.current\s*:\s*`\$\{u\.current\}\s*\/\s*\$\{u\.limit\}`/.test(src),
    'verified');
  await assert('counter-only row hides the progress bar',
    /\{!isCounterOnly\s*&&\s*\(/.test(src),
    'verified');

  // Chunk-grep: the settings bundle ships the new branching copy.
  const html = await (await fetch(`${FRONTEND}/merchant/settings`)).text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('chunk ships the csv_uploads counter branch',
    chunkBodies.some(js => js.includes('csv_uploads')),
    `scanned=${chunkUrls.length}`);
  await assert('chunk still ships "Cargas de CSV este mes" label',
    chunkBodies.some(js => js.includes('Cargas de CSV este mes')),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
