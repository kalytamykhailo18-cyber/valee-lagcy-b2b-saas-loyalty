import type { FastifyInstance } from 'fastify';
import prisma from '../../db/client.js';
import { generateOTP, verifyOTP, issueConsumerTokens, verifyConsumerToken, incrementOtpBucket } from '../../services/auth.js';
import { findOrCreateConsumerAccount, normalizeVenezuelanPhone, phoneTail } from '../../services/accounts.js';
import { getAccountBalance, getAccountBalanceBreakdown, getAccountHistory } from '../../services/ledger.js';
import { validateInvoice } from '../../services/invoice-validation.js';
import { initiateRedemption } from '../../services/redemption.js';
import { requireConsumerAuth } from '../middleware/auth.js';
import { sendWhatsAppOTP } from '../../services/whatsapp.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../../services/idempotency.js';
import { createDispute } from '../../services/disputes.js';
import { uploadImage } from '../../services/cloudinary.js';
import { grantWelcomeBonus } from '../../services/welcome-bonus.js';

export default async function consumerRoutes(app: FastifyInstance) {

  // ---- AUTH: Request OTP ----
  // tenantSlug is optional. With slug → legacy per-merchant flow.
  // Without slug → tenantless "global" login. The OTP itself is per phone number,
  // so we send it the same way regardless.
  app.post('/api/consumer/auth/request-otp', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const { phoneNumber: rawPhone, tenantSlug } = request.body as { phoneNumber: string; tenantSlug?: string };

    if (!rawPhone) {
      return reply.status(400).send({ error: 'phoneNumber is required' });
    }

    const phoneNumber = normalizeVenezuelanPhone(rawPhone);

    // Rate limit: at most 3 OTP sends per phone per 15 minutes. Anything above
    // that is either a bug, a retry loop, or spam — and the real user just sees
    // their WhatsApp flooded. Bucket counts are stored in the same redis/memory
    // store used by the OTP service.
    const bucketCount = await incrementOtpBucket(phoneNumber);
    if (bucketCount > 3) {
      console.warn(`[Auth] OTP rate limit hit for ${phoneNumber} (count=${bucketCount})`);
      return reply.status(429).send({
        error: 'Demasiados intentos. Espera unos minutos antes de solicitar otro codigo.',
        retryAfterSeconds: 900,
      });
    }

    if (tenantSlug) {
      const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
      if (!tenant || tenant.status !== 'active') {
        return reply.status(404).send({ error: 'Merchant not found' });
      }
    }

    const otp = await generateOTP(phoneNumber);

    await sendWhatsAppOTP(phoneNumber, otp);

    console.log(`[Auth] OTP requested: phone=${phoneNumber} slug=${tenantSlug || '(global)'} bucket=${bucketCount}`);
    return { success: true, message: 'OTP sent via WhatsApp', otp: process.env.NODE_ENV !== 'production' ? otp : undefined };
  });

  // ---- AUTH: Verify OTP ----
  // tenantSlug optional. With slug → tenant-bound token. Without slug → "global"
  // token (accountId='', tenantId=''). The user must call /select-merchant to
  // upgrade it before using per-tenant endpoints.
  app.post('/api/consumer/auth/verify-otp', async (request, reply) => {
    const { phoneNumber: rawPhone, otp, tenantSlug } = request.body as { phoneNumber: string; otp: string; tenantSlug?: string };

    if (!rawPhone || !otp) {
      return reply.status(400).send({ error: 'phoneNumber and otp are required' });
    }

    const phoneNumber = normalizeVenezuelanPhone(rawPhone);

    const valid = await verifyOTP(phoneNumber, otp);
    if (!valid) return reply.status(401).send({ error: 'Invalid or expired OTP' });

    if (tenantSlug) {
      const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
      if (!tenant) return reply.status(404).send({ error: 'Merchant not found' });

      const { account } = await findOrCreateConsumerAccount(tenant.id, phoneNumber);

      try {
        const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId: tenant.id } });
        const assetType = assetConfig
          ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
          : await prisma.assetType.findFirst();
        if (assetType) {
          await grantWelcomeBonus(account.id, tenant.id, assetType.id);
        }
      } catch (err) {
        app.log.error({ err }, 'welcome bonus grant failed on consumer OTP login');
      }

      const tokens = issueConsumerTokens({
        accountId: account.id,
        tenantId: tenant.id,
        phoneNumber,
        type: 'consumer',
      });

      reply.setCookie('accessToken', tokens.accessToken, {
        httpOnly: true, secure: true, sameSite: 'lax', path: '/',
        maxAge: 15 * 60,
      });
      reply.setCookie('refreshToken', tokens.refreshToken, {
        httpOnly: true, secure: true, sameSite: 'lax', path: '/api/consumer/auth/refresh',
        maxAge: 30 * 24 * 60 * 60,
      });

      console.log(`[Auth] OTP verified (tenant): phone=${phoneNumber} slug=${tenantSlug} accountId=${account.id}`);
      return { success: true, ...tokens, account: { id: account.id, type: account.accountType, phoneNumber }, scope: 'tenant' };
    }

    // Tenantless / "global" login. Token has the phone but no tenant binding.
    console.log(`[Auth] OTP verified (global): phone=${phoneNumber}`);
    const tokens = issueConsumerTokens({
      accountId: '',
      tenantId: '',
      phoneNumber,
      type: 'consumer',
    });

    reply.setCookie('accessToken', tokens.accessToken, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
      maxAge: 15 * 60,
    });
    reply.setCookie('refreshToken', tokens.refreshToken, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/api/consumer/auth/refresh',
      maxAge: 30 * 24 * 60 * 60,
    });

    return { success: true, ...tokens, scope: 'global' };
  });

  // ---- AUTH: Select merchant (upgrade global → tenant token) ----
  app.post('/api/consumer/auth/select-merchant', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { phoneNumber } = request.consumer!;
    const { tenantSlug } = request.body as { tenantSlug: string };

    if (!tenantSlug) return reply.status(400).send({ error: 'tenantSlug is required' });

    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.status !== 'active') {
      return reply.status(404).send({ error: 'Merchant not found' });
    }

    const { account } = await findOrCreateConsumerAccount(tenant.id, phoneNumber);

    try {
      const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId: tenant.id } });
      const assetType = assetConfig
        ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
        : await prisma.assetType.findFirst();
      if (assetType) {
        await grantWelcomeBonus(account.id, tenant.id, assetType.id);
      }
    } catch (err) {
      app.log.error({ err }, 'welcome bonus grant failed on select-merchant');
    }

    const tokens = issueConsumerTokens({
      accountId: account.id,
      tenantId: tenant.id,
      phoneNumber,
      type: 'consumer',
    });

    reply.setCookie('accessToken', tokens.accessToken, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
      maxAge: 15 * 60,
    });
    reply.setCookie('refreshToken', tokens.refreshToken, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/api/consumer/auth/refresh',
      maxAge: 30 * 24 * 60 * 60,
    });

    return {
      success: true,
      ...tokens,
      account: { id: account.id, type: account.accountType, phoneNumber },
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      scope: 'tenant',
    };
  });

  // ---- AUTH: Log event (client-side debug beacon) ----
  app.post('/api/consumer/log-event', async (request) => {
    const { event, detail } = request.body as { event: string; detail?: string };
    const token = request.headers.authorization ? 'yes' : 'no';
    console.log(`[ClientEvent] ${event} | token=${token} | ${detail || ''}`);
    return { ok: true };
  });

  // ---- AUTH: Refresh token ----
  app.post('/api/consumer/auth/refresh', async (request, reply) => {
    // Accept refresh token from cookie or body
    const refreshToken = (request.cookies as any)?.refreshToken
      || (request.body as any)?.refreshToken;
    if (!refreshToken) return reply.status(400).send({ error: 'refreshToken required' });

    try {
      const payload = verifyConsumerToken(refreshToken);
      const tokens = issueConsumerTokens({
        accountId: payload.accountId,
        tenantId: payload.tenantId,
        phoneNumber: payload.phoneNumber,
        type: 'consumer',
      });
      reply.setCookie('accessToken', tokens.accessToken, {
        httpOnly: true, secure: true, sameSite: 'lax', path: '/',
        maxAge: 15 * 60,
      });
      reply.setCookie('refreshToken', tokens.refreshToken, {
        httpOnly: true, secure: true, sameSite: 'lax', path: '/api/consumer/auth/refresh',
        maxAge: 30 * 24 * 60 * 60,
      });
      return { success: true, ...tokens };
    } catch {
      return reply.status(401).send({ error: 'Invalid refresh token' });
    }
  });

  // ---- AUTH: Logout ----
  // Clears the httpOnly access + refresh cookies AND bumps the account's
  // tokens_invalidated_at so any token (cookie, localStorage, or copied)
  // issued before this moment is rejected at auth-check time. Without the
  // DB-level marker, a JWT that leaks can still be used for its full TTL
  // since the signature is valid; the marker gives us real revocation.
  // Unauthenticated calls still return 200 — the client may have already
  // dropped its token and just wants to clear cookies.
  app.post('/api/consumer/auth/logout', async (request, reply) => {
    reply.clearCookie('accessToken', { path: '/' });
    reply.clearCookie('refreshToken', { path: '/api/consumer/auth/refresh' });

    // Best-effort subject lookup: prefer Authorization header, fall back to
    // cookie. If we can resolve an accountId, mark its tokens invalidated.
    const authHeader = request.headers.authorization;
    const cookieToken = (request.cookies as any)?.accessToken;
    const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : cookieToken;
    if (rawToken) {
      try {
        const payload = verifyConsumerToken(rawToken);
        if (payload.accountId) {
          await prisma.account.update({
            where: { id: payload.accountId },
            data: { tokensInvalidatedAt: new Date() },
          });
        }
      } catch {
        // Token invalid or expired — still return success so clients can
        // reliably call logout from any state.
      }
    }
    return { success: true };
  });

  // ---- BALANCE ----
  app.get('/api/consumer/balance', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;

    // Tenantless (global) tokens cannot resolve a balance. Tell the client
    // explicitly so it can call select-merchant instead of reading `0` and
    // silently showing an empty balance.
    if (!tenantId || !accountId) {
      return reply.status(409).send({
        error: 'No merchant selected',
        requiresMerchantSelection: true,
      });
    }

    // Get the first asset type for this tenant
    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();

    if (!assetType) {
      return { balance: '0', confirmed: '0', provisional: '0', unitLabel: 'points' };
    }

    const breakdown = await getAccountBalanceBreakdown(accountId, assetType.id, tenantId);

    // Reserved = sum of active pending redemption tokens. In the double-entry
    // ledger these are already debited from the consumer's balance (the QR
    // must hold the value so a second scan can't double-spend), so
    // breakdown.total already has them subtracted. The consumer sees this as
    // "points disappeared before I even showed the QR". We expose the
    // reserved amount so the PWA can render the big number as
    // total + reserved with a "N reservados" chip beside it, letting the
    // customer understand where the missing points went (Genesis M4).
    const reservedAgg = await prisma.redemptionToken.aggregate({
      where: {
        tenantId,
        consumerAccountId: accountId,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      _sum: { amount: true },
    });
    const reserved = reservedAgg._sum.amount?.toString() || '0';

    return {
      balance: breakdown.total,           // total displayed (confirmed + provisional)
      confirmed: breakdown.confirmed,
      provisional: breakdown.provisional,
      reserved,                           // pending redemption QRs still held
      unitLabel: assetType.unitLabel,
      assetTypeId: assetType.id,
    };
  });

  // ---- HISTORY ----
  app.get('/api/consumer/history', { preHandler: [requireConsumerAuth] }, async (request) => {
    const { accountId, tenantId } = request.consumer!;
    const { limit = '50', offset = '0' } = request.query as { limit?: string; offset?: string };

    const entries = await getAccountHistory(accountId, tenantId, parseInt(limit), parseInt(offset));

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

    // Enrich redemption-type entries with the product they were canjeado by.
    // The referenceId on a redemption ledger entry is the RedemptionToken id,
    // which carries the product relation. Without this join, the consumer's
    // history shows "Canje pendiente / -700" with no hint of what they bought.
    const redemptionEventTypes = new Set(['REDEMPTION_PENDING', 'REDEMPTION_CONFIRMED', 'REDEMPTION_EXPIRED']);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // referenceId shapes: REDEEM-<uuid>, CONFIRMED-<uuid>, EXPIRED-<uuid>.
    const refToTokenId = (ref: string): string | null => {
      const stripped = ref.replace(/^(REDEEM|CONFIRMED|EXPIRED)-/i, '');
      return UUID_RE.test(stripped) ? stripped : null;
    };

    const tokenIdByRef = new Map<string, string>();
    const pendingLedgerIds: string[] = [];
    for (const e of entries) {
      if (!redemptionEventTypes.has(e.eventType)) continue;
      const tid = refToTokenId(e.referenceId);
      if (tid) tokenIdByRef.set(e.referenceId, tid);
      if (e.eventType === 'REDEMPTION_PENDING') pendingLedgerIds.push(e.id);
    }
    // Bridge old REDEEM-<throwaway> refs whose UUID doesn't match the
    // token (historical bug: redemption.ts used separate uuids for the
    // ledger ref vs the token id). redemption_tokens.ledgerPendingEntryId
    // points back at the PENDING ledger row, so we can rewrite the map
    // entry to use the real token uuid and let the collapse logic group
    // PENDING and its terminal event under the same key.
    if (pendingLedgerIds.length > 0) {
      const bridges = await prisma.redemptionToken.findMany({
        where: { ledgerPendingEntryId: { in: pendingLedgerIds } },
        select: { id: true, ledgerPendingEntryId: true },
      });
      const pendingEntryIdToTokenId = new Map<string, string>();
      for (const b of bridges) pendingEntryIdToTokenId.set(b.ledgerPendingEntryId, b.id);
      for (const e of entries) {
        if (e.eventType !== 'REDEMPTION_PENDING') continue;
        const realTid = pendingEntryIdToTokenId.get(e.id);
        if (realTid) tokenIdByRef.set(e.referenceId, realTid);
      }
    }
    const redemptionTokenIds = Array.from(new Set(tokenIdByRef.values()));

    // Track which tokens already have a CONFIRMED (or EXPIRED) terminal
    // event. Their PENDING entries collapse into a single final-state row
    // (Genesis M6: 'Canje pendiente -10 / Canje confirmado +10' shouldn't
    // render as two stacked rows; it's one product canje).
    //
    // getAccountHistory only returns entries whose account_id = consumer.
    // REDEMPTION_CONFIRMED writes holding→pool (neither touches the
    // consumer) and REDEMPTION_EXPIRED writes holding→consumer (only the
    // CREDIT side touches the consumer). So to know whether a PENDING was
    // resolved we must consult redemption_tokens.status directly — that's
    // the source of truth regardless of which account the ledger leg is on.
    const confirmedTokenIds = new Set<string>();
    const expiredTokenIds = new Set<string>();
    if (redemptionTokenIds.length > 0) {
      const statusRows = await prisma.redemptionToken.findMany({
        where: { id: { in: redemptionTokenIds } },
        select: { id: true, status: true },
      });
      for (const r of statusRows) {
        if (r.status === 'used')    confirmedTokenIds.add(r.id);
        if (r.status === 'expired') expiredTokenIds.add(r.id);
      }
      // Fallback: if no redemption_tokens row (older data or test seeds),
      // scan the ledger tenant-wide for CONFIRMED-/EXPIRED-<tid> refs.
      const terminalRefs = await prisma.ledgerEntry.findMany({
        where: {
          tenantId,
          OR: redemptionTokenIds.flatMap(tid => [
            { referenceId: `CONFIRMED-${tid}` },
            { referenceId: `EXPIRED-${tid}` },
          ]),
        },
        select: { referenceId: true, eventType: true },
      });
      for (const r of terminalRefs) {
        const m = r.referenceId.match(/^(CONFIRMED|EXPIRED)-(.+)$/);
        if (!m) continue;
        if (m[1] === 'CONFIRMED') confirmedTokenIds.add(m[2]);
        if (m[1] === 'EXPIRED')   expiredTokenIds.add(m[2]);
      }
    }

    const tokens = redemptionTokenIds.length > 0
      ? await prisma.redemptionToken.findMany({
          where: { id: { in: redemptionTokenIds } },
          select: { id: true, product: { select: { name: true, photoUrl: true } } },
        })
      : [];
    const productByTokenId = new Map(tokens.map(t => [t.id, t.product]));

    // Build a lookup so the per-row status we send to the client reflects
    // the reconciled state, not the append-only raw ledger status. An
    // INVOICE_CLAIMED row with status='provisional' whose linked invoice
    // has already been matched against the CSV should display as
    // 'confirmed' to the consumer — otherwise the UI shows a yellow
    // 'provisional' chip on a transaction whose points are already
    // spendable (the bug Genesis reported: merchant view said Canjeada,
    // consumer history still said provisional for the same event).
    const pendingInvoiceNumbers = new Set<string>();
    for (const e of entries) {
      if (e.eventType !== 'INVOICE_CLAIMED' || e.status !== 'provisional') continue;
      const ref = e.referenceId || '';
      if (ref.startsWith('PENDING-')) pendingInvoiceNumbers.add(ref.slice('PENDING-'.length));
    }
    const claimedInvoices = pendingInvoiceNumbers.size > 0
      ? await prisma.invoice.findMany({
          where: {
            tenantId,
            invoiceNumber: { in: Array.from(pendingInvoiceNumbers) },
            status: 'claimed',
          },
          select: { invoiceNumber: true },
        })
      : [];
    const claimedInvoiceNumbers = new Set(claimedInvoices.map(i => i.invoiceNumber));

    return {
      entries: entries
        // Collapse PENDING/CONFIRMED/EXPIRED into a single row per token
        // (Genesis M6). Three cases:
        //   confirmed  → show ONE 'Producto Canjeado' DEBIT row (keep the
        //                PENDING row, relabel it to CONFIRMED; drop the
        //                CONFIRMED credit leg that lives on the pool)
        //   expired    → HIDE BOTH legs (net zero — the consumer got their
        //                points back, it's not a real event to list)
        //   in-flight  → keep the PENDING DEBIT as 'Canje pendiente'
        .filter(e => {
          const tid = tokenIdByRef.get(e.referenceId);
          if (!tid) return true;
          // Case: expired / cancelled → hide both sides of the pair.
          if (expiredTokenIds.has(tid) && !confirmedTokenIds.has(tid)) return false;
          // Case: confirmed → drop the system-side credit leg.
          if (e.eventType === 'REDEMPTION_CONFIRMED' && e.entryType === 'CREDIT') return false;
          // Safety: if for some reason a terminal event is missing, still
          // hide the EXPIRED DEBIT (it's always system-side).
          if (e.eventType === 'REDEMPTION_EXPIRED' && e.entryType === 'DEBIT') return false;
          return true;
        })
        .map(e => {
          const tid = tokenIdByRef.get(e.referenceId);
          if (tid && e.eventType === 'REDEMPTION_PENDING' && confirmedTokenIds.has(tid)) {
            return { ...e, eventType: 'REDEMPTION_CONFIRMED' as any };
          }
          return e;
        })
        .map(e => {
        // Prefer metadata stamped at write time (survives token cleanup);
        // fall back to the token join for older entries.
        const meta: any = (e as any).metadata || {};
        const metaProduct = (meta?.productName || meta?.productPhotoUrl)
          ? { name: meta.productName || null, photoUrl: meta.productPhotoUrl || null }
          : null;
        const tid = redemptionEventTypes.has(e.eventType) ? tokenIdByRef.get(e.referenceId) : undefined;
        const product = metaProduct || (tid ? productByTokenId.get(tid) : undefined);

        // Welcome-bonus credits are written under ADJUSTMENT_MANUAL with a
        // WELCOME- referenceId and metadata.type === 'welcome_bonus'. Emit a
        // virtual event type so the consumer UI can label them correctly.
        const effectiveEventType =
          e.eventType === 'ADJUSTMENT_MANUAL'
          && (e.referenceId?.startsWith('WELCOME-') || meta?.type === 'welcome_bonus')
            ? 'WELCOME_BONUS'
            : e.eventType;

        // Effective status: if this is a provisional INVOICE_CLAIMED
        // whose invoice has been reconciled via CSV (invoice.status =
        // 'claimed'), report it as 'confirmed' to the client. Keeps the
        // transaction history aligned with the balance readout.
        const ref = e.referenceId || '';
        const isReconciled =
          e.eventType === 'INVOICE_CLAIMED'
          && e.status === 'provisional'
          && ref.startsWith('PENDING-')
          && claimedInvoiceNumbers.has(ref.slice('PENDING-'.length));
        const effectiveStatus = isReconciled ? 'confirmed' : e.status;

        return {
          id: e.id,
          eventType: effectiveEventType,
          entryType: e.entryType,
          amount: e.amount.toString(),
          status: effectiveStatus,
          referenceId: e.referenceId,
          createdAt: e.createdAt,
          merchantName: tenant?.name || null,
          productName: product?.name || null,
          productPhotoUrl: product?.photoUrl || null,
        };
      }),
    };
  });

  // ---- REFERRAL QR ----
  // Returns the authenticated consumer's personal referral QR for THIS merchant.
  // Slug is created lazily on first request and kept stable thereafter, so the
  // same QR can be re-printed/shared without breaking old links.
  app.get('/api/consumer/referral-qr', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;
    if (!accountId || !tenantId) {
      return reply.status(409).send({ error: 'requires merchant selection', requiresMerchantSelection: true });
    }

    const { ensureReferralSlug } = await import('../../services/referrals.js');
    const { generateReferralQR } = await import('../../services/merchant-qr.js');

    const slug = await ensureReferralSlug(accountId);
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, name: true, referralBonusAmount: true } });
    if (!tenant) return reply.status(404).send({ error: 'tenant not found' });

    const qr = await generateReferralQR({
      merchantSlug: tenant.slug,
      merchantName: tenant.name,
      referralSlug: slug,
    });
    return {
      referralSlug: slug,
      deepLink: qr.deepLink,
      qrPngBase64: qr.qrPngBase64,
      bonusAmount: tenant.referralBonusAmount,
      tenantName: tenant.name,
    };
  });

  // ---- REFERRAL STATS ----
  // Counts referrals (pending + credited) the consumer has sent for this merchant.
  app.get('/api/consumer/referrals', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;
    if (!accountId || !tenantId) {
      return reply.status(409).send({ error: 'requires merchant selection', requiresMerchantSelection: true });
    }
    const rows = await prisma.referral.findMany({
      where: { tenantId, referrerAccountId: accountId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      count: rows.length,
      pending: rows.filter(r => r.status === 'pending').length,
      credited: rows.filter(r => r.status === 'credited').length,
      totalEarned: rows
        .filter(r => r.status === 'credited' && r.bonusAmount)
        .reduce((sum, r) => sum + Number(r.bonusAmount), 0)
        .toFixed(8),
    };
  });

  // ---- ACCOUNT INFO ----
  app.get('/api/consumer/account', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;

    // Global tokens (issued by tenantless OTP) carry accountId='' and
    // tenantId=''. findUnique with id='' throws P2023/validation. Fail fast
    // with a clean 409 so the client can call select-merchant instead of
    // crashing on 500.
    if (!accountId || !tenantId) {
      return reply.status(409).send({
        error: 'merchant selection required',
        requiresMerchantSelection: true,
      });
    }

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

    // Level thresholds (could be moved to DB/config later)
    const LEVEL_THRESHOLDS = [
      { level: 1, name: 'Bronce', min: 0 },
      { level: 2, name: 'Plata', min: 1000 },
      { level: 3, name: 'Oro', min: 5000 },
      { level: 4, name: 'Platino', min: 15000 },
    ];

    // Get balance and auto-upgrade level if needed
    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();
    let totalEarned = 0;
    if (assetType && accountId) {
      const bal = await getAccountBalance(accountId, assetType.id, tenantId);
      totalEarned = parseFloat(bal);
    }

    // Auto-upgrade: find the highest level the user qualifies for
    let correctLevel = 1;
    for (const t of LEVEL_THRESHOLDS) {
      if (totalEarned >= t.min) correctLevel = t.level;
    }
    if (account && correctLevel > account.level) {
      await prisma.account.update({ where: { id: accountId }, data: { level: correctLevel } });
    }

    const currentLevel = Math.max(account?.level || 1, correctLevel);
    const currentLevelInfo = LEVEL_THRESHOLDS.find(l => l.level === currentLevel) || LEVEL_THRESHOLDS[0];
    const nextLevelInfo = LEVEL_THRESHOLDS.find(l => l.level === currentLevel + 1);

    return {
      id: account?.id,
      phoneNumber: account?.phoneNumber,
      displayName: account?.displayName || null,
      accountType: account?.accountType,
      cedula: account?.cedula,
      level: currentLevel,
      levelName: currentLevelInfo.name,
      nextLevelName: nextLevelInfo?.name || null,
      pointsToNextLevel: nextLevelInfo ? Math.max(0, nextLevelInfo.min - totalEarned) : 0,
      nextLevelMin: nextLevelInfo?.min || null,
      merchantName: tenant?.name,
      merchantSlug: tenant?.slug,
      merchantLogo: tenant?.logoUrl || null,
    };
  });

  // ---- PUBLIC: List of affiliated merchants for the landing page (no auth) ----
  app.get('/api/consumer/affiliated-merchants', async () => {
    const tenants = await prisma.tenant.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      take: 24,
      select: { id: true, name: true, slug: true, qrCodeUrl: true },
    });
    return { merchants: tenants };
  });

  // ---- ALL ACCOUNTS (cross-tenant for the same phone number) ----
  // The authenticated consumer can have accounts in multiple merchants — same phone,
  // different tenants. This endpoint returns all of them with balance + top 3 products
  // per merchant. Used for the multicommerce landing page at valee.app.
  app.get('/api/consumer/all-accounts', { preHandler: [requireConsumerAuth] }, async (request) => {
    const { phoneNumber } = request.consumer!;
    const tail = phoneTail(phoneNumber);

    // Load every account this phone has across tenants so we can (1) always
    // include tenants where the consumer already has a balance even if they
    // have no published products right now, and (2) attach balance / accountId
    // to tenants listed for discovery. Last-10-digit matching handles legacy
    // phone-format variants.
    const allAccounts = await prisma.account.findMany({
      where: tail.length === 10
        ? { phoneNumber: { endsWith: tail }, accountType: { in: ['shadow', 'verified'] } }
        : { phoneNumber, accountType: { in: ['shadow', 'verified'] } },
      include: { tenant: true },
      orderBy: { createdAt: 'desc' },
    });

    // Deduplicate accounts by tenant, keeping the most recent (already ordered desc).
    const accountByTenant = new Map<string, typeof allAccounts[number]>();
    for (const acc of allAccounts) {
      if (!accountByTenant.has(acc.tenantId)) accountByTenant.set(acc.tenantId, acc);
    }

    // Tenants with at least one active in-stock product — these are safe to
    // surface even to users who don't have an account there yet (discovery).
    const tenantsWithProducts = await prisma.tenant.findMany({
      where: {
        status: 'active',
        products: { some: { active: true, stock: { gt: 0 } } },
      },
    });

    // Union: tenants-with-products ∪ tenants-where-this-user-has-an-account.
    // The latter bucket catches merchants where the user still has accumulated
    // points even if the merchant has no active products today — hiding those
    // would make balances appear to vanish.
    const tenantsById = new Map<string, { id: string; name: string; slug: string; status: string }>();
    for (const t of tenantsWithProducts) {
      tenantsById.set(t.id, { id: t.id, name: t.name, slug: t.slug, status: t.status });
    }
    for (const acc of allAccounts) {
      if (acc.tenant.status !== 'active') continue;
      if (!tenantsById.has(acc.tenantId)) {
        tenantsById.set(acc.tenantId, { id: acc.tenant.id, name: acc.tenant.name, slug: acc.tenant.slug, status: acc.tenant.status });
      }
    }
    const candidateTenants = Array.from(tenantsById.values());

    const merchantsRaw = await Promise.all(candidateTenants.map(async (tenant) => {
      const acc = accountByTenant.get(tenant.id) || null;

      // Pick the tenant's primary asset type
      const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId: tenant.id } });
      const assetType = assetConfig
        ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
        : await prisma.assetType.findFirst();

      let balance = '0';
      let unitLabel = 'pts';
      let reserved = '0';
      if (assetType) {
        if (acc) {
          balance = await getAccountBalance(acc.id, assetType.id, tenant.id);
          // Reserved = sum of this consumer's active pending redemption tokens
          // at this tenant. See /api/consumer/balance for the rationale — the
          // PWA displays balance+reserved so the customer doesn't think their
          // points vanished the moment they tapped "canjear" (Genesis M4).
          const resAgg = await prisma.redemptionToken.aggregate({
            where: {
              tenantId: tenant.id,
              consumerAccountId: acc.id,
              status: 'pending',
              expiresAt: { gt: new Date() },
            },
            _sum: { amount: true },
          });
          reserved = resAgg._sum.amount?.toString() || '0';
        }
        unitLabel = assetType.unitLabel;
      }

      // Top 3 products by lowest cost (entry-level redemptions are most attractive)
      const topProducts = await prisma.product.findMany({
        where: { tenantId: tenant.id, active: true, stock: { gt: 0 } },
        orderBy: { redemptionCost: 'asc' },
        take: 3,
        select: { id: true, name: true, photoUrl: true, redemptionCost: true, stock: true },
      });

      const fullTenant = await prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { logoUrl: true },
      });

      return {
        accountId: acc?.id || null,
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        tenantLogoUrl: fullTenant?.logoUrl || null,
        accountType: acc?.accountType || null,
        hasAccount: !!acc,
        balance,
        reserved,
        unitLabel,
        topProducts: topProducts.map(p => ({
          id: p.id,
          name: p.name,
          photoUrl: p.photoUrl,
          redemptionCost: p.redemptionCost.toString(),
          stock: p.stock,
        })),
      };
    }));

    // Final filter: show the merchant if EITHER the user has a balance there OR
    // it has at least one active product to redeem. A merchant with zero
    // products AND zero balance is noise.
    const merchants = merchantsRaw.filter(m => Number(m.balance) > 0 || m.topProducts.length > 0);

    // Sort: merchants with a balance first (by balance desc), then merchants
    // the user has an account in but no balance, then the rest alphabetically.
    merchants.sort((a, b) => {
      const ba = Number(a.balance), bb = Number(b.balance);
      if (ba !== bb) return bb - ba;
      if (a.hasAccount !== b.hasAccount) return a.hasAccount ? -1 : 1;
      return a.tenantName.localeCompare(b.tenantName);
    });

    // Compute total balance across merchants (note: only meaningful if all use the same unit)
    const totalBalance = merchants.reduce((sum, m) => sum + Number(m.balance), 0);
    const totalReserved = merchants.reduce((sum, m) => sum + Number(m.reserved || 0), 0);

    // Pick the best display name available across this user's accounts
    // (verified/non-null wins; otherwise the most recent).
    const displayName = allAccounts
      .map(a => a.displayName)
      .find((n): n is string => !!n && n.trim().length > 0) || null;

    return {
      phoneNumber,
      displayName,
      merchantCount: merchants.length,
      totalBalance: totalBalance.toFixed(8),
      totalReserved: totalReserved.toFixed(8),
      merchants,
    };
  });

  // ---- INVOICE VALIDATION (from PWA) ----
  // Accepts multipart/form-data with an image file, or JSON with pre-extracted data.
  app.post('/api/consumer/validate-invoice', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId, phoneNumber } = request.consumer!;

    const contentType = request.headers['content-type'] || '';

    // --- Multipart upload path (image file from PWA camera/gallery) ---
    if (contentType.includes('multipart/form-data')) {
      let imageBuffer: Buffer | null = null;
      let latitude: string | null = null;
      let longitude: string | null = null;
      let deviceId: string | null = null;
      let assetTypeId: string | null = null;
      let branchId: string | null = null;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'invoice') {
          imageBuffer = await part.toBuffer();
        } else if (part.type === 'field') {
          const val = part.value as string;
          if (part.fieldname === 'latitude') latitude = val || null;
          else if (part.fieldname === 'longitude') longitude = val || null;
          else if (part.fieldname === 'deviceId') deviceId = val || null;
          else if (part.fieldname === 'assetTypeId') assetTypeId = val || null;
          else if (part.fieldname === 'branchId') branchId = val || null;
        }
      }

      if (!imageBuffer) {
        return reply.status(400).send({ error: 'An invoice image file is required (field name: "invoice")' });
      }
      if (!assetTypeId) {
        return reply.status(400).send({ error: 'assetTypeId is required' });
      }

      // Validate branchId belongs to this tenant — ignore spoofed values instead
      // of trusting raw user input.
      if (branchId) {
        const b = await prisma.branch.findFirst({ where: { id: branchId, tenantId, active: true }, select: { id: true } });
        if (!b) branchId = null;
      }

      // Fallback: if the client didn't send a branchId but the user scanned a
      // merchant QR recently, use that branch.
      if (!branchId && phoneNumber) {
        const WINDOW_MIN = parseInt(process.env.MERCHANT_SCAN_WINDOW_MIN || '240');
        const cutoff = new Date(Date.now() - WINDOW_MIN * 60 * 1000);
        const recent = await prisma.merchantScanSession.findFirst({
          where: { tenantId, consumerPhone: phoneNumber, scannedAt: { gte: cutoff }, branchId: { not: null } },
          orderBy: { scannedAt: 'desc' },
          select: { branchId: true },
        });
        if (recent?.branchId) branchId = recent.branchId;
      }

      const result = await validateInvoice({
        tenantId,
        senderPhone: phoneNumber,
        assetTypeId,
        imageBuffer,
        latitude,
        longitude,
        deviceId,
        branchId,
      });

      // Store idempotency after successful validation (per-user)
      if (result.success && result.invoiceNumber) {
        const idempotencyKey = `invoice:${tenantId}:${phoneNumber}:${result.invoiceNumber}`;
        await storeIdempotencyKey(idempotencyKey, 'invoice_validation', result);
      }

      return result;
    }

    // --- JSON path (pre-extracted data, used by tests or WhatsApp pipeline) ---
    const { extractedData, latitude, longitude, deviceId, assetTypeId, ocrRawText, branchId: bodyBranchId } = request.body as any;

    if (!extractedData || !assetTypeId) {
      return reply.status(400).send({ error: 'extractedData and assetTypeId are required' });
    }

    let jsonBranchId: string | null = bodyBranchId || null;
    if (jsonBranchId) {
      const b = await prisma.branch.findFirst({ where: { id: jsonBranchId, tenantId, active: true }, select: { id: true } });
      if (!b) jsonBranchId = null;
    }
    if (!jsonBranchId && phoneNumber) {
      const WINDOW_MIN = parseInt(process.env.MERCHANT_SCAN_WINDOW_MIN || '240');
      const cutoff = new Date(Date.now() - WINDOW_MIN * 60 * 1000);
      const recent = await prisma.merchantScanSession.findFirst({
        where: { tenantId, consumerPhone: phoneNumber, scannedAt: { gte: cutoff }, branchId: { not: null } },
        orderBy: { scannedAt: 'desc' },
        select: { branchId: true },
      });
      if (recent?.branchId) jsonBranchId = recent.branchId;
    }

    // Idempotency check: per-user. The key includes the phone number so that
    // a second user submitting the same invoice number gets the full
    // validation flow (and the correct rejection message), not the first
    // user's cached success. Same-user double-submissions still hit the
    // cache and return the original result without creating duplicate entries.
    if (extractedData?.invoice_number) {
      const idempotencyKey = `invoice:${tenantId}:${phoneNumber}:${extractedData.invoice_number}`;
      const cached = await checkIdempotencyKey(idempotencyKey);
      if (cached) {
        return cached;
      }
    }

    const result = await validateInvoice({
      tenantId,
      senderPhone: phoneNumber,
      assetTypeId,
      extractedData,
      ocrRawText,
      latitude,
      longitude,
      deviceId,
      branchId: jsonBranchId,
    });

    // Store idempotency after successful validation (per-user)
    if (result.success && (result.invoiceNumber || extractedData?.invoice_number)) {
      const invoiceNum = result.invoiceNumber || extractedData.invoice_number;
      const idempotencyKey = `invoice:${tenantId}:${phoneNumber}:${invoiceNum}`;
      await storeIdempotencyKey(idempotencyKey, 'invoice_validation', result);
    }

    return result;
  });

  // ---- PRODUCT CATALOG ----
  // Active branches for the consumer's current tenant — powers the "in which
  // branch are you?" picker on /scan. Includes the branch most recently
  // scanned by this consumer (if any within the attribution window) so the
  // PWA can auto-preselect it.
  app.get('/api/consumer/branches', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { tenantId, phoneNumber } = request.consumer!;
    if (!tenantId) {
      return reply.status(409).send({ error: 'merchant selection required', requiresMerchantSelection: true });
    }
    const branches = await prisma.branch.findMany({
      where: { tenantId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, address: true, latitude: true, longitude: true },
    });

    const WINDOW_MIN = parseInt(process.env.MERCHANT_SCAN_WINDOW_MIN || '240');
    const cutoff = new Date(Date.now() - WINDOW_MIN * 60 * 1000);
    const recentScan = phoneNumber
      ? await prisma.merchantScanSession.findFirst({
          where: { tenantId, consumerPhone: phoneNumber, scannedAt: { gte: cutoff } },
          orderBy: { scannedAt: 'desc' },
          select: { branchId: true },
        })
      : null;

    return {
      branches: branches.map(b => ({
        id: b.id,
        name: b.name,
        address: b.address,
        latitude: b.latitude ? Number(b.latitude) : null,
        longitude: b.longitude ? Number(b.longitude) : null,
      })),
      recentBranchId: recentScan?.branchId || null,
    };
  });

  app.get('/api/consumer/catalog', { preHandler: [requireConsumerAuth] }, async (request) => {
    const { accountId, tenantId } = request.consumer!;
    const { limit = '20', offset = '0' } = request.query as { limit?: string; offset?: string };

    // Get consumer's level for reward filtering
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    const consumerLevel = account?.level || 1;

    const where = { tenantId, active: true, stock: { gt: 0 } as any, minLevel: { lte: consumerLevel } };

    // Paginated product list for infinite scroll
    const products = await prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    const total = await prisma.product.count({ where });

    // Get consumer balance — split into confirmed (spendable) and provisional (in verification, not yet spendable).
    // Affordability is computed on confirmed points only — provisional points cannot be redeemed
    // until the merchant CSV cross-reference confirms them.
    const assetType = await prisma.assetType.findFirst();
    const breakdown = assetType
      ? await getAccountBalanceBreakdown(accountId, assetType.id, tenantId)
      : { confirmed: '0', provisional: '0', total: '0' };
    const confirmedBalance = parseFloat(breakdown.confirmed);

    return {
      products: products.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        photoUrl: p.photoUrl,
        redemptionCost: p.redemptionCost.toString(),
        cashPrice: p.cashPrice?.toString() || null,
        hybridEnabled: p.cashPrice !== null && Number(p.cashPrice) > 0,
        stock: p.stock,
        minLevel: p.minLevel,
        canAfford: confirmedBalance >= Number(p.redemptionCost),
      })),
      total,
      balance: breakdown.total,
      confirmed: breakdown.confirmed,
      provisional: breakdown.provisional,
      consumerLevel,
    };
  });

  // ---- INITIATE REDEMPTION ----
  app.post('/api/consumer/redeem', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;
    const { productId, assetTypeId, cashAmount, requestId, branchId } = request.body as { productId: string; assetTypeId: string; cashAmount?: string; requestId?: string; branchId?: string };

    if (!productId || !assetTypeId) {
      return reply.status(400).send({ error: 'productId and assetTypeId are required' });
    }

    // Idempotency check: if client provided a requestId, check before processing
    if (requestId) {
      const idempotencyKey = `redeem:${tenantId}:${requestId}`;
      const cached = await checkIdempotencyKey(idempotencyKey);
      if (cached) {
        return cached;
      }
    }

    const result = await initiateRedemption({
      consumerAccountId: accountId,
      productId,
      tenantId,
      assetTypeId,
      cashAmount: cashAmount || null,
      branchId: branchId || null,
    });

    // Store idempotency after successful redemption
    if (requestId && result.success) {
      const idempotencyKey = `redeem:${tenantId}:${requestId}`;
      await storeIdempotencyKey(idempotencyKey, 'redemption', result);
    }

    return result;
  });

  // ---- ACTIVE REDEMPTION CODES ----
  // Returns pending redemption tokens that haven't expired yet, so the consumer
  // can re-open the QR if they navigated away.
  // Status of a single redemption token the consumer is holding. The PWA polls
  // this so the moment the cashier scans the QR, the consumer's screen can swap
  // from "aqui esta tu QR" to "canje verificado con exito" without waiting for
  // the TTL countdown to finish.
  app.get('/api/consumer/redemption-status/:tokenId', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;
    const { tokenId } = request.params as { tokenId: string };
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(tokenId)) return reply.status(400).send({ error: 'Invalid tokenId' });

    const token = await prisma.redemptionToken.findFirst({
      where: { id: tokenId, tenantId, consumerAccountId: accountId },
      select: { id: true, status: true, usedAt: true, expiresAt: true, product: { select: { name: true } } },
    });
    if (!token) return reply.status(404).send({ error: 'Token not found' });

    return {
      tokenId: token.id,
      status: token.status, // pending | used | expired
      usedAt: token.usedAt,
      expiresAt: token.expiresAt,
      productName: token.product?.name || null,
    };
  });

  // Consumer-initiated cancel on a pending redemption. Same reversal
  // mechanics as the TTL expiry (REDEMPTION_EXPIRED double-entry that
  // refunds the consumer and empties the holding account), just triggered
  // early and stamped with metadata.cancelledByConsumer so the history
  // view can tell the two apart. Token status lands at 'expired' — same
  // terminal state as a TTL burn, no schema migration needed (Genesis L2).
  app.post('/api/consumer/redemption/:tokenId/cancel', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;
    const { tokenId } = request.params as { tokenId: string };
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(tokenId)) return reply.status(400).send({ error: 'Invalid tokenId' });

    const token = await prisma.redemptionToken.findFirst({
      where: { id: tokenId, tenantId, consumerAccountId: accountId },
      include: { product: { select: { name: true, photoUrl: true } } },
    });
    if (!token) return reply.status(404).send({ error: 'Token not found' });
    if (token.status !== 'pending') {
      return reply.status(409).send({ error: `Cannot cancel a ${token.status} redemption` });
    }

    const { getSystemAccount } = await import('../../services/accounts.js');
    const { writeDoubleEntry } = await import('../../services/ledger.js');
    const holding = await getSystemAccount(tenantId, 'redemption_holding');
    if (!holding) return reply.status(500).send({ error: 'redemption_holding not configured' });

    // Skip the ledger reversal for 0-amount (full-cash) redemptions — the
    // PENDING side only had a nominal 0.00000001 placeholder and refunding
    // it would violate the CHECK constraint on positive amounts.
    if (Number(token.amount) > 0) {
      await writeDoubleEntry({
        tenantId,
        eventType: 'REDEMPTION_EXPIRED',
        debitAccountId: holding.id,
        creditAccountId: accountId,
        amount: token.amount.toString(),
        assetTypeId: token.assetTypeId,
        referenceId: `EXPIRED-${tokenId}`,
        referenceType: 'redemption_token',
        metadata: {
          productId: token.productId,
          productName: token.product?.name || null,
          productPhotoUrl: token.product?.photoUrl || null,
          cancelledByConsumer: true,
        },
      });
    }

    await prisma.redemptionToken.update({
      where: { id: tokenId },
      data: { status: 'expired' },
    });

    return { cancelled: true, tokenId };
  });

  app.get('/api/consumer/active-redemptions', { preHandler: [requireConsumerAuth] }, async (request) => {
    const { accountId, tenantId } = request.consumer!;
    const now = new Date();

    const tokens = await prisma.redemptionToken.findMany({
      where: {
        tenantId,
        consumerAccountId: accountId,
        status: 'pending',
        expiresAt: { gt: now },
      },
      include: { product: { select: { id: true, name: true, photoUrl: true, redemptionCost: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      redemptions: tokens.map(t => {
        // Reconstruct the full signed token (base64 JSON of { payload, signature }).
        // `amount` must use the same fixed(8) representation the signer used —
        // Decimal.toString() drops trailing zeros ("12" vs "12.00000000") and a
        // single char diff in the re-serialized JSON breaks the HMAC check.
        const payload = {
          tokenId: t.id,
          consumerAccountId: t.consumerAccountId,
          productId: t.productId,
          amount: t.amount.toFixed(8),
          tenantId: t.tenantId,
          assetTypeId: t.assetTypeId,
          createdAt: t.createdAt.toISOString(),
          expiresAt: t.expiresAt.toISOString(),
        };
        const token = Buffer.from(JSON.stringify({ payload, signature: t.tokenSignature })).toString('base64');
        return {
          id: t.id,
          token,
          shortCode: t.shortCode,
          productName: t.product.name,
          productPhoto: t.product.photoUrl,
          amount: t.amount.toString(),
          cashAmount: t.cashAmount?.toString() || null,
          expiresAt: t.expiresAt.toISOString(),
          secondsRemaining: Math.max(0, Math.floor((t.expiresAt.getTime() - now.getTime()) / 1000)),
          createdAt: t.createdAt.toISOString(),
        };
      }),
    };
  });

  // ---- UPLOAD IMAGE (for dispute screenshots) ----
  app.post('/api/consumer/upload-image', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return reply.status(400).send({ error: 'Invalid file type. Allowed: JPEG, PNG, WebP' });
    }

    const buffer = await file.toBuffer();
    const url = await uploadImage(buffer, 'loyalty-platform/disputes');

    if (!url) {
      return reply.status(500).send({ error: 'Image upload failed' });
    }

    return { success: true, url };
  });

  // ---- DUAL-SCAN: Consumer confirms a cashier-generated transaction QR ----
  app.post('/api/consumer/dual-scan/confirm', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { phoneNumber } = request.consumer!;
    const { token } = request.body as { token: string };

    if (!token) {
      return reply.status(400).send({ error: 'token is required' });
    }
    if (!phoneNumber || typeof phoneNumber !== 'string' || phoneNumber.trim().length < 7) {
      // Tokens issued during certain partial-session states can miss the phone
      // (e.g. a user who lost their cookie but still has a stale accessToken).
      // Without this guard the service crashed with a Prisma validation error
      // instead of returning a friendly message.
      return reply.status(401).send({ error: 'Sesion sin telefono. Vuelve a iniciar sesion para procesar el canje.' });
    }

    const { confirmDualScan } = await import('../../services/dual-scan.js');
    const result = await confirmDualScan({ token, consumerPhone: phoneNumber });

    if (!result.success) {
      return reply.status(400).send({ error: result.message });
    }

    return result;
  });

  // ---- SUBMIT DISPUTE ----
  app.post('/api/consumer/disputes', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;
    const { description, screenshotUrl } = request.body as { description: string; screenshotUrl?: string };

    if (!description || description.trim().length === 0) {
      return reply.status(400).send({ error: 'description is required' });
    }

    const dispute = await createDispute({
      tenantId,
      consumerAccountId: accountId,
      description: description.trim(),
      screenshotUrl: screenshotUrl || undefined,
    });

    return { success: true, dispute: { id: dispute.id, status: dispute.status, createdAt: dispute.createdAt } };
  });
}
