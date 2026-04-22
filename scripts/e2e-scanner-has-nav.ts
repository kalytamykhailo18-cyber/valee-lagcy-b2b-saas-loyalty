/**
 * E2E: /merchant/scanner ships the shared merchant nav drawer
 * (Genesis QA item 7). Cashier had no way to reach other sections
 * from the scanner view except by detouring through Pago en efectivo.
 *
 * Source-level assertion since the drawer is injected by the layout.
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
  console.log('=== Scanner page nav drawer E2E ===\n');

  const fs = await import('fs/promises');
  const layoutSrc = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(merchant)/merchant/layout.tsx',
    'utf8',
  );

  await assert('/merchant/scanner is NOT in bareRoutes (gets the drawer)',
    !/bareRoutes\s*=\s*\[[^\]]*'\/merchant\/scanner'/.test(layoutSrc),
    'verified');
  await assert('/merchant/scanner is NOT in PUBLIC_ROUTES (still auth-guarded)',
    !/PUBLIC_ROUTES\s*=\s*\[[^\]]*'\/merchant\/scanner'/.test(layoutSrc),
    'verified');

  // Chunk-grep: the scanner page response includes the merchant nav
  // items that live in the drawer layout.
  const scannerRes = await fetch(`${FRONTEND}/merchant/scanner`);
  await assert('/merchant/scanner serves 200',
    scannerRes.status === 200, `status=${scannerRes.status}`);
  const html = await scannerRes.text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));

  // Items the drawer ships on merchant layout
  await assert('scanner chunk references the Panel nav item',
    chunkBodies.some(js => js.includes('Panel') && js.includes('Configuracion')),
    `scanned=${chunkUrls.length}`);
  await assert('scanner chunk references the Clientes nav item',
    chunkBodies.some(js => js.includes('Clientes')),
    'verified');
  await assert('scanner chunk references the Sucursales nav item',
    chunkBodies.some(js => js.includes('Sucursales')),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
