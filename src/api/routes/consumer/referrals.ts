import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireConsumerAuth } from '../../middleware/auth.js';

export async function registerReferralsRoutes(app: FastifyInstance): Promise<void> {
  // ---- REFERRAL QR ----
  // Returns the authenticated consumer's personal referral QR for THIS merchant.
  // Slug is created lazily on first request and kept stable thereafter, so the
  // same QR can be re-printed/shared without breaking old links.
  app.get('/api/consumer/referral-qr', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;
    if (!accountId || !tenantId) {
      return reply.status(409).send({ error: 'requires merchant selection', requiresMerchantSelection: true });
    }

    const { ensureReferralSlug } = await import('../../../services/referrals.js');
    const { generateReferralQR } = await import('../../../services/merchant-qr.js');

    const slug = await ensureReferralSlug(accountId);
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, name: true, referralBonusAmount: true, referralBonusActive: true } });
    if (!tenant) return reply.status(404).send({ error: 'tenant not found' });
    // Eric 2026-05-04 (Notion "Puntos por referidos"): if the merchant has
    // turned off the referral bonus, refuse to serve the QR. The PWA hides
    // the CTA on the home page; this guards the direct /invite URL too so
    // a savvy user can't bypass the merchant's setting.
    if (tenant.referralBonusActive === false) {
      return reply.status(403).send({
        error: 'El programa de referidos esta pausado por el comercio.',
        referralBonusActive: false,
      });
    }

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
}
