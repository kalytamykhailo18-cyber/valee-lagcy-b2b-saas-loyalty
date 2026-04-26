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
    const { limit = '20', offset = '0', branchId } = request.query as { limit?: string; offset?: string; branchId?: string };

    // Get consumer's level for reward filtering
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    const consumerLevel = account?.level || 1;

    // Branch scope. Genesis 2026-04-24: the consumer must see EVERY
    // product the merchant publishes (tenant-wide + branch-scoped),
    // each tagged with its branch so the customer knows where to pick
    // it up. Hiding branch-scoped products when the consumer has no
    // scan context made the catalog go empty for merchants who scoped
    // all their items to a branch. We keep the optional `branchId`
    // query parameter to let a branch-specific PWA view narrow the
    // list, but with no context we return everything.
    let branchClause: any = {};
    if (branchId && branchId !== 'all') {
      const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId } });
      if (branch) {
        branchClause = { OR: [{ branchId: branch.id }, { branchId: null }] };
      }
      // invalid id → fall through, same as no filter
    }

    const where = {
      tenantId,
      active: true,
      archivedAt: null,
      stock: { gt: 0 } as any,
      minLevel: { lte: consumerLevel },
      ...branchClause,
    };

    // Paginated product list for infinite scroll, with the branch name
    // joined so the card can render "Sucursal Centro" or "Todas las
    // sucursales".
    const products = await prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      take: parseInt(limit),
      skip: parseInt(offset),
      include: { branch: { select: { id: true, name: true } } },
    });

    const total = await prisma.product.count({ where });

    // For tenant-wide products (branchId=null), collect the list of
    // active branches so the consumer can see "Disponible en Centro,
    // Norte, Sur". Only fetched once — any product with branchId=null
    // gets the same list. If the tenant has no branches at all, skip.
    const anyWide = products.some(p => p.branchId === null);
    const tenantBranches = anyWide
      ? await prisma.branch.findMany({
          where: { tenantId, active: true },
          orderBy: { name: 'asc' },
          select: { name: true },
        })
      : [];

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
        // Branch locator (Genesis 2026-04-24): branch-scoped products
        // carry the branch name; tenant-wide products carry the full
        // list of active branches so the consumer sees where it's
        // honored. Empty branchNames + scope='tenant' means the tenant
        // has no branches configured (single-point operation).
        branchId: p.branchId,
        branchName: p.branch?.name ?? null,
        branchScope: p.branchId ? 'branch' : 'tenant',
        branchNames: p.branchId
          ? [p.branch?.name || '']
          : tenantBranches.map(b => b.name),
      })),
      total,
      balance: breakdown.total,
      confirmed: breakdown.confirmed,
      provisional: breakdown.provisional,
      consumerLevel,
    };
  });
}
