/**
 * E2E: /admin/tenants page surfaces logo + search + reactivate button.
 *
 * Backend check:
 *   - GET /api/admin/tenants returns each tenant with logoUrl, rif, status.
 *
 * UI surface check (chunks referenced by the page):
 *   - at least one chunk contains the search placeholder string
 *   - at least one chunk renders logoUrl (image fallback to initial tile)
 *   - at least one chunk references the reactivateTenant API path
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { issueAdminTokens } from '../src/services/auth.js';

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Admin tenants UI (logo + search + reactivate) E2E ===\n');

  const admin = await prisma.adminUser.findFirstOrThrow();
  const adminToken = issueAdminTokens({ adminId: admin.id, type: 'admin' }).accessToken;

  // Backend: listing returns the fields the UI needs
  const res = await fetch(`${API}/api/admin/tenants`, {
    headers: { 'Authorization': `Bearer ${adminToken}` },
  });
  const body: any = await res.json();
  await assert('/api/admin/tenants 200', res.status === 200, `status=${res.status}`);
  await assert('tenants is an array', Array.isArray(body.tenants), `len=${body.tenants?.length}`);

  const sample = body.tenants[0];
  await assert('tenant entry has name', typeof sample?.name === 'string', `name=${sample?.name}`);
  await assert('tenant entry has status', typeof sample?.status === 'string', `status=${sample?.status}`);
  await assert('tenant entry exposes logoUrl field', 'logoUrl' in sample,
    `hasLogoUrl=${'logoUrl' in sample}`);
  await assert('tenant entry exposes rif field', 'rif' in sample,
    `hasRif=${'rif' in sample}`);

  // UI surface
  const pageRes = await fetch(`${FRONTEND}/admin/tenants`);
  await assert('/admin/tenants returns 200', pageRes.status === 200, `status=${pageRes.status}`);
  const pageHtml = await pageRes.text();

  const chunkUrls = Array.from(pageHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));

  await assert('chunk contains search placeholder',
    chunkBodies.some(js => js.includes('Buscar por nombre')),
    `scanned=${chunkUrls.length}`);
  await assert('chunk references logoUrl rendering',
    chunkBodies.some(js => js.includes('logoUrl') && js.includes('rounded-xl')),
    'yes');
  await assert('chunk references reactivate API',
    chunkBodies.some(js => js.includes('reactivate')),
    'yes');
  await assert('chunk has RIF filter inclusion',
    chunkBodies.some(js => js.includes('rif') && js.includes('toLowerCase')),
    'yes');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
