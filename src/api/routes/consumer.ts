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
  app.post('/api/consumer/auth/request-otp', async (request, reply) => {
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
    return {
      balance: breakdown.total,           // total displayed (confirmed + provisional)
      confirmed: breakdown.confirmed,
      provisional: breakdown.provisional,
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
    for (const e of entries) {
      if (!redemptionEventTypes.has(e.eventType)) continue;
      const tid = refToTokenId(e.referenceId);
      if (tid) tokenIdByRef.set(e.referenceId, tid);
    }
    const redemptionTokenIds = Array.from(new Set(tokenIdByRef.values()));

    const tokens = redemptionTokenIds.length > 0
      ? await prisma.redemptionToken.findMany({
          where: { id: { in: redemptionTokenIds } },
          select: { id: true, product: { select: { name: true, photoUrl: true } } },
        })
      : [];
    const productByTokenId = new Map(tokens.map(t => [t.id, t.product]));

    return {
      entries: entries.map(e => {
        // Prefer metadata stamped at write time (survives token cleanup);
        // fall back to the token join for older entries.
        const meta: any = (e as any).metadata || {};
        const metaProduct = (meta?.productName || meta?.productPhotoUrl)
          ? { name: meta.productName || null, photoUrl: meta.productPhotoUrl || null }
          : null;
        const tid = redemptionEventTypes.has(e.eventType) ? tokenIdByRef.get(e.referenceId) : undefined;
        const product = metaProduct || (tid ? productByTokenId.get(tid) : undefined);
        return {
          id: e.id,
          eventType: e.eventType,
          entryType: e.entryType,
          amount: e.amount.toString(),
          status: e.status,
          referenceId: e.referenceId,
          createdAt: e.createdAt,
          merchantName: tenant?.name || null,
          productName: product?.name || null,
          productPhotoUrl: product?.photoUrl || null,
        };
      }),
    };
  });

  // ---- ACCOUNT INFO ----
  app.get('/api/consumer/account', { preHandler: [requireConsumerAuth] }, async (request) => {
    const { accountId, tenantId } = request.consumer!;
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
      merchantLogo: tenant?.qrCodeUrl || null,
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

    // Use last-10-digit matching so legacy accounts stored in any phone format
    // (with/without +, with/without leading 0, with separators) still resolve.
    const allAccounts = await prisma.account.findMany({
      where: tail.length === 10
        ? { phoneNumber: { endsWith: tail }, accountType: { in: ['shadow', 'verified'] } }
        : { phoneNumber, accountType: { in: ['shadow', 'verified'] } },
      include: { tenant: true },
      orderBy: { createdAt: 'desc' },
    });

    // Deduplicate: if the same user has multiple account records for the same
    // tenant (from phone-format variations), keep only the most recent.
    // Also filter out inactive tenants.
    const seenTenants = new Set<string>();
    const accounts = allAccounts.filter(acc => {
      if (acc.tenant.status !== 'active') return false;
      if (seenTenants.has(acc.tenantId)) return false;
      seenTenants.add(acc.tenantId);
      return true;
    });

    const merchants = await Promise.all(accounts.map(async (acc) => {
      // Pick the tenant's primary asset type
      const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId: acc.tenantId } });
      const assetType = assetConfig
        ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
        : await prisma.assetType.findFirst();

      let balance = '0';
      let unitLabel = 'pts';
      if (assetType) {
        balance = await getAccountBalance(acc.id, assetType.id, acc.tenantId);
        unitLabel = assetType.unitLabel;
      }

      // Top 3 products by lowest cost (entry-level redemptions are most attractive)
      const topProducts = await prisma.product.findMany({
        where: { tenantId: acc.tenantId, active: true, stock: { gt: 0 } },
        orderBy: { redemptionCost: 'asc' },
        take: 3,
        select: { id: true, name: true, photoUrl: true, redemptionCost: true, stock: true },
      });

      return {
        accountId: acc.id,
        tenantId: acc.tenantId,
        tenantName: acc.tenant.name,
        tenantSlug: acc.tenant.slug,
        accountType: acc.accountType,
        balance,
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

    // Compute total balance across merchants (note: only meaningful if all use the same unit)
    const totalBalance = merchants.reduce((sum, m) => sum + Number(m.balance), 0);

    // Pick the best display name available across this user's accounts
    // (verified/non-null wins; otherwise the most recent).
    const displayName = accounts
      .map(a => a.displayName)
      .find((n): n is string => !!n && n.trim().length > 0) || null;

    return {
      phoneNumber,
      displayName,
      merchantCount: merchants.length,
      totalBalance: totalBalance.toFixed(8),
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
        }
      }

      if (!imageBuffer) {
        return reply.status(400).send({ error: 'An invoice image file is required (field name: "invoice")' });
      }
      if (!assetTypeId) {
        return reply.status(400).send({ error: 'assetTypeId is required' });
      }

      const result = await validateInvoice({
        tenantId,
        senderPhone: phoneNumber,
        assetTypeId,
        imageBuffer,
        latitude,
        longitude,
        deviceId,
      });

      // Store idempotency after successful validation (per-user)
      if (result.success && result.invoiceNumber) {
        const idempotencyKey = `invoice:${tenantId}:${phoneNumber}:${result.invoiceNumber}`;
        await storeIdempotencyKey(idempotencyKey, 'invoice_validation', result);
      }

      return result;
    }

    // --- JSON path (pre-extracted data, used by tests or WhatsApp pipeline) ---
    const { extractedData, latitude, longitude, deviceId, assetTypeId, ocrRawText } = request.body as any;

    if (!extractedData || !assetTypeId) {
      return reply.status(400).send({ error: 'extractedData and assetTypeId are required' });
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
    const { productId, assetTypeId, cashAmount, requestId } = request.body as { productId: string; assetTypeId: string; cashAmount?: string; requestId?: string };

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
        // Reconstruct the full signed token (base64 JSON of { payload, signature })
        const payload = {
          tokenId: t.id,
          consumerAccountId: t.consumerAccountId,
          productId: t.productId,
          amount: t.amount.toString(),
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
