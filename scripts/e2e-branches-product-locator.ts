/**
 * E2E for Genesis's 2026-04-24 5-point ask:
 *
 *   1. products tied to a branch (already live).
 *   2. consumer view shows product + branch + stock — and, importantly,
 *      branch-scoped products must NOT vanish from the catalog just
 *      because the consumer has no branch context.
 *   3. tenant-wide products advertise the list of branches where they
 *      apply.
 *   4. branches page shows per-branch productCount.
 *   5. branches page shows per-branch redemptionCount.
 *
 * Checks:
 *   (a) Consumer with NO branchId query sees every product (tenant-wide
 *       and branch-scoped alike). This is the regression fix.
 *   (b) Each product row carries branchScope + branchName / branchNames.
 *   (c) Consumer with branchId=X narrows to X + tenant-wide.
 *   (d) GET /api/merchant/branches returns productCount and
 *       redemptionCount per branch and on the mainBranch summary.
 *   (e) A redemption confirmed under branch A increments only A's
 *       redemption count, not other branches'.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { issueConsumerTokens } from '../src/services/auth.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }});
  let body: any = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

function ownerToken(staffId: string, tenantId: string) {
  return jwt.sign(
    { staffId, tenantId, role: 'owner', type: 'staff' },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );
}

async function main() {
  console.log('=== Branch product locator + counts E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Locator ${ts}`, `locator-${ts}`, `locator-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `owner-loc-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const tok = ownerToken(owner.id, tenant.id);

  const branchA = await prisma.branch.create({ data: { tenantId: tenant.id, name: 'Centro',   active: true }});
  const branchB = await prisma.branch.create({ data: { tenantId: tenant.id, name: 'Naguanagua', active: true }});

  const products = await prisma.product.createManyAndReturn({
    data: [
      { tenantId: tenant.id, branchId: branchA.id, name: `Cafe Centro ${ts}`, redemptionCost: '100', assetTypeId: asset.id, stock: 10, active: true },
      { tenantId: tenant.id, branchId: branchA.id, name: `Muffin Centro ${ts}`, redemptionCost: '80', assetTypeId: asset.id, stock: 10, active: true },
      { tenantId: tenant.id, branchId: branchB.id, name: `Pan Nag ${ts}`, redemptionCost: '50', assetTypeId: asset.id, stock: 10, active: true },
      { tenantId: tenant.id, branchId: null,        name: `Global ${ts}`,  redemptionCost: '30', assetTypeId: asset.id, stock: 10, active: true },
    ],
  });

  // ---- Consumer catalog ----
  const phone = `+19720${String(ts).slice(-7)}`;
  const { account } = await findOrCreateConsumerAccount(tenant.id, phone);
  const consumerToken = issueConsumerTokens({
    accountId: account.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;

  // (a) Consumer with NO branchId sees all 4 products (Genesis repro).
  const catAll = await http('/api/consumer/catalog', consumerToken);
  const ids = new Set((catAll.body.products || []).map((p: any) => p.id));
  await assert('consumer w/o branch context sees all 4 products (Genesis repro)',
    products.every(p => ids.has(p.id)),
    `ids=${[...ids].length} expected 4`);

  // (b) Scope + branchName/branchNames fields on each row
  const centro1 = (catAll.body.products || []).find((p: any) => p.name === `Cafe Centro ${ts}`);
  const global1 = (catAll.body.products || []).find((p: any) => p.name === `Global ${ts}`);
  await assert('branch-scoped product reports branchScope=branch and branchName',
    centro1?.branchScope === 'branch' && centro1?.branchName === 'Centro',
    `scope=${centro1?.branchScope} name=${centro1?.branchName}`);
  await assert('tenant-wide product reports branchScope=tenant and branchNames list',
    global1?.branchScope === 'tenant'
      && Array.isArray(global1?.branchNames)
      && global1.branchNames.sort().join(',') === ['Centro','Naguanagua'].sort().join(','),
    `scope=${global1?.branchScope} branches=${JSON.stringify(global1?.branchNames)}`);

  // (c) branchId filter: only Centro + tenant-wide
  const catA = await http(`/api/consumer/catalog?branchId=${branchA.id}`, consumerToken);
  const idsA = new Set((catA.body.products || []).map((p: any) => p.id));
  const centroProducts = products.filter(p => p.branchId === branchA.id).map(p => p.id);
  const naguaProducts  = products.filter(p => p.branchId === branchB.id).map(p => p.id);
  const wideProduct    = products.find(p => p.branchId === null)!.id;
  await assert('branchId=Centro filter returns Centro + tenant-wide only',
    centroProducts.every(id => idsA.has(id)) && idsA.has(wideProduct) && !naguaProducts.some(id => idsA.has(id)),
    `idsA=${[...idsA].length}`);

  // ---- Merchant branches ----
  // (d) productCount per branch + mainBranch
  const branchesRes = await http('/api/merchant/branches', tok);
  const rowA = (branchesRes.body.branches || []).find((b: any) => b.id === branchA.id);
  const rowB = (branchesRes.body.branches || []).find((b: any) => b.id === branchB.id);
  await assert('branchA.productCount = 2',
    rowA?.productCount === 2, `productCount=${rowA?.productCount}`);
  await assert('branchB.productCount = 1',
    rowB?.productCount === 1, `productCount=${rowB?.productCount}`);
  await assert('mainBranch.productCount = 1 (tenant-wide)',
    branchesRes.body.mainBranch?.productCount === 1,
    `productCount=${branchesRes.body.mainBranch?.productCount}`);

  // (e) Redemptions: seed a REDEMPTION_CONFIRMED on branchA, verify the
  //     counter increments only there.
  const pool   = await getSystemAccount(tenant.id, 'issued_value_pool');
  const hold   = await getSystemAccount(tenant.id, 'redemption_holding');
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_CONFIRMED',
    debitAccountId: hold!.id,
    creditAccountId: pool!.id,
    amount: '100.00000000',
    assetTypeId: asset.id,
    referenceId: `CONFIRMED-${ts}-a`,
    referenceType: 'redemption_token',
    branchId: branchA.id,
  });

  const branchesRes2 = await http('/api/merchant/branches', tok);
  const rowA2 = (branchesRes2.body.branches || []).find((b: any) => b.id === branchA.id);
  const rowB2 = (branchesRes2.body.branches || []).find((b: any) => b.id === branchB.id);
  await assert('branchA.redemptionCount increments to 1',
    rowA2?.redemptionCount === 1, `redemptionCount=${rowA2?.redemptionCount}`);
  await assert('branchB.redemptionCount remains 0 (no leakage)',
    rowB2?.redemptionCount === 0, `redemptionCount=${rowB2?.redemptionCount}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
