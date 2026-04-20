/**
 * E2E: merchant dashboard displays CIRCULACION clamped to 0 when the
 * ledger math produces a negative number (consumers spending points
 * awarded before the current filter window).
 *
 * Genesis screenshot: CIRCULACION=-37 and CIRCULACION=-469 on the tile
 * — the raw math was correct (emitido - canjeado) but the negative is
 * visually alarming and doesn't map to a mental model of "points in
 * circulation". Clamp to 0 and show an explanatory footnote.
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
  console.log('=== CIRCULACION UI clamp E2E ===\n');

  const res = await fetch(`${FRONTEND}/merchant`);
  await assert('/merchant returns 200', res.status === 200, `status=${res.status}`);
  const html = await res.text();

  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));

  await assert('merchant chunk uses Math.max(0, raw) for circulacion',
    chunkBodies.some(js => js.includes('Math.max(0,') && js.includes('netCirculation')),
    `scanned=${chunkUrls.length}`);
  await assert('merchant chunk exposes the explanatory footnote',
    chunkBodies.some(js => js.includes('Se canjearon puntos previos a esta ventana')),
    `footnote=${chunkBodies.some(js => js.includes('Se canjearon puntos previos'))}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
