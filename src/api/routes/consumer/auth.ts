import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { generateOTP, verifyOTP, issueConsumerTokens, verifyConsumerToken, incrementOtpBucket } from '../../../services/auth.js';
import { findOrCreateConsumerAccount, normalizeVenezuelanPhone } from '../../../services/accounts.js';
import { requireConsumerAuth } from '../../middleware/auth.js';
import { sendWhatsAppOTP } from '../../../services/whatsapp.js';
import { grantWelcomeBonus } from '../../../services/welcome-bonus.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // ---- PUBLIC: Merchant entry info ----
  // Serves the /consumer/<slug> landing page so it can render BOTH a
  // "Continuar aqui" (stay in PWA) button and an "Abrir en WhatsApp"
  // (jump to wa.me deep link) button. Eric 2026-04-27: switching the QR
  // to PWA-direct removed the WhatsApp option entirely; he wants both
  // surfaced so users (especially returning ones who like the bot) keep
  // their preferred entry.
  app.get('/api/consumer/merchant-entry/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { name: true, slug: true, status: true, qrCodeUrl: true },
    });
    if (!tenant || tenant.status !== 'active') {
      return reply.status(404).send({ error: 'Merchant not found' });
    }
    const botPhone = process.env.META_WHATSAPP_DISPLAY_PHONE || process.env.EVOLUTION_INSTANCE_NAME || '';
    let whatsappLink: string | null = null;
    if (botPhone) {
      const greet = `Hola! Quiero ganar puntos en ${tenant.name} `;
      const text = encodeURIComponent(`${greet}Valee Ref: ${tenant.slug}`);
      whatsappLink = `https://wa.me/${botPhone.replace(/\D/g, '')}?text=${text}`;
    }
    return {
      name: tenant.name,
      slug: tenant.slug,
      qrCodeUrl: tenant.qrCodeUrl,
      whatsappLink,
    };
  });

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
          // If this phone scanned a branch QR recently, inherit that
          // branch context so the welcome bonus ledger entry gets
          // stamped instead of showing as "sin sucursal" in the panel.
          const WINDOW_MIN = parseInt(process.env.MERCHANT_SCAN_WINDOW_MIN || '240');
          const cutoff = new Date(Date.now() - WINDOW_MIN * 60 * 1000);
          const recentScan = await prisma.merchantScanSession.findFirst({
            where: { tenantId: tenant.id, consumerPhone: phoneNumber, scannedAt: { gte: cutoff } },
            orderBy: { scannedAt: 'desc' },
            select: { branchId: true },
          });
          await grantWelcomeBonus(account.id, tenant.id, assetType.id, recentScan?.branchId || null);
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
    if (!tenant) {
      return reply.status(404).send({ error: 'Merchant not found' });
    }

    // Eric 2026-05-04 (Notion "Error en multicomercio"): if the tenant is
    // inactive, allow the consumer to enter ONLY if they already have an
    // account there with a positive balance. The page renders "comercio
    // inactivo" + saldo intact, no products, no welcome bonus, no
    // findOrCreate (which would create a fresh account at a dead merchant).
    if (tenant.status !== 'active') {
      const existing = await prisma.account.findUnique({
        where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber } },
      });
      if (!existing) {
        return reply.status(404).send({ error: 'Merchant not found' });
      }
      const tokens = issueConsumerTokens({
        accountId: existing.id,
        tenantId: tenant.id,
        phoneNumber,
        type: 'consumer' as const,
      });
      return {
        ...tokens,
        accountId: existing.id,
        tenantId: tenant.id,
        merchantName: tenant.name,
        merchantSlug: tenant.slug,
        tenantStatus: tenant.status,
        tenantActive: false,
      };
    }

    const { account } = await findOrCreateConsumerAccount(tenant.id, phoneNumber);

    try {
      const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId: tenant.id } });
      const assetType = assetConfig
        ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
        : await prisma.assetType.findFirst();
      if (assetType) {
        const WINDOW_MIN = parseInt(process.env.MERCHANT_SCAN_WINDOW_MIN || '240');
        const cutoff = new Date(Date.now() - WINDOW_MIN * 60 * 1000);
        const recentScan = await prisma.merchantScanSession.findFirst({
          where: { tenantId: tenant.id, consumerPhone: phoneNumber, scannedAt: { gte: cutoff } },
          orderBy: { scannedAt: 'desc' },
          select: { branchId: true },
        });
        await grantWelcomeBonus(account.id, tenant.id, assetType.id, recentScan?.branchId || null);
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
}
