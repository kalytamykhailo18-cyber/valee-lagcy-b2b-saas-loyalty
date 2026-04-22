/**
 * E2E: back-to-back product creation works (Genesis QA item 4).
 *
 * Genesis's bug: create one product, hit Crear producto, success.
 * Try to create the next one without refreshing — form silently fails,
 * devtools shows POST errors.
 *
 * Root cause identified: handleCreate reset the form state with
 * assetTypeId='', but assetTypeId is required on every POST. The
 * silent catch then swallowed the backend rejection so nothing
 * surfaced to the user.
 *
 * This test drives the backend directly (two POSTs in a row for the
 * same tenant) and asserts both succeed, plus inspects the source
 * for the preservation of assetTypeId and the error-surfacing copy.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Back-to-back product creation E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`ProdCreate ${ts}`, `pc-${ts}`, `pc-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `pc-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  async function post(body: any) {
    const res = await fetch(`${API}/api/merchant/products`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  }

  // First product
  const r1 = await post({
    name: `Producto A ${ts}`,
    description: 'A',
    redemptionCost: '10',
    stock: 5,
    assetTypeId: asset.id,
    minLevel: 1,
  });
  await assert('first POST returns 200', r1.status === 200, `status=${r1.status}`);

  // Second product back-to-back, same assetTypeId — used to fail in UI due
  // to assetTypeId being wiped on reset; we pass it explicitly here to
  // match the backend contract the fixed frontend now provides.
  const r2 = await post({
    name: `Producto B ${ts}`,
    description: 'B',
    redemptionCost: '20',
    stock: 3,
    assetTypeId: asset.id,
    minLevel: 1,
  });
  await assert('second POST returns 200', r2.status === 200, `status=${r2.status}`);

  // Both rows exist
  const count = await prisma.product.count({ where: { tenantId: tenant.id } });
  await assert('both products persisted', count === 2, `count=${count}`);

  // Third POST with missing assetTypeId — the old bug path — must 4xx and
  // the backend message must be surfaceable (not empty).
  const r3 = await post({
    name: `Producto C ${ts}`,
    description: 'C',
    redemptionCost: '30',
    stock: 1,
    assetTypeId: '',
    minLevel: 1,
  });
  await assert('third POST with empty assetTypeId rejected',
    r3.status >= 400 && r3.status < 500, `status=${r3.status}`);

  // Source-level assertions on the fix
  const fs = await import('fs/promises');
  const src = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(merchant)/merchant/products/page.tsx',
    'utf8',
  );
  await assert('handleCreate preserves assetTypeId in form reset',
    /setForm\(prev\s*=>\s*\(\s*\{[^}]*assetTypeId:\s*prev\.assetTypeId/s.test(src),
    'verified');
  await assert('handleCreate catch block calls setCreateMessage with Error prefix',
    /catch\s*\(e:\s*any\)\s*\{[^}]*setCreateMessage\(`Error/s.test(src),
    'verified');
  await assert('page renders createMessage state',
    /createMessage\s*&&/.test(src) && /createMessage\.startsWith\('Error'\)/.test(src),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
