/**
 * Consumer-to-consumer referrals.
 *
 * Each account gets a stable referralSlug the first time it's requested.
 * The consumer shares their referral QR/link which carries `Ref2U:<slug>` —
 * when a NEW consumer lands with that marker, we record a pending Referral.
 * On the referee's FIRST validated transaction at that tenant, we credit the
 * referrer with the tenant's configured bonus (or the platform default).
 */

import prisma from '../db/client.js';
import { writeDoubleEntry } from './ledger.js';
import { getSystemAccount } from './accounts.js';

const REFERRAL_SLUG_LEN = 8;

/**
 * Returns (and lazily creates) the account's referralSlug.
 * Retries up to 5 times on collision, which should effectively never happen
 * with 8 base36 chars (~2.8 trillion space) but the DB unique index keeps us
 * safe anyway.
 */
export async function ensureReferralSlug(accountId: string): Promise<string> {
  const acc = await prisma.account.findUnique({ where: { id: accountId }, select: { referralSlug: true } });
  if (!acc) throw new Error('Account not found');
  if (acc.referralSlug) return acc.referralSlug;

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = Math.random().toString(36).slice(2, 2 + REFERRAL_SLUG_LEN);
    const collision = await prisma.account.findUnique({ where: { referralSlug: candidate }, select: { id: true } });
    if (collision) continue;
    try {
      await prisma.account.update({ where: { id: accountId }, data: { referralSlug: candidate } });
      return candidate;
    } catch {
      // race on unique, try again
    }
  }
  throw new Error('Could not generate unique referral slug');
}

/**
 * Parse a `Ref2U:<slug>` marker and resolve it to a referrer accountId.
 * Returns null if no marker or the slug doesn't match any account.
 */
export async function parseReferralSlug(text: string): Promise<string | null> {
  const m = text.match(/Ref2U:\s*([a-z0-9]{4,16})/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  const acc = await prisma.account.findUnique({ where: { referralSlug: slug }, select: { id: true } });
  return acc?.id || null;
}

/**
 * Record a pending referral link. Called when a NEW consumer arrives at a
 * tenant via a referral link. Silent no-op if the referee already had any
 * ledger activity at this tenant (they aren't actually new).
 *
 * Guards:
 *  - referrer must be an account of the same tenant (the referral is merchant-scoped)
 *  - referee must not already have a referral row for this tenant
 *  - referee must not already have ledger activity (not actually new)
 *  - referrer and referee must be different accounts
 */
export async function recordPendingReferral(params: {
  tenantId: string;
  referrerAccountId: string;
  refereeAccountId: string;
}): Promise<{ recorded: boolean; reason?: string }> {
  if (params.referrerAccountId === params.refereeAccountId) {
    return { recorded: false, reason: 'self_referral' };
  }

  // Both accounts must belong to the tenant
  const [referrer, referee] = await Promise.all([
    prisma.account.findFirst({ where: { id: params.referrerAccountId, tenantId: params.tenantId } }),
    prisma.account.findFirst({ where: { id: params.refereeAccountId, tenantId: params.tenantId } }),
  ]);
  if (!referrer) return { recorded: false, reason: 'referrer_not_in_tenant' };
  if (!referee)  return { recorded: false, reason: 'referee_not_in_tenant'  };

  // Existing referral row → not new
  const existing = await prisma.referral.findUnique({
    where: { tenantId_refereeAccountId: { tenantId: params.tenantId, refereeAccountId: params.refereeAccountId } },
  });
  if (existing) return { recorded: false, reason: 'already_referred' };

  // Prior ledger activity → not new
  const priorActivity = await prisma.ledgerEntry.findFirst({
    where: {
      tenantId: params.tenantId,
      accountId: params.refereeAccountId,
      eventType: { in: ['INVOICE_CLAIMED', 'PRESENCE_VALIDATED'] },
      entryType: 'CREDIT',
    },
    select: { id: true },
  });
  if (priorActivity) return { recorded: false, reason: 'referee_has_activity' };

  await prisma.referral.create({
    data: {
      tenantId: params.tenantId,
      referrerAccountId: params.referrerAccountId,
      refereeAccountId: params.refereeAccountId,
      status: 'pending',
    },
  });
  return { recorded: true };
}

/**
 * Called after a consumer's transaction completes. If a pending referral row
 * exists for this referee at this tenant, credits the referrer with the
 * tenant-configured bonus and marks the referral credited.
 *
 * Idempotent: a second call after status != pending is a no-op.
 */
export async function tryCreditReferral(params: {
  tenantId: string;
  refereeAccountId: string;
  assetTypeId: string;
}): Promise<{ credited: boolean; amount?: string; referrerAccountId?: string }> {
  const pending = await prisma.referral.findUnique({
    where: { tenantId_refereeAccountId: { tenantId: params.tenantId, refereeAccountId: params.refereeAccountId } },
  });
  if (!pending || pending.status !== 'pending') return { credited: false };

  const tenant = await prisma.tenant.findUnique({
    where: { id: params.tenantId },
    select: { referralBonusAmount: true },
  });
  const bonusInt = Number(tenant?.referralBonusAmount ?? parseInt(process.env.REFERRAL_BONUS_AMOUNT || '100'));
  if (!Number.isFinite(bonusInt) || bonusInt <= 0) return { credited: false };

  const pool = await getSystemAccount(params.tenantId, 'issued_value_pool');
  if (!pool) return { credited: false };

  const amount = bonusInt.toFixed(8);
  const referenceId = `REFERRAL-${pending.id}`;

  const ledger = await writeDoubleEntry({
    tenantId: params.tenantId,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id,
    creditAccountId: pending.referrerAccountId,
    amount,
    assetTypeId: params.assetTypeId,
    referenceId,
    referenceType: 'manual_adjustment',
    metadata: {
      type: 'referral_bonus',
      referralId: pending.id,
      refereeAccountId: params.refereeAccountId,
    },
  });

  await prisma.referral.update({
    where: { id: pending.id },
    data: {
      status: 'credited',
      bonusAmount: amount,
      bonusLedgerId: ledger.credit.id,
      creditedAt: new Date(),
    },
  });

  // Notify the referrer via WhatsApp so they actually see the bonus
  // land. Eric flagged this on 2026-04-23 ("no se ven en whatsapp ni
  // en la pwa") — the credit was happening silently and neither the
  // bot nor the PWA surfaced it. Best-effort: a failure here never
  // rolls back the credit, it's a pure notification side-effect.
  try {
    const [referrer, tenantFull] = await Promise.all([
      prisma.account.findUnique({
        where: { id: pending.referrerAccountId },
        select: { phoneNumber: true },
      }),
      prisma.tenant.findUnique({
        where: { id: params.tenantId },
        select: { name: true, slug: true },
      }),
    ]);
    if (referrer?.phoneNumber && tenantFull) {
      const base = (process.env.CONSUMER_APP_URL || 'https://valee.app').replace(/\/+$/, '');
      const pwaLink = `${base}/consumer?tenant=${encodeURIComponent(tenantFull.slug)}`;
      const bonusRound = Math.round(parseFloat(amount)).toLocaleString();
      const lines = [
        `🎉 ¡Ganaste ${bonusRound} puntos por tu referido en ${tenantFull.name}!`,
        `Tu invitado hizo su primera compra y el bono ya esta en tu saldo.`,
        `📱 Ver tu cuenta: ${pwaLink}`,
      ];
      const { sendWhatsAppMessage } = await import('./whatsapp.js');
      await sendWhatsAppMessage(referrer.phoneNumber, lines.join('\n'));
    }
  } catch (err) {
    console.error('[Referral] Failed to notify referrer via WhatsApp (non-fatal):', err);
  }

  return { credited: true, amount, referrerAccountId: pending.referrerAccountId };
}
