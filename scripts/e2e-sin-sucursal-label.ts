/**
 * E2E: 'Sin sucursal asignada' option in the merchant dashboard branch
 * picker is renamed to something more meaningful — either just the
 * merchant name (no branches at all) or '<merchant> · sin sucursal
 * especifica' (there are branches but this bucket is for unassigned
 * activity). Genesis M7.
 *
 * Chunk-grep test since the value is built at render time from
 * localStorage.tenantName.
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
  console.log('=== /merchant unassigned-branch label E2E ===\n');

  const res = await fetch(`${FRONTEND}/merchant`);
  await assert('/merchant serves 200', res.status === 200, `status=${res.status}`);
  const html = await res.text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));

  await assert('old literal "Sin sucursal asignada" is gone',
    !chunkBodies.some(js => js.includes('Sin sucursal asignada')),
    'verified');
  await assert('new "sin sucursal especifica" label is shipped',
    chunkBodies.some(js => js.includes('sin sucursal especifica')),
    `scanned=${chunkUrls.length}`);
  await assert('bare "Sin sucursal" fallback is present for 0-branch case',
    chunkBodies.some(js => js.includes('Sin sucursal')),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
