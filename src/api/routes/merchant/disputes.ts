import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { listDisputes, resolveDispute } from '../../../services/disputes.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

export async function registerDisputesRoutes(app: FastifyInstance): Promise<void> {
  // ---- DISPUTES (Owner only) ----
  app.get('/api/merchant/disputes', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { status } = request.query as { status?: string };

    const disputes = await listDisputes(tenantId, status || undefined);

    // Enrich with consumer info
    const enriched = await Promise.all(disputes.map(async (d) => {
      const account = await prisma.account.findUnique({ where: { id: d.consumerAccountId } });
      return {
        id: d.id,
        description: d.description,
        screenshotUrl: d.screenshotUrl,
        status: d.status,
        consumerPhone: account?.phoneNumber || null,
        consumerAccountId: d.consumerAccountId,
        resolutionReason: d.resolutionReason,
        createdAt: d.createdAt,
        resolvedAt: d.resolvedAt,
      };
    }));

    return { disputes: enriched };
  });

  app.post('/api/merchant/disputes/:id/resolve', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { id } = request.params as { id: string };
    const { action, reason, adjustmentAmount, assetTypeId } = request.body as {
      action: 'approve' | 'reject' | 'escalate';
      reason: string;
      adjustmentAmount?: string;
      assetTypeId?: string;
    };

    if (!action || !reason) return reply.status(400).send({ error: 'action and reason are required' });

    // Verify dispute belongs to this tenant
    const dispute = await prisma.dispute.findFirst({ where: { id, tenantId } });
    if (!dispute) return reply.status(404).send({ error: 'Dispute not found' });

    // For approve, get assetTypeId if not provided
    let resolvedAssetTypeId = assetTypeId;
    if (action === 'approve' && adjustmentAmount && !resolvedAssetTypeId) {
      const at = await prisma.assetType.findFirst();
      resolvedAssetTypeId = at?.id;
    }

    const result = await resolveDispute({
      disputeId: id,
      action,
      reason,
      resolverId: staffId,
      resolverType: 'staff',
      adjustmentAmount: action === 'approve' ? adjustmentAmount : undefined,
      assetTypeId: action === 'approve' ? resolvedAssetTypeId : undefined,
    });

    return result;
  });
}
