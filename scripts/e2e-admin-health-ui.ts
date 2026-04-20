/**
 * E2E (UI surface): the admin platform-health page is reachable and the
 * main admin dashboard links to it. Back-end contract is covered by
 * e2e-platform-health.ts; this script catches the common "page 404" or
 * "nav link missing" regressions without spinning up a browser.
 */

import dotenv from 'dotenv';
dotenv.config();

const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';
const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Admin platform-health UI surface ===\n');

  // 1. Page is served.
  const res = await fetch(`${FRONTEND}/admin/health`);
  await assert('/admin/health returns 200', res.status === 200, `status=${res.status}`);
  const html = await res.text();
  await assert('page html is non-empty', html.length > 0, `bytes=${html.length}`);

  // 2. Exec dashboard (main admin page) links to /admin/health. Next.js
  // renders this page on the client only (SSR shows a spinner), so the
  // link reference lives in the JS chunk. Pull the chunk URL out of the
  // page HTML and grep it.
  const mainHtml = await (await fetch(`${FRONTEND}/admin`)).text();
  const chunkMatch = mainHtml.match(/\/_next\/static\/chunks\/app\/\(admin\)\/admin\/page-[a-f0-9]+\.js/);
  await assert('/admin page JS chunk URL is present',
    !!chunkMatch, `chunk=${chunkMatch?.[0]?.slice(0, 60)}`);
  if (chunkMatch) {
    const chunk = await (await fetch(`${FRONTEND}${chunkMatch[0]}`)).text();
    await assert('admin page chunk references /admin/health link',
      chunk.includes('/admin/health'),
      `includes=${chunk.includes('/admin/health')}`);
  }

  // Same check for the health page itself: the chunk must reference the
  // getPlatformHealth API path.
  const healthHtml = html;
  // Literal API URL lives in the shared lib/api.ts chunk, which may be a
  // different chunk than the per-route page chunk. Scan every chunk the
  // page HTML references.
  const chunkUrls = Array.from(healthHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  let foundHealth = false;
  for (const u of chunkUrls) {
    const js = await (await fetch(`${FRONTEND}${u}`)).text();
    if (js.includes('/api/admin/platform-health')) { foundHealth = true; break; }
  }
  await assert('some /admin/health chunk calls /api/admin/platform-health',
    foundHealth, `scanned=${chunkUrls.length} found=${foundHealth}`);

  // 3. Backend endpoint is up (the page will call it on mount).
  // Hit it unauthenticated to confirm the route is registered (expect 401).
  const api = await fetch(`${API}/api/admin/platform-health?windowHours=24`);
  await assert('backend /api/admin/platform-health is registered (401 unauth)',
    api.status === 401, `status=${api.status}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
