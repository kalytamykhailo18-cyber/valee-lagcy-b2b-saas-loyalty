/**
 * E2E: the consumer catalog QR view no longer shows the raw JWT text
 * ('Copiar codigo manual' button + eyJ... preview).
 *
 * Genesis flagged it as confusing clutter. The 6-digit manual code is
 * the real fallback when a cashier camera can't read the QR, and it
 * renders separately.
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
  console.log('=== Catalog QR — no JWT preview / copy button ===\n');

  const res = await fetch(`${FRONTEND}/catalog`);
  await assert('/catalog returns 200', res.status === 200, `status=${res.status}`);
  const html = await res.text();

  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));

  await assert('catalog chunks do NOT contain "Copiar codigo manual"',
    !chunkBodies.some(js => js.includes('Copiar codigo manual')),
    `found=${chunkBodies.some(js => js.includes('Copiar codigo manual'))}`);
  await assert('catalog chunks do NOT reference value.slice(0, 40)',
    !chunkBodies.some(js => js.includes('value.slice(0, 40)') || js.includes('value.slice(0,40)')),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
