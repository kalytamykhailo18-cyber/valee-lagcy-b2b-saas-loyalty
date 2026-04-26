/**
 * E2E for Eric's 2026-04-24 ask:
 *
 *   "Logica multisucursal en panel principal de transacciones."
 *   Screenshot shows: transactions list does not expose a branch label
 *   per row, and the branch filter only knows Todas / <branch>. Welcome
 *   bonus rows in particular come through with branch_id=NULL so even
 *   when a user lands via a branch QR the panel has no attribution.
 *
 * This verifies:
 *   (1) grantWelcomeBonus stamps branch_id on the ledger entries when the
 *       caller supplies one (WhatsApp path receives params.branchId).
 *   (2) Without a branch context, the welcome entry still writes with
 *       branch_id=NULL — surfaced by the UI as "Sin sucursal".
 *   (3) GET /api/merchant/transactions?branchId=<uuid> filters the list
 *       to that branch only.
 *   (4) GET /api/merchant/transactions?branchId=_unassigned returns only
 *       rows with branch_id IS NULL (no UUID cast error).
 *   (5) Each row's branchName field mirrors the stamped branch (or null).
 *   (6) Consumer OTP login path inherits branchId from a recent
 *       merchantScanSession window.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { grantWelcomeBonus } from '../src/services/welcome-bonus.js';
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
  console.log('=== Transactions branch logic E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();

  const tenant = await createTenant(`Tx Branch ${ts}`, `tx-branch-${ts}`, `tx-branch-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({ data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 }});
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusAmount: 500 }});

  const branch1 = await prisma.branch.create({ data: { tenantId: tenant.id, name: 'Sucursal Centro', active: true } });
  const branch2 = await prisma.branch.create({ data: { tenantId: tenant.id, name: 'Sucursal Norte',  active: true } });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `owner-tx-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const tok = ownerToken(owner.id, tenant.id);

  // Consumer A: first contact via branch1 — grantWelcomeBonus with branchId
  const phoneA = `+19610${String(ts).slice(-7)}`;
  const { account: accA } = await findOrCreateConsumerAccount(tenant.id, phoneA);
  await grantWelcomeBonus(accA.id, tenant.id, asset.id, branch1.id);

  // Consumer B: first contact via branch2
  const phoneB = `+19611${String(ts).slice(-7)}`;
  const { account: accB } = await findOrCreateConsumerAccount(tenant.id, phoneB);
  await grantWelcomeBonus(accB.id, tenant.id, asset.id, branch2.id);

  // Consumer C: first contact with NO branch context (tenant-wide fallback)
  const phoneC = `+19612${String(ts).slice(-7)}`;
  const { account: accC } = await findOrCreateConsumerAccount(tenant.id, phoneC);
  await grantWelcomeBonus(accC.id, tenant.id, asset.id, null);

  // (1) Ledger row for A carries branch1.id
  const ledgerA = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, accountId: accA.id, eventType: 'ADJUSTMENT_MANUAL' },
    orderBy: { createdAt: 'desc' },
  });
  await assert('welcome bonus ledger row stamped with branchId when passed',
    !!ledgerA && ledgerA!.branchId === branch1.id,
    `branchId=${ledgerA?.branchId}`);

  // (2) Ledger row for C has branchId = null
  const ledgerC = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, accountId: accC.id, eventType: 'ADJUSTMENT_MANUAL' },
    orderBy: { createdAt: 'desc' },
  });
  await assert('welcome bonus without branch context remains branchId=null',
    !!ledgerC && ledgerC!.branchId === null,
    `branchId=${ledgerC?.branchId}`);

  // (3) /transactions?branchId=<branch1> returns only A's row, with branchName set
  const list1 = await http(`/api/merchant/transactions?branchId=${branch1.id}&limit=200`, tok);
  const entries1 = list1.body.entries || [];
  const accIdsIn1 = new Set(entries1.map((e: any) => e.accountPhone));
  await assert('filter by branch1 includes consumer A and NOT B or C',
    accIdsIn1.has(phoneA) && !accIdsIn1.has(phoneB) && !accIdsIn1.has(phoneC),
    `phones=${[...accIdsIn1]}`);
  const aRow = entries1.find((e: any) => e.accountPhone === phoneA);
  await assert('branchName on the returned row matches the stamped branch',
    !!aRow && aRow.branchName === 'Sucursal Centro',
    `branchName=${aRow?.branchName}`);

  // (4) _unassigned filter returns only rows with branch_id IS NULL
  const listU = await http(`/api/merchant/transactions?branchId=_unassigned&limit=200`, tok);
  const entriesU = listU.body.entries || [];
  const phonesU = new Set(entriesU.map((e: any) => e.accountPhone));
  await assert('_unassigned filter isolates the no-branch consumer',
    phonesU.has(phoneC) && !phonesU.has(phoneA) && !phonesU.has(phoneB),
    `phones=${[...phonesU]}`);
  const uRow = entriesU.find((e: any) => e.accountPhone === phoneC);
  await assert('_unassigned rows report branchName=null',
    !!uRow && uRow.branchName === null,
    `branchName=${uRow?.branchName}`);

  // (5) Unfiltered list returns all three, and every row exposes a
  //     branchName field (null or a string — never missing).
  const listAll = await http(`/api/merchant/transactions?limit=200`, tok);
  const entriesAll = listAll.body.entries || [];
  const everyHasField = entriesAll.every((e: any) =>
    Object.prototype.hasOwnProperty.call(e, 'branchName')
  );
  await assert('every row in the unfiltered list exposes a branchName field',
    everyHasField, `n=${entriesAll.length}`);

  // (6) OTP login path: prime a merchantScanSession on phoneD, hit
  //     verify-otp, assert the welcome bonus inherited that branch.
  const phoneD = `+19613${String(ts).slice(-7)}`;
  await prisma.merchantScanSession.create({
    data: { tenantId: tenant.id, consumerPhone: phoneD, branchId: branch2.id },
  });
  const { generateOTP } = await import('../src/services/auth.js');
  const otp = await generateOTP(phoneD);
  const verifyRes = await fetch(`${API}/api/consumer/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phoneD, otp, tenantSlug: tenant.slug }),
  });
  const verifyBody = await verifyRes.json().catch(() => null);
  await assert('OTP verify succeeds',
    verifyRes.status === 200 && verifyBody?.success,
    `status=${verifyRes.status}`);
  // Welcome bonus ledger row for phoneD should carry branch2.id
  const accD = await prisma.account.findFirst({
    where: { tenantId: tenant.id, phoneNumber: phoneD },
  });
  const ledgerD = accD
    ? await prisma.ledgerEntry.findFirst({
        where: { tenantId: tenant.id, accountId: accD.id, eventType: 'ADJUSTMENT_MANUAL' },
        orderBy: { createdAt: 'desc' },
      })
    : null;
  await assert('OTP login inherits branchId from recent scan session',
    !!ledgerD && ledgerD!.branchId === branch2.id,
    `branchId=${ledgerD?.branchId}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
