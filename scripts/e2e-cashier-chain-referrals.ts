/**
 * E2E for Genesis's 2026-04-24 report:
 *
 *   "Al entrar en cajero donde deberian salir las metricas del cajero no
 *    aparecen las metricas — ese cajero, a traves del codigo de referido
 *    de una persona, logro que otra persona escaneara una factura."
 *
 * Chain scenario:
 *   1. Consumer A scans cashier's QR (StaffScanSession recorded).
 *   2. Consumer A shares referral code → Consumer B scans referral.
 *   3. Consumer B validates an invoice.
 *   4. tryCreditReferral fires → REFERRAL_BONUS written for A.
 *   5. staff-performance now shows the cashier with 1 transaction
 *      (chain-attributed via referrals.originStaffId).
 *
 * Also covers:
 *   - direct attribution still works (cashier's own invoice row counted).
 *   - historic referrals written before this migration (no staffId in
 *     ledger metadata, but origin_staff_id populated by the backfill)
 *     still surface in the performance metrics.
 *   - if the referrer never scanned a cashier's QR, the referral bonus
 *     is not attributed to anyone (no phantom counts).
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { recordPendingReferral, tryCreditReferral } from '../src/services/referrals.js';
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
  console.log('=== Cashier chain-referral metrics E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Chain ${ts}`, `chain-${ts}`, `chain-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({ where: { id: tenant.id }, data: { referralBonusAmount: 200 }});

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `owner-chain-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cajera Eric', email: `cashier-chain-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
      qrSlug: `chn${String(ts).slice(-5)}`, active: true,
    },
  });
  const tok = ownerToken(owner.id, tenant.id);

  // ------------------------------------------------------------------
  // Scenario 1: Chain referral attributed to cashier via StaffScanSession
  // ------------------------------------------------------------------
  const phoneA = `+19700${String(ts).slice(-7)}`;
  const phoneB = `+19701${String(ts).slice(-7)}`;
  const { account: accA } = await findOrCreateConsumerAccount(tenant.id, phoneA);
  const { account: accB } = await findOrCreateConsumerAccount(tenant.id, phoneB);

  // A scanned cashier's QR at some point
  await prisma.staffScanSession.create({
    data: { tenantId: tenant.id, staffId: cashier.id, consumerPhone: phoneA },
  });

  // A shared referral with B — record the pending row now. originStaffId
  // should resolve to the cashier via the scan session.
  const rec = await recordPendingReferral({
    tenantId: tenant.id,
    referrerAccountId: accA.id,
    refereeAccountId: accB.id,
  });
  await assert('recordPendingReferral resolves originStaffId from scan session',
    rec.recorded === true, `reason=${rec.reason}`);
  const persisted = await prisma.referral.findFirst({
    where: { tenantId: tenant.id, refereeAccountId: accB.id },
    select: { originStaffId: true },
  });
  await assert('Referral row persists originStaffId = cashier.id',
    persisted?.originStaffId === cashier.id,
    `originStaffId=${persisted?.originStaffId}`);

  // B validates an invoice (simulate via direct credit — attribution on
  // B's invoice is independent of chain logic).
  const pool = await getSystemAccount(tenant.id, 'issued_value_pool');
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool!.id,
    creditAccountId: accB.id,
    amount: '500.00000000',
    assetTypeId: asset.id,
    referenceId: `INV-${ts}-B`,
    referenceType: 'invoice',
  });

  // Credit the referral — REFERRAL_BONUS ledger row for A with
  // metadata.staffId = cashier.id.
  const credit = await tryCreditReferral({
    tenantId: tenant.id,
    refereeAccountId: accB.id,
    assetTypeId: asset.id,
  });
  await assert('tryCreditReferral credited successfully',
    credit.credited === true, `amount=${credit.amount}`);

  // Verify the stamp landed on the ledger row.
  const refRow = await prisma.ledgerEntry.findFirst({
    where: {
      tenantId: tenant.id,
      eventType: 'ADJUSTMENT_MANUAL',
      accountId: accA.id,
    },
    orderBy: { createdAt: 'desc' },
  });
  const refMeta = (refRow?.metadata as any) || {};
  await assert('REFERRAL_BONUS ledger row carries metadata.staffId = cashier',
    refMeta.staffId === cashier.id,
    `staffId=${refMeta.staffId}`);

  // Hit staff-performance — cashier should appear with 1 transaction (the
  // referral bonus). The direct invoice on phoneB has no staffId so it
  // doesn't count here.
  const perf = await http('/api/merchant/staff-performance?days=30', tok);
  const row = (perf.body.staff || []).find((r: any) => r.staffId === cashier.id);
  await assert('staff-performance surfaces cashier via chain-referral attribution',
    !!row && row.transactions === 1,
    `row=${JSON.stringify(row)}`);

  // ------------------------------------------------------------------
  // Scenario 2: referrer with no cashier scan → no phantom attribution
  // ------------------------------------------------------------------
  const phoneC = `+19702${String(ts).slice(-7)}`;
  const phoneD = `+19703${String(ts).slice(-7)}`;
  const { account: accC } = await findOrCreateConsumerAccount(tenant.id, phoneC);
  const { account: accD } = await findOrCreateConsumerAccount(tenant.id, phoneD);
  // C never scanned the cashier.
  const rec2 = await recordPendingReferral({
    tenantId: tenant.id,
    referrerAccountId: accC.id,
    refereeAccountId: accD.id,
  });
  await assert('unrelated referral records successfully',
    rec2.recorded === true, `reason=${rec2.reason}`);
  const persisted2 = await prisma.referral.findFirst({
    where: { tenantId: tenant.id, refereeAccountId: accD.id },
    select: { originStaffId: true },
  });
  await assert('no staff scan => originStaffId remains NULL',
    persisted2?.originStaffId === null,
    `originStaffId=${persisted2?.originStaffId}`);

  // Seed D's invoice + credit referral
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool!.id,
    creditAccountId: accD.id,
    amount: '500.00000000',
    assetTypeId: asset.id,
    referenceId: `INV-${ts}-D`,
    referenceType: 'invoice',
  });
  await tryCreditReferral({ tenantId: tenant.id, refereeAccountId: accD.id, assetTypeId: asset.id });

  // Cashier's metric must NOT jump to 2 from this unrelated referral.
  const perf2 = await http('/api/merchant/staff-performance?days=30', tok);
  const row2 = (perf2.body.staff || []).find((r: any) => r.staffId === cashier.id);
  await assert('unrelated referral does not inflate the cashier metric',
    !!row2 && row2.transactions === 1,
    `transactions=${row2?.transactions}`);

  // ------------------------------------------------------------------
  // Scenario 3: Direct invoice attribution still counts
  // ------------------------------------------------------------------
  const phoneE = `+19704${String(ts).slice(-7)}`;
  const { account: accE } = await findOrCreateConsumerAccount(tenant.id, phoneE);
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool!.id,
    creditAccountId: accE.id,
    amount: '300.00000000',
    assetTypeId: asset.id,
    referenceId: `INV-${ts}-E`,
    referenceType: 'invoice',
    metadata: { staffId: cashier.id },
  });
  const perf3 = await http('/api/merchant/staff-performance?days=30', tok);
  const row3 = (perf3.body.staff || []).find((r: any) => r.staffId === cashier.id);
  await assert('direct invoice attribution ALSO counts in the same row',
    !!row3 && row3.transactions === 2,
    `transactions=${row3?.transactions}`);

  // ------------------------------------------------------------------
  // Scenario 4: Historic referral (no metadata.staffId but origin_staff_id set)
  //             surfaces via the retroactive UNION branch.
  // ------------------------------------------------------------------
  const phoneF = `+19705${String(ts).slice(-7)}`;
  const phoneG = `+19706${String(ts).slice(-7)}`;
  const { account: accF } = await findOrCreateConsumerAccount(tenant.id, phoneF);
  const { account: accG } = await findOrCreateConsumerAccount(tenant.id, phoneG);
  // Simulate a historic referral: insert directly with origin_staff_id and
  // write the referral bonus WITHOUT metadata.staffId (mimicking pre-fix).
  const histRef = await prisma.referral.create({
    data: {
      tenantId: tenant.id,
      referrerAccountId: accF.id,
      refereeAccountId: accG.id,
      originStaffId: cashier.id,
      status: 'pending',
    },
  });
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool!.id,
    creditAccountId: accF.id,
    amount: '200.00000000',
    assetTypeId: asset.id,
    referenceId: `REFERRAL-${histRef.id}`,
    referenceType: 'manual_adjustment',
    metadata: { type: 'referral_bonus', referralId: histRef.id }, // no staffId
  });
  const perf4 = await http('/api/merchant/staff-performance?days=30', tok);
  const row4 = (perf4.body.staff || []).find((r: any) => r.staffId === cashier.id);
  await assert('historic referral (no ledger staffId) surfaces via originStaffId join',
    !!row4 && row4.transactions === 3,
    `transactions=${row4?.transactions}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
