/**
 * E2E: the Bot de WhatsApp card (Eric, Notion 2026-04-23).
 *
 * Three asks, one test:
 *
 *   1. Drop "(provisional)" from the factura-received bot reply. Eric
 *      called it out as confusing customer-facing jargon.
 *
 *   2. Warmer first-time greeting: "Ganaste X puntos de bienvenida,
 *      queremos verte en <comercio>!" instead of the split two-line
 *      welcome + bonus.
 *
 *   3. Referral visibility. When a referrer's bonus is credited, the
 *      bot must send them a WhatsApp message and the PWA history must
 *      surface the credit as REFERRAL_BONUS (not the generic
 *      ADJUSTMENT_MANUAL) so the user actually sees it.
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs/promises';
import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { ensureReferralSlug, recordPendingReferral, tryCreditReferral } from '../src/services/referrals.js';
import { getStateGreeting } from '../src/services/whatsapp-bot.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Bot de WhatsApp polish E2E ===\n');

  // --- Source-level checks on the bot copy (fast, no DB) ---
  const botSrc = await fs.readFile('/home/loyalty-platform/src/services/whatsapp-bot.ts', 'utf8');

  await assert('factura-received reply no longer carries "(provisional)"',
    !/\(provisional\)\./.test(botSrc.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'verified');

  // --- first_time greeting copy ---
  const firstTime = getStateGreeting('first_time', 'Kromi Parral', '0', '+584140000000', '100', 'kromi', null);
  const joined = firstTime.join(' | ');
  await assert('first_time greeting mentions "queremos verte en" <merchant>',
    /queremos verte en Kromi Parral/.test(joined),
    `got=${joined.slice(0, 120)}...`);
  await assert('first_time greeting mentions "puntos de bienvenida"',
    /puntos de bienvenida/i.test(joined),
    'verified');

  // --- Frontend label maps include REFERRAL_BONUS ---
  const consumerPage = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx',
    'utf8',
  );
  const merchantPage = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(merchant)/merchant/page.tsx',
    'utf8',
  );
  await assert('consumer EVENT_LABELS includes REFERRAL_BONUS',
    /REFERRAL_BONUS:\s*'[^']+'/.test(consumerPage),
    'verified');
  await assert('merchant EVENT_LABELS includes REFERRAL_BONUS',
    /REFERRAL_BONUS:\s*'[^']+'/.test(merchantPage),
    'verified');

  // --- End-to-end referral credit → virtual event type + notification ---
  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Bot Polish ${ts}`, `bot-polish-${ts}`, `bot-polish-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const referrerPhone = `+58414${String(ts).slice(-7, -4)}100`;
  const refereePhone  = `+58414${String(ts).slice(-7, -4)}200`;
  const { account: referrer } = await findOrCreateConsumerAccount(tenant.id, referrerPhone);
  const { account: referee  } = await findOrCreateConsumerAccount(tenant.id, refereePhone);
  await ensureReferralSlug(referrer.id);

  const record = await recordPendingReferral({
    tenantId: tenant.id, referrerAccountId: referrer.id, refereeAccountId: referee.id,
  });
  await assert('pending referral recorded for fresh referee',
    record.recorded === true,
    `recorded=${record.recorded}`);

  // Seed the referee with some balance so the ledger has an account to write
  // against when tryCreditReferral runs its debit→pool leg.
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id, creditAccountId: referee.id,
    amount: '50', assetTypeId: asset.id,
    referenceId: `SEED-${ts}`, referenceType: 'manual_adjustment',
    metadata: { type: 'seed' },
  });

  const credit = await tryCreditReferral({
    tenantId: tenant.id, refereeAccountId: referee.id, assetTypeId: asset.id,
  });
  await assert('tryCreditReferral credits the referrer',
    credit.credited === true && credit.referrerAccountId === referrer.id,
    `credited=${credit.credited} amount=${credit.amount}`);

  // Ledger row for the referrer carries the REFERRAL- reference + metadata
  // so the consumer history endpoint can relabel it REFERRAL_BONUS.
  const creditRow = await prisma.ledgerEntry.findFirst({
    where: {
      tenantId: tenant.id,
      accountId: referrer.id,
      entryType: 'CREDIT',
      eventType: 'ADJUSTMENT_MANUAL',
    },
    orderBy: { createdAt: 'desc' },
    select: { referenceId: true, metadata: true, amount: true },
  });
  await assert('referral credit row carries REFERRAL- reference',
    (creditRow?.referenceId || '').startsWith('REFERRAL-'),
    `ref=${creditRow?.referenceId}`);
  await assert('referral credit row carries metadata.type=referral_bonus',
    (creditRow?.metadata as any)?.type === 'referral_bonus',
    `type=${(creditRow?.metadata as any)?.type}`);

  // Second call is a no-op (idempotent) — status already 'credited'.
  const again = await tryCreditReferral({
    tenantId: tenant.id, refereeAccountId: referee.id, assetTypeId: asset.id,
  });
  await assert('second tryCreditReferral is a no-op',
    again.credited === false,
    `credited=${again.credited}`);

  // Referrals service source check: it fetches referrer phone + sends a
  // WhatsApp message. Guards against someone removing the notification
  // without noticing.
  const refSrc = await fs.readFile('/home/loyalty-platform/src/services/referrals.ts', 'utf8');
  await assert('tryCreditReferral sends a WhatsApp notification to referrer',
    /sendWhatsAppMessage\(referrer\.phoneNumber/.test(refSrc),
    'verified');

  // Backend virtual-event-type derivation sources carry the REFERRAL_BONUS
  // branch in both the consumer history and merchant analytics paths.
  const consumerAccountSrc = await fs.readFile(
    '/home/loyalty-platform/src/api/routes/consumer/account.ts',
    'utf8',
  );
  const merchantAnalyticsSrc = await fs.readFile(
    '/home/loyalty-platform/src/api/routes/merchant/analytics.ts',
    'utf8',
  );
  await assert('consumer history emits REFERRAL_BONUS virtual event',
    /effectiveEventType\s*=\s*'REFERRAL_BONUS'/.test(consumerAccountSrc),
    'verified');
  await assert('merchant analytics emits REFERRAL_BONUS virtual event',
    /effectiveEventType\s*=\s*'REFERRAL_BONUS'/.test(merchantAnalyticsSrc),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
