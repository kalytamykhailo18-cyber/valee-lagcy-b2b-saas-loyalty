/**
 * E2E: referral bonus is credited when a pending_validation invoice is
 * confirmed via CSV upload (the path that was previously broken).
 *
 * Flow:
 *   1. Create referrer + referee under the smoke-test tenant
 *   2. Record a pending referral (referrer → referee)
 *   3. Simulate the "no CSV yet" case: create a pending_validation invoice
 *      with a provisional PROVISIONAL ledger entry for the referee
 *   4. Assert referral row is still pending and referrer balance is 0
 *   5. Run a CSV upload that contains the matching invoice number
 *   6. Assert referral row flips to credited, referrer balance == bonus amount
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { recordPendingReferral } from '../src/services/referrals.js';
import { writeDoubleEntry, getAccountBalance } from '../src/services/ledger.js';
import { processCSV } from '../src/services/csv-upload.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: 'smoke-test' } });
  if (!tenant) throw new Error('smoke-test tenant missing');

  const cfg = await prisma.tenantAssetConfig.findFirst({ where: { tenantId: tenant.id } });
  if (!cfg) throw new Error('smoke-test tenant has no asset config');
  const assetTypeId = cfg.assetTypeId;

  const pool = await getSystemAccount(tenant.id, 'issued_value_pool');
  if (!pool) throw new Error('pool account missing');

  const ts = Date.now();
  const referrerPhone = `+19700${String(ts + 1).slice(-7)}`;
  const refereePhone  = `+19700${String(ts + 2).slice(-7)}`;
  const { account: referrer } = await findOrCreateConsumerAccount(tenant.id, referrerPhone);
  const { account: referee }  = await findOrCreateConsumerAccount(tenant.id, refereePhone);

  // Step 1: record pending referral
  const pending = await recordPendingReferral({
    tenantId: tenant.id, referrerAccountId: referrer.id, refereeAccountId: referee.id,
  });
  await assert('referral recorded', !!pending.recorded, JSON.stringify(pending));

  // Step 2: simulate pending_validation invoice with PROVISIONAL ledger entry
  const invoiceNumber = `E2E-REF-${ts}`;
  const amount = '100.00000000';
  const provisional = await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id,
    creditAccountId: referee.id,
    amount,
    assetTypeId,
    referenceId: `PENDING-${invoiceNumber}`,
    referenceType: 'invoice',
    status: 'provisional',
    metadata: { invoiceNumber, source: 'e2e_provisional' },
  });
  const invoice = await prisma.invoice.create({
    data: {
      tenantId: tenant.id,
      invoiceNumber,
      amount,
      status: 'pending_validation',
      source: 'photo_submission',
      consumerAccountId: referee.id,
      ledgerEntryId: provisional.credit.id,
    },
  });
  await assert('pending invoice created', invoice.status === 'pending_validation', `id=${invoice.id.slice(0,8)}`);

  // Step 3: referral row still pending, referrer balance still 0
  const refRowBefore = await prisma.referral.findUnique({ where: { id: pending.recorded ? (await prisma.referral.findFirst({ where: { tenantId: tenant.id, refereeAccountId: referee.id } }))!.id : '' } });
  await assert('referral still pending before CSV', refRowBefore?.status === 'pending', `status=${refRowBefore?.status}`);
  const referrerBalBefore = await getAccountBalance(referrer.id, assetTypeId, tenant.id);
  await assert('referrer balance 0 before CSV', Number(referrerBalBefore) === 0, `balance=${referrerBalBefore}`);

  // Step 4: run CSV upload with matching invoice number (the exact case that
  // was previously broken — existingPending branch in csv-upload.ts now calls
  // tryCreditReferral).
  const staff = await prisma.staff.findFirst({ where: { tenantId: tenant.id, role: 'owner' } })
    || await prisma.staff.findFirst({ where: { tenantId: tenant.id } });
  if (!staff) throw new Error('smoke-test tenant has no staff row');

  const csv = `invoice_number,amount,date\n${invoiceNumber},100.00,2026-04-19\n`;
  const result = await processCSV(csv, tenant.id, staff.id);
  await assert('CSV processed', result.rowsLoaded >= 0 && result.rowsErrored === 0,
    `loaded=${result.rowsLoaded} skipped=${result.rowsSkipped} errored=${result.rowsErrored}`);

  // Step 5: invoice now claimed, referral credited, referrer bonus posted
  const invoiceAfter = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  await assert('invoice flipped to claimed', invoiceAfter?.status === 'claimed', `status=${invoiceAfter?.status}`);

  const refRowAfter = await prisma.referral.findFirst({
    where: { tenantId: tenant.id, refereeAccountId: referee.id },
  });
  await assert('referral flipped to credited', refRowAfter?.status === 'credited',
    `status=${refRowAfter?.status} amount=${refRowAfter?.bonusAmount}`);

  const referrerBalAfter = await getAccountBalance(referrer.id, assetTypeId, tenant.id);
  await assert('referrer balance equals bonus', Number(referrerBalAfter) > 0,
    `balance=${referrerBalAfter} expected=${refRowAfter?.bonusAmount}`);
  await assert('referrer balance == bonus amount',
    Number(referrerBalAfter) === Number(refRowAfter?.bonusAmount || 0),
    `balance=${referrerBalAfter} bonus=${refRowAfter?.bonusAmount}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
