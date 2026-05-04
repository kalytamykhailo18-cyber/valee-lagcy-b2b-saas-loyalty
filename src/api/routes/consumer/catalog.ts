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
    //
    // Multi-sucursal scope (Eric 2026-04-26): products carry a join
    // (product_branches) with the sucursales they're available at.
    // Empty join === tenant-wide. A consumer at sucursal X sees a
    // product if it has no assignments OR has at least one matching X.
    let branchClause: any = {};
    if (branchId && branchId !== 'all') {
      const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId } });
      if (branch) {
        branchClause = {
          OR: [
            { branchAssignments: { none: {} } },
            { branchAssignments: { some: { branchId: branch.id } } },
          ],
        };
      }
      // invalid id → fall through, same as no filter
    }

    // Eric 2026-05-04 (Notion "Productos / Niveles"): higher-tier products
    // must REMAIN visible to lower-tier consumers (in B&W with a
    // "Solo valido para Socios Valee nivel N" tag) instead of being
    // filtered out — this becomes a visible upgrade incentive rather than
    // an empty catalog. Return the unfiltered set; the frontend renders
    // lock state from levelLocked + minLevel.
    const where = {
      tenantId,
      active: true,
      archivedAt: null,
      stock: { gt: 0 } as any,
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
      include: {
        branch: { select: { id: true, name: true } },
        branchAssignments: { include: { branch: { select: { id: true, name: true } } } },
      },
    });

    const total = await prisma.product.count({ where });

    // For tenant-wide products (no assignments), collect the list of
    // active branches so the consumer can see "Disponible en Centro,
    // Norte, Sur". Only fetched once — any tenant-wide product gets the
    // same list. If the tenant has no branches at all, skip.
    const anyWide = products.some(p => p.branchAssignments.length === 0);
    const tenantBranches = anyWide
      ? await prisma.branch.findMany({
          where: { tenantId, active: true },
          orderBy: { name: 'asc' },
          select: { name: true },
        })
      : [];

    // Get consumer balance. Affordability uses the spendable bucket
    // (confirmed + invoice-provisional, EXCLUDING cash-provisional). Eric
    // 2026-05-04 (Notion "Escaneo de pagos en efectivo"): cash payments
    // stay in verification until reconciled and cannot fund a canje.
    const assetType = await prisma.assetType.findFirst();
    const breakdown = assetType
      ? await getAccountBalanceBreakdown(accountId, assetType.id, tenantId)
      : { confirmed: '0', provisional: '0', cashProvisional: '0', spendable: '0', total: '0' };
    const spendableBalance = parseFloat(breakdown.spendable);

    return {
      products: products.map(p => {
        const assignments = p.branchAssignments
          .map(a => ({ id: a.branch.id, name: a.branch.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const isTenantWide = assignments.length === 0;
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          photoUrl: p.photoUrl,
          redemptionCost: p.redemptionCost.toString(),
          cashPrice: p.cashPrice?.toString() || null,
          hybridEnabled: p.cashPrice !== null && Number(p.cashPrice) > 0,
          stock: p.stock,
          minLevel: p.minLevel,
          levelLocked: p.minLevel > consumerLevel,
          canAfford: spendableBalance >= Number(p.redemptionCost) && p.minLevel <= consumerLevel,
          // Branch locator. Multi-sucursal scope (Eric 2026-04-26):
          // a product can be assigned to N sucursales — the consumer
          // sees them all in branchNames. Tenant-wide products list
          // every active sucursal so the consumer knows where to
          // pick it up. Empty branchNames + scope='tenant' === no
          // sucursales configured at all (single-point operation).
          branchId: assignments[0]?.id ?? null,
          branchName: assignments[0]?.name ?? null,
          branchIds: assignments.map(a => a.id),
          branchScope: isTenantWide ? 'tenant' : 'branch',
          branchNames: isTenantWide
            ? tenantBranches.map(b => b.name)
            : assignments.map(a => a.name),
        };
      }),
      total,
      balance: breakdown.total,
      confirmed: breakdown.confirmed,
      provisional: breakdown.provisional,
      cashProvisional: breakdown.cashProvisional,
      spendable: breakdown.spendable,
      consumerLevel,
    };
  });
}
