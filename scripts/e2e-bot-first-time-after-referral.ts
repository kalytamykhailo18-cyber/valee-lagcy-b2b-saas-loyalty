/**
 * E2E: a user scanning a referral QR for the first time gets the
 * first_time warm welcome, NOT the "registered_never_scanned" copy.
 *
 * Eric 2026-04-23 Notion "Bot de whatsaap": a fresh phone scanning
 * Eric's referral QR at Kromi got this greeting:
 *   "¡Hola! Te registraste hace un tiempo pero aun no has ganado
 *    puntos. Es muy facil: la proxima vez que compres..."
 * ...despite being a BRAND NEW user arriving via a referral. The
 * cause was webhook.ts creating the account + granting the welcome
 * bonus before handleIncomingMessage ran, so detectConversationState
 * saw "account exists + 0 INVOICE_CLAIMED" and returned
 * registered_never_scanned. The welcome bonus is an ADJUSTMENT_MANUAL
 * row so it didn't satisfy the INVOICE_CLAIMED filter.
 *
 * Fix: treat an account younger than 2h with no claims as first_time.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { detectConversationState } from '../src/services/whatsapp-bot.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Bot first_time after referral E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Bot FT ${ts}`, `bot-ft-${ts}`, `bot-ft-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  // ── Case A: fresh account, no claims, no welcome → first_time
  //    (pure no-account path already covered — this verifies the
  //    new "just arrived" branch.)
  const phoneFresh = `+58414${String(ts).slice(-7, -4)}101`;
  const { account: fresh } = await findOrCreateConsumerAccount(tenant.id, phoneFresh);
  const stateFresh = await detectConversationState(phoneFresh, tenant.id);
  await assert('brand new account → first_time',
    stateFresh.state === 'first_time' && stateFresh.accountId === fresh.id,
    `state=${stateFresh.state} accountId=${stateFresh.accountId}`);

  // ── Case B: account created a moment ago + welcome bonus credited
  //    (the Eric scenario). Still first_time.
  const phoneReferred = `+58414${String(ts).slice(-7, -4)}102`;
  const { account: referred } = await findOrCreateConsumerAccount(tenant.id, phoneReferred);
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id, creditAccountId: referred.id,
    amount: '100', assetTypeId: asset.id,
    referenceId: `WELCOME-${referred.id}`,
    referenceType: 'manual_adjustment',
    metadata: { type: 'welcome_bonus', amount: '100' },
  });
  const stateReferred = await detectConversationState(phoneReferred, tenant.id);
  await assert('fresh account with welcome bonus + no claims → first_time',
    stateReferred.state === 'first_time',
    `state=${stateReferred.state}`);

  // ── Case C: account older than 2h with no claims → registered_never_scanned
  //    Simulated by rewinding createdAt on the account row.
  const phoneOld = `+58414${String(ts).slice(-7, -4)}103`;
  const { account: old } = await findOrCreateConsumerAccount(tenant.id, phoneOld);
  const longAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await prisma.account.update({
    where: { id: old.id },
    data: { createdAt: longAgo },
  });
  const stateOld = await detectConversationState(phoneOld, tenant.id);
  await assert('old account with no claims → registered_never_scanned',
    stateOld.state === 'registered_never_scanned',
    `state=${stateOld.state}`);

  // ── Case D: account with a real INVOICE_CLAIMED → NOT first_time
  //    (sanity — the window heuristic only kicks in for zero-claim
  //    accounts; a real invoice credit immediately flips the state
  //    off first_time. Ledger is append-only so we can't rewind
  //    timestamps; we just verify the state leaves first_time once
  //    a claim is written, without caring about the exact downstream
  //    branch between active_purchase vs returning_with_history.)
  const phoneReturning = `+58414${String(ts).slice(-7, -4)}104`;
  const { account: returning } = await findOrCreateConsumerAccount(tenant.id, phoneReturning);
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: returning.id,
    amount: '200', assetTypeId: asset.id,
    referenceId: `SEED-INV-${ts}`,
    referenceType: 'invoice',
    metadata: { type: 'seed' },
  });
  const stateReturning = await detectConversationState(phoneReturning, tenant.id);
  await assert('account with INVOICE_CLAIMED is no longer first_time',
    stateReturning.state !== 'first_time' && stateReturning.state !== 'registered_never_scanned',
    `state=${stateReturning.state}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
