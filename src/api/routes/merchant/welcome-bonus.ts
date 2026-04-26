import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

/**
 * Welcome bonus metrics for the merchant dashboard. Mirrors the referrals
 * metrics shape so the merchant has a single mental model for both incentives.
 * Eric 2026-04-25: "Esta son las unicas dos secciones donde el comercio emite
 * puntos de la nada, deben poder tener el control de lo que hacen."
 */
export async function registerWelcomeBonusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/merchant/welcome-bonus/metrics', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        welcomeBonusAmount: true,
        welcomeBonusActive: true,
        welcomeBonusLimit: true,
      },
    });

    // Welcome bonuses are recorded as ADJUSTMENT_MANUAL CREDIT rows with
    // referenceId starting with 'WELCOME-'. We aggregate over those.
    const welcomeRows = await prisma.ledgerEntry.findMany({
      where: {
        tenantId,
        eventType: 'ADJUSTMENT_MANUAL',
        entryType: 'CREDIT',
        referenceId: { startsWith: 'WELCOME-' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        amount: true,
        accountId: true,
        createdAt: true,
        branchId: true,
      },
    });

    const granted = welcomeRows.length;
    const totalPaid = welcomeRows.reduce(
      (sum, r) => sum + (r.amount ? Number(r.amount) : 0),
      0,
    );
    const limit = tenant?.welcomeBonusLimit ?? null;
    const remaining = limit != null ? Math.max(0, limit - granted) : null;

    const recent = welcomeRows.slice(0, 20);
    const acctIds = Array.from(new Set(recent.map(r => r.accountId).filter(Boolean) as string[]));
    const acctRows = acctIds.length > 0
      ? await prisma.account.findMany({
          where: { id: { in: acctIds } },
          select: { id: true, phoneNumber: true, displayName: true },
        })
      : [];
    const acctById = new Map(acctRows.map(a => [a.id, a]));

    const branchIds = Array.from(new Set(recent.map(r => r.branchId).filter(Boolean) as string[]));
    const branchRows = branchIds.length > 0
      ? await prisma.branch.findMany({
          where: { id: { in: branchIds } },
          select: { id: true, name: true },
        })
      : [];
    const branchById = new Map(branchRows.map(b => [b.id, b]));

    const recentEnriched = recent.map(r => {
      const a = r.accountId ? acctById.get(r.accountId) : null;
      const b = r.branchId ? branchById.get(r.branchId) : null;
      return {
        id: r.id,
        amount: r.amount.toString(),
        createdAt: r.createdAt,
        consumer: {
          phoneNumber: a?.phoneNumber || null,
          displayName: a?.displayName || null,
        },
        branchName: b?.name || null,
      };
    });

    return {
      config: {
        amount: tenant?.welcomeBonusAmount ?? 50,
        active: tenant?.welcomeBonusActive ?? true,
        limit,
      },
      summary: {
        granted,
        totalPaid: totalPaid.toFixed(8),
        limit,
        remaining,
        capReached: limit != null && granted >= limit,
      },
      recent: recentEnriched,
    };
  });
}
