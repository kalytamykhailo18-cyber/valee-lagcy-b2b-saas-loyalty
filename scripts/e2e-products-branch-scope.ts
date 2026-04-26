/**
 * E2E for Eric's 2026-04-24 ask:
 *
 *   "No hay logica multisucursal en productos ... al crear un nuevo producto
 *    no tengo manera de seleccionar a que sucursal voy a agregar ese
 *    producto. Con un solo selector para elegir sucursal es mas que
 *    suficiente."
 *
 * Verifies the end-to-end chain:
 *   (1) POST /api/merchant/products stores the chosen branchId (valid &
 *       scoped to the caller's tenant).
 *   (2) Forging another tenant's branch UUID is rejected 400.
 *   (3) GET /api/merchant/products returns branchId + branchName.
 *   (4) PUT /api/merchant/products/:id reassigns branch (and can clear to
 *       tenant-wide with branchId: null).
 *   (5) GET /api/consumer/catalog:
 *        - no branchId query → only tenant-wide products
 *        - branchId=A → tenant-wide + branch A products, NOT branch B's
 *   (6) Tenant isolation: a product created under Tenant A must not be
 *       visible to Tenant B even when B happens to have a branch of the
 *       same id-shape.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { issueConsumerTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  let body: any = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

function issueStaffToken(staffId: string, tenantId: string, role: 'owner' | 'cashier') {
  return jwt.sign(
    { staffId, tenantId, role, type: 'staff' },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );
}

async function main() {
  console.log('=== Products branch scope E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();

  // Tenant A with two branches
  const tenantA = await createTenant(`Prod Scope A ${ts}`, `prod-scope-a-${ts}`, `prod-scope-a-${ts}@e2e.local`);
  await createSystemAccounts(tenantA.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenantA.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const branchA1 = await prisma.branch.create({ data: { tenantId: tenantA.id, name: 'Sucursal Centro', active: true } });
  const branchA2 = await prisma.branch.create({ data: { tenantId: tenantA.id, name: 'Sucursal Norte', active: true } });

  // Owner to call merchant routes
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenantA.id, name: 'Owner A', email: `owner-a-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffToken(owner.id, tenantA.id, 'owner');

  // Tenant B — used to attempt cross-tenant forgery
  const tenantB = await createTenant(`Prod Scope B ${ts}`, `prod-scope-b-${ts}`, `prod-scope-b-${ts}@e2e.local`);
  await createSystemAccounts(tenantB.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenantB.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const branchB = await prisma.branch.create({ data: { tenantId: tenantB.id, name: 'Sucursal B', active: true } });

  // (1) Create a product tied to branchA1
  const createRes = await http('/api/merchant/products', ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      name: `Cafe Centro ${ts}`, description: 'solo en centro',
      redemptionCost: '100', assetTypeId: asset.id,
      stock: 10, branchId: branchA1.id,
    }),
  });
  await assert('POST product with branchId succeeds',
    createRes.status === 200 && createRes.body.product?.branchId === branchA1.id,
    `status=${createRes.status} branchId=${createRes.body.product?.branchId}`);
  const prodBranch1Id = createRes.body.product.id;

  // Another product tied to branchA2
  const createRes2 = await http('/api/merchant/products', ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      name: `Sandwich Norte ${ts}`,
      redemptionCost: '150', assetTypeId: asset.id,
      stock: 10, branchId: branchA2.id,
    }),
  });
  await assert('POST second product tied to another branch',
    createRes2.status === 200 && createRes2.body.product?.branchId === branchA2.id,
    `branchId=${createRes2.body.product?.branchId}`);
  const prodBranch2Id = createRes2.body.product.id;

  // Tenant-wide product (no branchId)
  const createResWide = await http('/api/merchant/products', ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      name: `Postre Global ${ts}`,
      redemptionCost: '50', assetTypeId: asset.id,
      stock: 10,
    }),
  });
  await assert('POST tenant-wide product (no branchId) returns branchId=null',
    createResWide.status === 200 && createResWide.body.product?.branchId === null,
    `branchId=${createResWide.body.product?.branchId}`);
  const prodWideId = createResWide.body.product.id;

  // (2) Forging tenant B's branch → 400
  const forge = await http('/api/merchant/products', ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      name: `Fraud ${ts}`, redemptionCost: '10', assetTypeId: asset.id,
      stock: 1, branchId: branchB.id,
    }),
  });
  await assert('branchId from another tenant is rejected 400',
    forge.status === 400, `status=${forge.status}`);

  // (3) GET list includes branchId + branchName
  const listRes = await http('/api/merchant/products', ownerToken);
  const listed = (listRes.body.products || []).find((x: any) => x.id === prodBranch1Id);
  await assert('GET products returns branchId and branchName',
    !!listed && listed.branchId === branchA1.id && listed.branchName === 'Sucursal Centro',
    `branchId=${listed?.branchId} branchName=${listed?.branchName}`);

  // (4) PUT reassigns branch, and branchId:null clears it
  const reassign = await http(`/api/merchant/products/${prodBranch1Id}`, ownerToken, {
    method: 'PUT',
    body: JSON.stringify({ branchId: branchA2.id }),
  });
  await assert('PUT reassigns branchId to another branch of same tenant',
    reassign.status === 200 && reassign.body.product?.branchId === branchA2.id,
    `branchId=${reassign.body.product?.branchId}`);

  const clearRes = await http(`/api/merchant/products/${prodBranch1Id}`, ownerToken, {
    method: 'PUT',
    body: JSON.stringify({ branchId: null }),
  });
  await assert('PUT branchId:null clears scope to tenant-wide',
    clearRes.status === 200 && clearRes.body.product?.branchId === null,
    `branchId=${clearRes.body.product?.branchId}`);

  // Put it back to branchA1 for the catalog assertions that follow.
  await http(`/api/merchant/products/${prodBranch1Id}`, ownerToken, {
    method: 'PUT',
    body: JSON.stringify({ branchId: branchA1.id }),
  });

  // PUT with other-tenant branch must also be rejected.
  const putForge = await http(`/api/merchant/products/${prodBranch1Id}`, ownerToken, {
    method: 'PUT',
    body: JSON.stringify({ branchId: branchB.id }),
  });
  await assert('PUT branchId from another tenant is rejected 400',
    putForge.status === 400, `status=${putForge.status}`);

  // (5) Consumer catalog filtering
  const phone = `+19603${String(ts).slice(-7)}`;
  const { account } = await findOrCreateConsumerAccount(tenantA.id, phone);
  const consumerToken = issueConsumerTokens({
    accountId: account.id, tenantId: tenantA.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;

  // No branchId → only tenant-wide products
  const catNoBranch = await http('/api/consumer/catalog', consumerToken);
  const idsNoBranch = new Set((catNoBranch.body.products || []).map((p: any) => p.id));
  await assert('consumer catalog with NO branchId shows only tenant-wide products',
    idsNoBranch.has(prodWideId) && !idsNoBranch.has(prodBranch1Id) && !idsNoBranch.has(prodBranch2Id),
    `ids=${[...idsNoBranch]}`);

  // branchId=A1 → tenant-wide + branchA1 products only
  const catA1 = await http(`/api/consumer/catalog?branchId=${branchA1.id}`, consumerToken);
  const idsA1 = new Set((catA1.body.products || []).map((p: any) => p.id));
  await assert('consumer catalog with branchId=A1 shows tenant-wide + A1 but NOT A2',
    idsA1.has(prodWideId) && idsA1.has(prodBranch1Id) && !idsA1.has(prodBranch2Id),
    `ids=${[...idsA1]}`);

  // branchId=A2 → tenant-wide + branchA2 products only
  const catA2 = await http(`/api/consumer/catalog?branchId=${branchA2.id}`, consumerToken);
  const idsA2 = new Set((catA2.body.products || []).map((p: any) => p.id));
  await assert('consumer catalog with branchId=A2 shows tenant-wide + A2 but NOT A1',
    idsA2.has(prodWideId) && idsA2.has(prodBranch2Id) && !idsA2.has(prodBranch1Id),
    `ids=${[...idsA2]}`);

  // (6) Cross-tenant isolation: consumer under tenantB must not see any of A's products
  const { account: accountB } = await findOrCreateConsumerAccount(tenantB.id, phone);
  const consumerTokenB = issueConsumerTokens({
    accountId: accountB.id, tenantId: tenantB.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;
  const catB = await http('/api/consumer/catalog', consumerTokenB);
  const idsB = new Set((catB.body.products || []).map((p: any) => p.id));
  await assert('tenant B consumer does NOT see tenant A products',
    !idsB.has(prodWideId) && !idsB.has(prodBranch1Id) && !idsB.has(prodBranch2Id),
    `ids=${[...idsB]}`);

  // Passing A1's branch id from tenant B's context must be ignored (branch
  // won't resolve under B), so the consumer still only sees B-wide items.
  const catBSpoof = await http(`/api/consumer/catalog?branchId=${branchA1.id}`, consumerTokenB);
  const idsBSpoof = new Set((catBSpoof.body.products || []).map((p: any) => p.id));
  await assert('tenant B consumer cannot peek A1 products by forging branchId',
    !idsBSpoof.has(prodBranch1Id),
    `ids=${[...idsBSpoof]}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
