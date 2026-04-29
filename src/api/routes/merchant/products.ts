import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

// Identity-fields whose change bumps an audit counter. Eric removed the
// 2-edit cap on 2026-04-23 ("no podemos limitar a los comercios la
// edicion de sus productos") — merchants need to adjust points, promos
// and reshuffle stock freely. We keep incrementing identityEditCount so
// the audit log still shows how many times a card's identity shifted,
// but we no longer reject edits past a threshold.
const IDENTITY_FIELDS = ['name', 'description', 'photoUrl', 'redemptionCost', 'cashPrice'] as const;

export async function registerProductsRoutes(app: FastifyInstance): Promise<void> {
  // ---- CATALOG MANAGEMENT (Owner only) ----
  app.get('/api/merchant/products', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { archived } = request.query as { archived?: string };
    // Default list hides archived cards; ?archived=true flips to the
    // archived bin so the merchant can restore them from a dedicated
    // section of the page.
    const where: any = { tenantId };
    if (archived === 'true') where.archivedAt = { not: null };
    else where.archivedAt = null;
    const products = await prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        branch: { select: { id: true, name: true } },
        branchAssignments: { include: { branch: { select: { id: true, name: true } } } },
      },
    });
    return {
      products: products.map(p => {
        const assignments = p.branchAssignments
          .map(a => ({ id: a.branch.id, name: a.branch.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          ...p,
          // Legacy single-branch hint (first assignment, if any) — kept so
          // any UI still reading p.branchId/p.branchName keeps rendering.
          branchName: assignments[0]?.name ?? null,
          // New multi-branch surface: explicit list of sucursal ids/names
          // the product is scoped to. Empty array === tenant-wide.
          branchIds: assignments.map(a => a.id),
          branchNames: assignments.map(a => a.name),
        };
      }),
    };
  });

  app.post('/api/merchant/products', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { name, description, photoUrl, redemptionCost, cashPrice, assetTypeId, stock, minLevel, branchId, branchIds } = request.body as any;

    if (!name || !redemptionCost || !assetTypeId) {
      return reply.status(400).send({ error: 'name, redemptionCost, and assetTypeId are required' });
    }

    // Resolve sucursal scope. New shape: branchIds (array). Legacy shape:
    // branchId (single) — still accepted so older clients in flight during
    // the deploy window keep working. Empty/absent === tenant-wide.
    let resolvedBranchIds: string[] = [];
    if (Array.isArray(branchIds) && branchIds.length > 0) {
      const valid = await prisma.branch.findMany({
        where: { tenantId, id: { in: branchIds } },
        select: { id: true },
      });
      if (valid.length !== branchIds.length) {
        return reply.status(400).send({ error: 'Una o mas sucursales no son validas' });
      }
      resolvedBranchIds = valid.map(b => b.id);
    } else if (branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId } });
      if (!branch) return reply.status(400).send({ error: 'Sucursal no valida' });
      resolvedBranchIds = [branch.id];
    }

    // Plan limit check
    const { enforceLimit } = await import('../../../services/plan-limits.js');
    try { await enforceLimit(tenantId, 'products_in_catalog'); }
    catch (e: any) { return reply.status(402).send({ error: e.message, usage: e.usage }); }

    // Mirror the first selection into the legacy branchId column so any
    // code still reading p.branchId keeps showing a sensible "primary"
    // sucursal. Multi-sucursal scope lives in product_branches.
    const product = await prisma.product.create({
      data: {
        tenantId,
        branchId: resolvedBranchIds[0] ?? null,
        name, description, photoUrl, redemptionCost,
        cashPrice: cashPrice || null,
        assetTypeId,
        stock: stock || 0,
        minLevel: minLevel || 1,
        active: true,
        branchAssignments: resolvedBranchIds.length
          ? { create: resolvedBranchIds.map(branchId => ({ branchId })) }
          : undefined,
      },
    });

    // Audit
    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${request.staff!.staffId}::uuid, 'staff', 'owner', 'PRODUCT_CREATED', 'success',
        ${JSON.stringify({ productId: product.id, name, branchIds: resolvedBranchIds })}::jsonb, now())
    `;

    return { product };
  });

  app.put('/api/merchant/products/:id', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };
    const data = request.body as any;

    const product = await prisma.product.findFirst({ where: { id, tenantId } });
    if (!product) return reply.status(404).send({ error: 'Product not found' });

    if (product.archivedAt) {
      return reply.status(409).send({
        error: 'Esta tarjeta esta archivada. Restaurala primero para editarla.',
      });
    }

    const current: Record<string, unknown> = {
      name: product.name,
      description: product.description ?? null,
      photoUrl: product.photoUrl ?? null,
      redemptionCost: product.redemptionCost.toString(),
      cashPrice: product.cashPrice?.toString() ?? null,
    };
    const incoming: Record<string, unknown> = {
      name: data.name ?? product.name,
      description: data.description ?? product.description ?? null,
      photoUrl: data.photoUrl ?? product.photoUrl ?? null,
      redemptionCost: data.redemptionCost != null
        ? data.redemptionCost.toString()
        : product.redemptionCost.toString(),
      cashPrice: data.cashPrice !== undefined
        ? (data.cashPrice ? data.cashPrice.toString() : null)
        : (product.cashPrice?.toString() ?? null),
    };
    const identityChanged = IDENTITY_FIELDS.some(f => current[f] !== incoming[f]);

    const newStock = data.stock != null ? parseInt(data.stock) : product.stock;

    // Stock ↔ active coupling with owner-intent preservation:
    //   * stock → 0: auto-disable and mark stockAutoDisabled so a later
    //     restock can auto-re-enable.
    //   * stock 0→>0 AND card was auto-disabled: auto-reactivate and
    //     clear the flag.
    //   * stock 0→>0 AND owner had explicitly turned it off: leave it
    //     off (respect intent).
    //   * Any explicit data.active in the body wins outright and is
    //     treated as owner intent.
    let nextActive: boolean = product.active;
    let nextAutoDisabled: boolean = product.stockAutoDisabled;

    if (newStock <= 0) {
      // Losing stock always auto-disables. Mark flag only if we're
      // flipping the state; otherwise keep whatever was there.
      if (product.active) {
        nextActive = false;
        nextAutoDisabled = true;
      }
    } else if (product.stock <= 0 && newStock > 0 && product.stockAutoDisabled) {
      nextActive = true;
      nextAutoDisabled = false;
    }

    if (data.active !== undefined) {
      nextActive = !!data.active;
      nextAutoDisabled = false; // explicit owner choice clears the flag
      if (nextActive && newStock <= 0) {
        return reply.status(400).send({
          error: 'No tienes stock — agrega stock para activar la tarjeta.',
        });
      }
    }

    // Sucursal reassignment. New shape: branchIds (array). Legacy shape:
    // branchId (single). `undefined` = "don't touch". Empty array / null
    // means "vuelve a Todas las sucursales" — clears the join.
    let nextBranchIds: string[] | undefined = undefined;
    if (Array.isArray(data.branchIds)) {
      if (data.branchIds.length === 0) {
        nextBranchIds = [];
      } else {
        const valid = await prisma.branch.findMany({
          where: { tenantId, id: { in: data.branchIds } },
          select: { id: true },
        });
        if (valid.length !== data.branchIds.length) {
          return reply.status(400).send({ error: 'Una o mas sucursales no son validas' });
        }
        nextBranchIds = valid.map(b => b.id);
      }
    } else if (data.branchId === null || data.branchId === '') {
      nextBranchIds = [];
    } else if (typeof data.branchId === 'string') {
      const branch = await prisma.branch.findFirst({ where: { id: data.branchId, tenantId } });
      if (!branch) return reply.status(400).send({ error: 'Sucursal no valida' });
      nextBranchIds = [branch.id];
    }

    const updated = await prisma.product.update({
      where: { id },
      data: {
        name: incoming.name as string,
        description: (incoming.description as string | null) ?? null,
        photoUrl: (incoming.photoUrl as string | null) ?? null,
        redemptionCost: incoming.redemptionCost as string,
        cashPrice: incoming.cashPrice as string | null,
        stock: newStock,
        minLevel: data.minLevel != null ? parseInt(data.minLevel) : product.minLevel,
        active: nextActive,
        stockAutoDisabled: nextAutoDisabled,
        identityEditCount: identityChanged ? product.identityEditCount + 1 : product.identityEditCount,
        // Mirror the first selection into the legacy column so the catalog
        // card's "primary" sucursal label keeps rendering.
        ...(nextBranchIds !== undefined ? { branchId: nextBranchIds[0] ?? null } : {}),
      },
    });

    // Sync the join table separately. We delete + re-create rather than
    // diffing because the typical edit touches at most a handful of
    // branches, and the simpler write keeps the transaction trivially
    // correct under concurrent edits.
    if (nextBranchIds !== undefined) {
      await prisma.$transaction([
        prisma.productBranch.deleteMany({ where: { productId: id } }),
        ...(nextBranchIds.length
          ? [prisma.productBranch.createMany({
              data: nextBranchIds.map(branchId => ({ productId: id, branchId })),
            })]
          : []),
      ]);
    }

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${request.staff!.staffId}::uuid, 'staff', 'owner', 'PRODUCT_UPDATED', 'success',
        ${JSON.stringify({ productId: id, identityChanged, editCount: updated.identityEditCount })}::jsonb, now())
    `;

    return { product: updated };
  });

  app.patch('/api/merchant/products/:id/toggle', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };

    const product = await prisma.product.findFirst({ where: { id, tenantId } });
    if (!product) return reply.status(404).send({ error: 'Product not found' });
    if (product.archivedAt) {
      return reply.status(409).send({ error: 'Esta tarjeta esta archivada. Restaurala primero.' });
    }

    const nextActive = !product.active;
    if (nextActive && product.stock <= 0) {
      return reply.status(400).send({
        error: 'No tienes stock — agrega stock para activar la tarjeta.',
      });
    }

    const updated = await prisma.product.update({
      where: { id },
      data: {
        active: nextActive,
        // Explicit owner toggle always overrides the auto-disabled flag
        // so a later restock doesn't unexpectedly revive a card the
        // owner meant to kill (or vice versa).
        stockAutoDisabled: false,
      },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${request.staff!.staffId}::uuid, 'staff', 'owner', 'PRODUCT_TOGGLED', 'success',
        ${JSON.stringify({ productId: id, active: updated.active })}::jsonb, now())
    `;

    return { product: updated };
  });

  // ---- ARCHIVE PRODUCT (Owner only) ----
  // Hides the card from the catalog without deleting. Historical
  // redemption tokens keep their FK intact. Does NOT consume an
  // identity-edit slot.
  app.patch('/api/merchant/products/:id/archive', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { id } = request.params as { id: string };

    const product = await prisma.product.findFirst({ where: { id, tenantId } });
    if (!product) return reply.status(404).send({ error: 'Product not found' });
    if (product.archivedAt) return reply.status(400).send({ error: 'Ya esta archivada.' });

    const updated = await prisma.product.update({
      where: { id },
      data: { archivedAt: new Date(), active: false, stockAutoDisabled: false },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'owner', 'PRODUCT_UPDATED', 'success',
        ${JSON.stringify({ productId: id, action: 'archived' })}::jsonb, now())
    `;

    return { product: updated };
  });

  app.patch('/api/merchant/products/:id/unarchive', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { id } = request.params as { id: string };

    const product = await prisma.product.findFirst({ where: { id, tenantId } });
    if (!product) return reply.status(404).send({ error: 'Product not found' });
    if (!product.archivedAt) return reply.status(400).send({ error: 'No esta archivada.' });

    const updated = await prisma.product.update({
      where: { id },
      data: { archivedAt: null },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'owner', 'PRODUCT_UPDATED', 'success',
        ${JSON.stringify({ productId: id, action: 'unarchived' })}::jsonb, now())
    `;

    return { product: updated };
  });
}
