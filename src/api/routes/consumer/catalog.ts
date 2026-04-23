import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { getAccountBalanceBreakdown } from '../../../services/ledger.js';
import { requireConsumerAuth } from '../../middleware/auth.js';

export async function registerCatalogRoutes(app: FastifyInstance): Promise<void> {
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

    const where = { tenantId, active: true, archivedAt: null, stock: { gt: 0 } as any, minLevel: { lte: consumerLevel } };

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
}
