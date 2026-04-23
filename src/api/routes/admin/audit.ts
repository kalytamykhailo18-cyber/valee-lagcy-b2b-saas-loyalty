import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireAdminAuth } from './_middleware.js';

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  // ---- AUDIT LOG VIEW ----
  app.get('/api/admin/audit-log', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { tenantId, actionType, limit = '50', offset = '0' } = request.query as any;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (tenantId && !UUID_RE.test(String(tenantId))) {
      return reply.status(400).send({ error: 'tenantId must be a valid UUID' });
    }
    const lim = Math.min(200, Math.max(1, parseInt(limit) || 50));
    const off = Math.max(0, parseInt(offset) || 0);

    const where: any = {};
    if (tenantId) where.tenantId = tenantId;
    if (actionType) where.actionType = actionType;

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: lim,
        skip: off,
        include: {
          tenant: { select: { name: true, slug: true } },
          consumerAccount: { select: { phoneNumber: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      total,
      limit: lim,
      offset: off,
      entries: rows.map(r => ({
        id: r.id,
        tenantId: r.tenantId,
        tenantName: r.tenant?.name || null,
        actorType: r.actorType,
        actorRole: r.actorRole,
        actorId: r.actorId,
        actionType: r.actionType,
        consumerAccountId: r.consumerAccountId,
        consumerPhone: r.consumerAccount?.phoneNumber || null,
        outcome: r.outcome,
        amount: r.amount?.toString() || null,
        metadata: r.metadata,
        createdAt: r.createdAt,
      })),
    };
  });
}
