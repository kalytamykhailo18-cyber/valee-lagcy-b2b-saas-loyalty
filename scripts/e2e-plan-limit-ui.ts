/**
 * E2E: plan limit rejections surface to the merchant UI (Genesis QA
 * item 9). Image 23/24 showed devtools full of 402 errors while the
 * page did nothing visible — Eric/Genesis couldn't tell why "Crear
 * producto" wasn't working.
 *
 * Validates:
 *   - Backend 402 comes back with a Spanish message the UI can show
 *   - Products and hybrid-deals pages surface that message
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Plan limit UI E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`PlanLim ${ts}`, `pl-${ts}`, `pl-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  // BASIC plan caps products_in_catalog at 20 per plan-limits.ts config
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `pl-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  // Seed right up to the BASIC product cap (20)
  for (let i = 0; i < 20; i++) {
    await prisma.product.create({
      data: {
        tenantId: tenant.id, name: `Prod ${i} ${ts}`, redemptionCost: 10,
        assetTypeId: asset.id, stock: 5, active: true, minLevel: 1,
      },
    });
  }

  // 21st product attempt — should hit the plan cap
  const res = await fetch(`${API}/api/merchant/products`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: `Prod-21 ${ts}`, redemptionCost: '10', stock: 1,
      assetTypeId: asset.id, minLevel: 1,
    }),
  });
  const body: any = await res.json();

  await assert('backend returns 402 Payment Required at cap',
    res.status === 402, `status=${res.status}`);
  await assert('error message is in Spanish and names the limit',
    /maximo de|actualiza el plan/i.test(body.error || ''),
    `error="${body.error}"`);
  await assert('response includes usage snapshot',
    !!body.usage && typeof body.usage.current === 'number',
    `usage=${JSON.stringify(body.usage)}`);

  // Frontend side: the products page and hybrid-deals page surface errors
  const fs = await import('fs/promises');
  const productsSrc = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(merchant)/merchant/products/page.tsx',
    'utf8',
  );
  const hybridSrc = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(merchant)/merchant/hybrid-deals/page.tsx',
    'utf8',
  );

  await assert('products page catch surfaces e.error via createMessage',
    /catch\s*\(e:\s*any\)\s*\{[^}]*setCreateMessage\(`Error/.test(productsSrc),
    'verified');
  await assert('hybrid-deals page catch surfaces e.error via createMessage',
    /catch\s*\(e:\s*any\)\s*\{[^}]*setCreateMessage\(`Error/.test(hybridSrc),
    'verified');

  // Chunk-grep the products page ships createMessage UI
  const html = await (await fetch(`${FRONTEND}/merchant/products`)).text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('products chunk ships the rose-red error color class',
    chunkBodies.some(js => js.includes('text-rose-600')),
    `scanned=${chunkUrls.length}`);
  await assert('products chunk ships the "No se pudo crear el producto" fallback string',
    chunkBodies.some(js => js.includes('No se pudo crear el producto')),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
