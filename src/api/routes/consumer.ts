import type { FastifyInstance } from 'fastify';
import prisma from '../../db/client.js';
import { generateOTP, verifyOTP, issueConsumerTokens, verifyConsumerToken } from '../../services/auth.js';
import { findOrCreateConsumerAccount } from '../../services/accounts.js';
import { getAccountBalance, getAccountBalanceBreakdown, getAccountHistory } from '../../services/ledger.js';
import { validateInvoice } from '../../services/invoice-validation.js';
import { initiateRedemption } from '../../services/redemption.js';
import { requireConsumerAuth } from '../middleware/auth.js';
import { sendWhatsAppOTP } from '../../services/whatsapp.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../../services/idempotency.js';
import { createDispute } from '../../services/disputes.js';
import { uploadImage } from '../../services/cloudinary.js';

export default async function consumerRoutes(app: FastifyInstance) {

  // ---- AUTH: Request OTP ----
  app.post('/api/consumer/auth/request-otp', async (request, reply) => {
    const { phoneNumber, tenantSlug } = request.body as { phoneNumber: string; tenantSlug: string };

    if (!phoneNumber || !tenantSlug) {
      return reply.status(400).send({ error: 'phoneNumber and tenantSlug are required' });
    }

    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.status !== 'active') {
      return reply.status(404).send({ error: 'Merchant not found' });
    }

    const otp = await generateOTP(phoneNumber);

    // Send OTP via WhatsApp (Evolution API)
    await sendWhatsAppOTP(phoneNumber, otp);

    // Only expose OTP in dev mode for testing
    return { success: true, message: 'OTP sent via WhatsApp', otp: process.env.NODE_ENV !== 'production' ? otp : undefined };
  });

  // ---- AUTH: Verify OTP ----
  app.post('/api/consumer/auth/verify-otp', async (request, reply) => {
    const { phoneNumber, otp, tenantSlug } = request.body as { phoneNumber: string; otp: string; tenantSlug: string };

    if (!phoneNumber || !otp || !tenantSlug) {
      return reply.status(400).send({ error: 'phoneNumber, otp, and tenantSlug are required' });
    }

    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) return reply.status(404).send({ error: 'Merchant not found' });

    const valid = await verifyOTP(phoneNumber, otp);
    if (!valid) return reply.status(401).send({ error: 'Invalid or expired OTP' });

    const { account } = await findOrCreateConsumerAccount(tenant.id, phoneNumber);

    const tokens = issueConsumerTokens({
      accountId: account.id,
      tenantId: tenant.id,
      phoneNumber,
      type: 'consumer',
    });

    // Set HTTP-only secure cookies
    reply.setCookie('accessToken', tokens.accessToken, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
      maxAge: 15 * 60, // 15 minutes
    });
    reply.setCookie('refreshToken', tokens.refreshToken, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/api/consumer/auth/refresh',
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });

    return { success: true, ...tokens, account: { id: account.id, type: account.accountType, phoneNumber } };
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
  app.get('/api/consumer/balance', { preHandler: [requireConsumerAuth] }, async (request) => {
    const { accountId, tenantId } = request.consumer!;

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

    return {
      entries: entries.map(e => ({
        id: e.id,
        eventType: e.eventType,
        entryType: e.entryType,
        amount: e.amount.toString(),
        status: e.status,
        referenceId: e.referenceId,
        createdAt: e.createdAt,
        merchantName: tenant?.name || null,
      })),
    };
  });

  // ---- ACCOUNT INFO ----
  app.get('/api/consumer/account', { preHandler: [requireConsumerAuth] }, async (request) => {
    const { accountId, tenantId } = request.consumer!;
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

    return {
      id: account?.id,
      phoneNumber: account?.phoneNumber,
      accountType: account?.accountType,
      cedula: account?.cedula,
      merchantName: tenant?.name,
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

    const accounts = await prisma.account.findMany({
      where: { phoneNumber, accountType: { in: ['shadow', 'verified'] } },
      include: { tenant: true },
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

    return {
      phoneNumber,
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

      // Store idempotency after successful validation (key will be set once invoice_number is known)
      if (result.success && result.invoiceNumber) {
        const idempotencyKey = `invoice:${tenantId}:${result.invoiceNumber}`;
        await storeIdempotencyKey(idempotencyKey, 'invoice_validation', result);
      }

      return result;
    }

    // --- JSON path (pre-extracted data, used by tests or WhatsApp pipeline) ---
    const { extractedData, latitude, longitude, deviceId, assetTypeId } = request.body as any;

    if (!extractedData || !assetTypeId) {
      return reply.status(400).send({ error: 'extractedData and assetTypeId are required' });
    }

    // Idempotency check: if we have an invoice number from extracted data, check before processing
    if (extractedData?.invoice_number) {
      const idempotencyKey = `invoice:${tenantId}:${extractedData.invoice_number}`;
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
      latitude,
      longitude,
      deviceId,
    });

    // Store idempotency after successful validation
    if (result.success && (result.invoiceNumber || extractedData?.invoice_number)) {
      const invoiceNum = result.invoiceNumber || extractedData.invoice_number;
      const idempotencyKey = `invoice:${tenantId}:${invoiceNum}`;
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
