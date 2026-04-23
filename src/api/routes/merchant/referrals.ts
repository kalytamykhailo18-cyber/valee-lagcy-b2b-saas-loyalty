import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

/**
 * Referral metrics for the merchant dashboard. Eric flagged on 2026-04-23
 * that the owner had no way to see how many referral codes had been handed
 * out, how many were actually scanned, and how many of those scans ended in
 * a first-purchase (which is when the referrer gets paid). The underlying
 * data is already there — referrals table + account.referralSlug — we just
 * surface it grouped by tenant.
 */
export async function registerReferralsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/merchant/referrals/metrics', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;

    const [codesIssued, pending, credited, rejected, bonusPaidRow] = await Promise.all([
      prisma.account.count({
        where: {
          tenantId,
          accountType: { in: ['shadow', 'verified'] },
          referralSlug: { not: null },
        },
      }),
      prisma.referral.count({ where: { tenantId, status: 'pending' } }),
      prisma.referral.count({ where: { tenantId, status: 'credited' } }),
      prisma.referral.count({ where: { tenantId, status: 'rejected' } }),
      prisma.referral.aggregate({
        where: { tenantId, status: 'credited' },
        _sum: { bonusAmount: true },
      }),
    ]);

    const scanned = pending + credited + rejected;

    // Top referrers — group credited referrals by referrer, show top 10.
    const topRaw = await prisma.referral.groupBy({
      by: ['referrerAccountId'],
      where: { tenantId, status: 'credited' },
      _count: { _all: true },
      _sum: { bonusAmount: true },
      orderBy: { _count: { referrerAccountId: 'desc' } },
      take: 10,
    });
    const referrerAccounts = topRaw.length > 0
      ? await prisma.account.findMany({
          where: { id: { in: topRaw.map(r => r.referrerAccountId) } },
          select: { id: true, phoneNumber: true, displayName: true, referralSlug: true },
        })
      : [];
    const refAcctById = new Map(referrerAccounts.map(a => [a.id, a]));
    const topReferrers = topRaw.map(r => {
      const a = refAcctById.get(r.referrerAccountId);
      return {
        accountId: r.referrerAccountId,
        phoneNumber: a?.phoneNumber || null,
        displayName: a?.displayName || null,
        referralSlug: a?.referralSlug || null,
        creditedCount: r._count._all,
        bonusTotal: (r._sum.bonusAmount ?? 0).toString(),
      };
    });

    // Recent referral activity (last 20). Include both sides so the owner
    // can see who referred whom and the current status.
    const recentRows = await prisma.referral.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        bonusAmount: true,
        createdAt: true,
        creditedAt: true,
        referrerAccountId: true,
        refereeAccountId: true,
      },
    });
    const acctIds = Array.from(new Set(recentRows.flatMap(r => [r.referrerAccountId, r.refereeAccountId])));
    const acctRows = acctIds.length > 0
      ? await prisma.account.findMany({
          where: { id: { in: acctIds } },
          select: { id: true, phoneNumber: true, displayName: true },
        })
      : [];
    const acctById = new Map(acctRows.map(a => [a.id, a]));
    const recent = recentRows.map(r => {
      const refr = acctById.get(r.referrerAccountId);
      const refe = acctById.get(r.refereeAccountId);
      return {
        id: r.id,
        status: r.status,
        bonusAmount: r.bonusAmount?.toString() ?? null,
        createdAt: r.createdAt,
        creditedAt: r.creditedAt,
        referrer: {
          phoneNumber: refr?.phoneNumber || null,
          displayName: refr?.displayName || null,
        },
        referee: {
          phoneNumber: refe?.phoneNumber || null,
          displayName: refe?.displayName || null,
        },
      };
    });

    return {
      summary: {
        codesIssued,
        codesScanned: scanned,
        pending,
        credited,
        rejected,
        bonusPaid: (bonusPaidRow._sum.bonusAmount ?? 0).toString(),
      },
      topReferrers,
      recent,
    };
  });
}
