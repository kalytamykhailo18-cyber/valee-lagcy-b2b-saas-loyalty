/**
 * E2E: admin /admin/audit page + /api/admin/audit-log endpoint.
 *
 * Backend: seed two audit rows, fetch with filters, assert shape + pagination.
 * UI: page serves 200 + chunks reference the audit-log API + dashboard links
 *     to /admin/audit.
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

async function http(path: string, token: string | null) {
  const res = await fetch(`${API}${path}`, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== Admin audit-log UI + API E2E ===\n');

  const admin = await prisma.adminUser.findFirstOrThrow();
  const adminToken = issueAdminTokens({ adminId: admin.id, type: 'admin' }).accessToken;

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'smoke-test' } });
  const ts = Date.now();

  // Seed two distinct audit rows so we can query by both tenant + actionType.
  const seedId1 = `00000000-0000-0000-0000-${String(ts).padStart(12, '0').slice(-12)}`;
  const seedId2 = `00000000-0000-0001-0000-${String(ts).padStart(12, '0').slice(-12)}`;
  await prisma.$executeRaw`
    INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
    VALUES
      (${seedId1}::uuid, ${tenant.id}::uuid, ${admin.id}::uuid, 'admin', 'admin', 'CUSTOMER_LOOKUP'::"AuditActionType", 'success',
        ${JSON.stringify({ reason: `audit-ui-e2e-${ts}`, seed: true })}::jsonb, now()),
      (${seedId2}::uuid, ${tenant.id}::uuid, ${admin.id}::uuid, 'admin', 'admin', 'MANUAL_ADJUSTMENT'::"AuditActionType", 'success',
        ${JSON.stringify({ reason: `audit-ui-e2e-adj-${ts}`, seed: true })}::jsonb, now())
  `;

  // Validation: bad tenantId → 400
  const bad = await http('/api/admin/audit-log?tenantId=not-a-uuid', adminToken);
  await assert('audit-log bad tenantId → 400', bad.status === 400, `status=${bad.status}`);

  // No auth → 401
  const noauth = await http('/api/admin/audit-log', null);
  await assert('audit-log without admin token → 401', noauth.status === 401, `status=${noauth.status}`);

  // Tenant-scoped query returns both seeded rows
  const byTenant = await http(`/api/admin/audit-log?tenantId=${tenant.id}&limit=100`, adminToken);
  await assert('audit-log by tenant → 200', byTenant.status === 200, `status=${byTenant.status}`);
  await assert('response has entries array + total', Array.isArray(byTenant.body.entries) && typeof byTenant.body.total === 'number',
    `entries=${byTenant.body.entries?.length} total=${byTenant.body.total}`);

  const seeded1 = byTenant.body.entries.find((e: any) => e.id === seedId1);
  const seeded2 = byTenant.body.entries.find((e: any) => e.id === seedId2);
  await assert('tenant query returns seeded CUSTOMER_LOOKUP row', !!seeded1, `found=${!!seeded1}`);
  await assert('tenant query returns seeded MANUAL_ADJUSTMENT row', !!seeded2, `found=${!!seeded2}`);
  await assert('entries carry tenantName', typeof seeded1?.tenantName === 'string' && seeded1.tenantName.length > 0,
    `tenantName=${seeded1?.tenantName}`);

  // actionType filter narrows to just the MANUAL_ADJUSTMENT seed
  const byAction = await http(`/api/admin/audit-log?tenantId=${tenant.id}&actionType=MANUAL_ADJUSTMENT&limit=100`, adminToken);
  await assert('actionType filter narrows results',
    byAction.body.entries.every((e: any) => e.actionType === 'MANUAL_ADJUSTMENT'),
    `count=${byAction.body.entries.length}`);
  await assert('actionType filter still finds seeded MANUAL_ADJUSTMENT row',
    byAction.body.entries.some((e: any) => e.id === seedId2),
    `found=${byAction.body.entries.some((e: any) => e.id === seedId2)}`);

  // Pagination: limit=1 returns 1 entry but total > 1
  const page = await http(`/api/admin/audit-log?tenantId=${tenant.id}&limit=1`, adminToken);
  await assert('limit=1 returns exactly 1 entry', page.body.entries.length === 1,
    `len=${page.body.entries.length}`);
  await assert('total reflects full count regardless of limit', page.body.total >= 2,
    `total=${page.body.total}`);
  await assert('response echoes limit + offset', page.body.limit === 1 && page.body.offset === 0,
    `limit=${page.body.limit} offset=${page.body.offset}`);

  // UI surface
  const pageRes = await fetch(`${FRONTEND}/admin/audit`);
  await assert('/admin/audit returns 200', pageRes.status === 200, `status=${pageRes.status}`);
  const pageHtml = await pageRes.text();

  const mainHtml = await (await fetch(`${FRONTEND}/admin`)).text();
  const mainChunk = mainHtml.match(/\/_next\/static\/chunks\/app\/\(admin\)\/admin\/page-[a-f0-9]+\.js/);
  if (mainChunk) {
    const js = await (await fetch(`${FRONTEND}${mainChunk[0]}`)).text();
    await assert('admin dashboard links to /admin/audit', js.includes('/admin/audit'),
      `includes=${js.includes('/admin/audit')}`);
  }

  // The literal URL lives in the shared api.ts chunk, not the per-route
  // audit page chunk (the page calls api.getAuditLog as a symbol). Scan
  // every chunk referenced from /admin/audit until we find the URL.
  const allChunks = Array.from(pageHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  let foundUrl = false;
  for (const c of allChunks) {
    const js = await (await fetch(`${FRONTEND}${c}`)).text();
    if (js.includes('/api/admin/audit-log')) { foundUrl = true; break; }
  }
  await assert('some /admin/audit chunk references /api/admin/audit-log',
    foundUrl, `scanned=${allChunks.length} found=${foundUrl}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
