import type { FastifyInstance } from 'fastify';
import prisma from '../../db/client.js';
import { generateOTP, verifyOTP, issueConsumerTokens, verifyConsumerToken } from '../../services/auth.js';
import { findOrCreateConsumerAccount } from '../../services/accounts.js';
import { getAccountBalance, getAccountHistory } from '../../services/ledger.js';
import { validateInvoice } from '../../services/invoice-validation.js';
import { initiateRedemption } from '../../services/redemption.js';
import { requireConsumerAuth } from '../middleware/auth.js';

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

    // In production: send OTP via Evolution API WhatsApp
    // For now: return it in response (dev mode only)
    return { success: true, message: 'OTP sent via WhatsApp', otp: process.env.NODE_ENV === 'development' ? otp : undefined };
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

    return { success: true, ...tokens, account: { id: account.id, type: account.accountType, phoneNumber } };
  });

  // ---- AUTH: Refresh token ----
  app.post('/api/consumer/auth/refresh', async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken: string };
    if (!refreshToken) return reply.status(400).send({ error: 'refreshToken required' });

    try {
      const payload = verifyConsumerToken(refreshToken);
      const tokens = issueConsumerTokens({
        accountId: payload.accountId,
        tenantId: payload.tenantId,
        phoneNumber: payload.phoneNumber,
        type: 'consumer',
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

    if (!assetType) return { balance: '0', unitLabel: 'points' };

    const balance = await getAccountBalance(accountId, assetType.id, tenantId);
    return { balance, unitLabel: assetType.unitLabel, assetTypeId: assetType.id };
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

  // ---- INVOICE VALIDATION (from PWA) ----
  app.post('/api/consumer/validate-invoice', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId, phoneNumber } = request.consumer!;
    const { extractedData, latitude, longitude, deviceId, assetTypeId } = request.body as any;

    if (!extractedData || !assetTypeId) {
      return reply.status(400).send({ error: 'extractedData and assetTypeId are required' });
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

    return result;
  });

  // ---- PRODUCT CATALOG ----
  app.get('/api/consumer/catalog', { preHandler: [requireConsumerAuth] }, async (request) => {
    const { accountId, tenantId } = request.consumer!;

    const products = await prisma.product.findMany({
      where: { tenantId, active: true, stock: { gt: 0 } },
      orderBy: { name: 'asc' },
    });

    // Get consumer balance
    const assetType = await prisma.assetType.findFirst();
    const balance = assetType
      ? await getAccountBalance(accountId, assetType.id, tenantId)
      : '0';

    return {
      products: products.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        photoUrl: p.photoUrl,
        redemptionCost: p.redemptionCost.toString(),
        stock: p.stock,
        canAfford: parseFloat(balance) >= Number(p.redemptionCost),
      })),
      balance,
    };
  });

  // ---- INITIATE REDEMPTION ----
  app.post('/api/consumer/redeem', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;
    const { productId, assetTypeId } = request.body as { productId: string; assetTypeId: string };

    if (!productId || !assetTypeId) {
      return reply.status(400).send({ error: 'productId and assetTypeId are required' });
    }

    const result = await initiateRedemption({
      consumerAccountId: accountId,
      productId,
      tenantId,
      assetTypeId,
    });

    return result;
  });
}
