import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { initiateRedemption } from '../../../services/redemption.js';
import { requireConsumerAuth } from '../../middleware/auth.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../../../services/idempotency.js';

export async function registerRedemptionRoutes(app: FastifyInstance): Promise<void> {
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

    const { getSystemAccount } = await import('../../../services/accounts.js');
    const { writeDoubleEntry } = await import('../../../services/ledger.js');
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

    const { confirmDualScan } = await import('../../../services/dual-scan.js');
    const result = await confirmDualScan({ token, consumerPhone: phoneNumber });

    if (!result.success) {
      return reply.status(400).send({ error: result.message });
    }

    return result;
  });
}
