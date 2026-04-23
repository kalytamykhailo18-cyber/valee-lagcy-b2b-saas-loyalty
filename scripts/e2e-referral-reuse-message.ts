/**
 * E2E: a referee re-scanning the same referral code gets a clear
 * "already used" message from the bot.
 *
 * Genesis 2026-04-23: she scanned Eric's Ref2U: code three times at
 * Farmatodo and the bot responded with the identical "Acabas de
 * visitar" message on every rescan, making it look like the code
 * was infinitely reusable for the same person. The referral row
 * is recorded only once on the backend (anti-fraud guard), but the
 * UX pretended otherwise.
 *
 * This test proves:
 *   1. First scan of Eric's code by a fresh referee: referral row
 *      is created with status=pending, bot sends the normal greeting.
 *   2. Second scan by the same referee: referral row is NOT duplicated,
 *      and the bot response prepends the "ya lo usaste" line.
 *   3. Third scan: same as second, still prepends (idempotent).
 *   4. A DIFFERENT fresh referee scanning the same code still creates
 *      a new pending referral row — the limit is per-(code, referee),
 *      not per-code-globally.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { ensureReferralSlug, recordPendingReferral } from '../src/services/referrals.js';
import { handleIncomingMessage } from '../src/services/whatsapp-bot.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Referral rescan bot message E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Ref Rescan ${ts}`, `ref-rescan-${ts}`, `ref-rescan-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  // Referrer (Eric) — has a referral slug at this tenant
  const ericPhone = `+58414${String(ts).slice(-7, -4)}001`;
  const { account: eric } = await findOrCreateConsumerAccount(tenant.id, ericPhone);
  const slug = await ensureReferralSlug(eric.id);

  // Fresh referee (Genesis-A) — has no activity anywhere yet
  const refPhone = `+58414${String(ts).slice(-7, -4)}002`;

  // ── Scan #1: fresh. A pending referral gets recorded.
  const msgs1 = await handleIncomingMessage({
    phoneNumber: refPhone,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: `Hola! Me invitaron a X en Valee Ref: ${tenant.slug} Ref2U: ${slug}`,
    referralAlreadyUsed: false,
  });
  // After handleIncomingMessage the account exists — simulate the webhook
  // step that recorded the referral upstream.
  const { account: genA } = await findOrCreateConsumerAccount(tenant.id, refPhone);
  const firstRecord = await recordPendingReferral({
    tenantId: tenant.id, referrerAccountId: eric.id, refereeAccountId: genA.id,
  });
  await assert('first scan records a pending referral',
    firstRecord.recorded === true,
    `recorded=${firstRecord.recorded}`);
  await assert('first-scan bot response does NOT prepend "ya lo usaste"',
    !msgs1.some(m => m.toLowerCase().includes('ya lo usaste')),
    `msgs=${JSON.stringify(msgs1)}`);

  // ── Scan #2: same phone. Referral already exists → reason=already_referred.
  const secondRecord = await recordPendingReferral({
    tenantId: tenant.id, referrerAccountId: eric.id, refereeAccountId: genA.id,
  });
  await assert('second scan returns already_referred (no duplicate row)',
    secondRecord.recorded === false && secondRecord.reason === 'already_referred',
    `reason=${secondRecord.reason}`);

  const msgs2 = await handleIncomingMessage({
    phoneNumber: refPhone,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: `Hola! Me invitaron a X en Valee Ref: ${tenant.slug} Ref2U: ${slug}`,
    referralAlreadyUsed: true,
  });
  await assert('second-scan bot response prepends "ya lo usaste"',
    msgs2[0]?.toLowerCase().includes('ya lo usaste'),
    `first-line="${msgs2[0]}"`);
  await assert('second-scan bot response still includes the normal greeting body',
    msgs2.length >= 2,
    `line-count=${msgs2.length}`);

  // ── Scan #3: also the same phone, flag still true.
  const msgs3 = await handleIncomingMessage({
    phoneNumber: refPhone,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: `Hola! Me invitaron a X en Valee Ref: ${tenant.slug} Ref2U: ${slug}`,
    referralAlreadyUsed: true,
  });
  await assert('third scan still prepends "ya lo usaste" (idempotent message)',
    msgs3[0]?.toLowerCase().includes('ya lo usaste'),
    `first-line="${msgs3[0]}"`);

  // ── Scan by a DIFFERENT fresh referee with the same code — should record fresh.
  const refPhoneB = `+58414${String(ts).slice(-7, -4)}003`;
  const { account: genB } = await findOrCreateConsumerAccount(tenant.id, refPhoneB);
  const differentReferee = await recordPendingReferral({
    tenantId: tenant.id, referrerAccountId: eric.id, refereeAccountId: genB.id,
  });
  await assert('different fresh referee still gets recorded',
    differentReferee.recorded === true,
    `recorded=${differentReferee.recorded}`);

  const msgsB = await handleIncomingMessage({
    phoneNumber: refPhoneB,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: `Hola! Me invitaron a X en Valee Ref: ${tenant.slug} Ref2U: ${slug}`,
    referralAlreadyUsed: false,
  });
  await assert('different fresh referee does NOT get the "ya lo usaste" line',
    !msgsB.some(m => m.toLowerCase().includes('ya lo usaste')),
    `msgs=${JSON.stringify(msgsB)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
