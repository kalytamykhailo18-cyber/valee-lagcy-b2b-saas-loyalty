/**
 * E2E: cross-branch redemption policy (Genesis H11).
 *
 * Tenants can now flip `crossBranchRedemption` off to require that a
 * canje QR is scanned in the same branch it was generated. Default is
 * true so existing behavior ("points are per merchant, any branch")
 * keeps working.
 *
 * Flow:
 *   1. Create tenant with 2 branches A and B.
 *   2. Default policy (ON): consumer redeems at A, cashier at B confirms → success.
 *   3. Flip policy OFF via PUT /api/merchant/settings.
 *   4. Consumer redeems at A, cashier at B tries → rejected with branch-specific
 *      message; redeemed at A succeeds.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { initiateRedemption, processRedemption } from '../src/services/redemption.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Cross-branch redemption policy E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`CrossBranch ${ts}`, `cb-${ts}`, `cb-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;

  const branchA = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal Valencia', active: true },
  });
  const branchB = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal Maracaibo', active: true },
  });

  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cashier', email: `cb-cashier-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
    },
  });
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `cb-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id, name: `CB Prize ${ts}`, redemptionCost: 20,
      assetTypeId: asset.id, stock: 5, active: true, minLevel: 1,
    },
  });

  let fundSeq = 0;
  async function fundAndRedeem(branchId: string, fundAmt: string) {
    fundSeq++;
    const phone = `+19000${String(ts).slice(-7)}${fundSeq}`;
    const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);
    await writeDoubleEntry({
      tenantId: tenant.id,
      eventType: 'ADJUSTMENT_MANUAL',
      debitAccountId: pool.id, creditAccountId: consumer.id,
      amount: fundAmt, assetTypeId: asset.id,
      referenceId: `SEED-${ts}-${consumer.id}`, referenceType: 'manual_adjustment',
      metadata: { type: 'test_fund' },
    });
    const red = await initiateRedemption({
      consumerAccountId: consumer.id,
      productId: product.id,
      tenantId: tenant.id,
      assetTypeId: asset.id,
      branchId,
    });
    return { consumer, red };
  }

  // Case 1 — default policy ON (crossBranchRedemption=true): scan at B works.
  const case1 = await fundAndRedeem(branchA.id, '100');
  await assert('case1: initiate succeeded at branch A', case1.red.success === true,
    `msg=${case1.red.message}`);
  const scan1 = await processRedemption({
    token: case1.red.token!,
    cashierStaffId: cashier.id,
    cashierTenantId: tenant.id,
    branchId: branchB.id,
  });
  await assert('case1: default policy allows cross-branch scan (B)',
    scan1.success === true, `msg=${scan1.message}`);

  // Flip the policy OFF
  const putRes = await fetch(`${API}/api/merchant/settings`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ crossBranchRedemption: false }),
  });
  await assert('PUT /settings accepts crossBranchRedemption=false',
    putRes.status === 200, `status=${putRes.status}`);
  const getRes = await fetch(`${API}/api/merchant/settings`, {
    headers: { 'Authorization': `Bearer ${ownerToken}` },
  });
  const getBody: any = await getRes.json();
  await assert('GET /settings echoes crossBranchRedemption=false',
    getBody.crossBranchRedemption === false,
    `crossBranchRedemption=${getBody.crossBranchRedemption}`);

  // Case 2 — policy OFF: scan at B must fail, scan at A must succeed.
  const case2 = await fundAndRedeem(branchA.id, '100');
  await assert('case2: initiate succeeded at branch A',
    case2.red.success === true, `msg=${case2.red.message}`);
  const scan2B = await processRedemption({
    token: case2.red.token!,
    cashierStaffId: cashier.id,
    cashierTenantId: tenant.id,
    branchId: branchB.id,
  });
  await assert('case2: cross-branch scan at B is REJECTED',
    scan2B.success === false, `msg=${scan2B.message}`);
  await assert('case2: rejection message names the origin branch',
    /Valencia/.test(scan2B.message || ''), `msg=${scan2B.message}`);

  const scan2A = await processRedemption({
    token: case2.red.token!,
    cashierStaffId: cashier.id,
    cashierTenantId: tenant.id,
    branchId: branchA.id,
  });
  await assert('case2: same-branch scan at A SUCCEEDS',
    scan2A.success === true, `msg=${scan2A.message}`);

  // Case 3 — policy OFF, but pending entry had no branch (legacy): still passes
  const case3 = await fundAndRedeem('' as any, '100');
  // When branchId is empty string coerced to null, pending entry has branchId=null;
  // the check lets it through because the rule requires BOTH sides explicit.
  await assert('case3: initiate succeeded with no origin branch',
    case3.red.success === true, `msg=${case3.red.message}`);
  const scan3B = await processRedemption({
    token: case3.red.token!,
    cashierStaffId: cashier.id,
    cashierTenantId: tenant.id,
    branchId: branchB.id,
  });
  await assert('case3: legacy no-branch entry is allowed through (graceful)',
    scan3B.success === true, `msg=${scan3B.message}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
