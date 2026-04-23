import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireAdminAuth } from './_middleware.js';

export async function registerManualReviewRoutes(app: FastifyInstance): Promise<void> {
  // ---- MANUAL REVIEW QUEUE (Admin — cross-tenant) ----
  app.get('/api/admin/manual-review', { preHandler: [requireAdminAuth] }, async (request) => {
    const { tenantId } = request.query as any;
    const where: any = { status: { in: ['manual_review', 'pending_validation'] } };
    if (tenantId) where.tenantId = tenantId;

    const invoices = await prisma.invoice.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: { tenant: { select: { name: true } }, consumerAccount: { select: { phoneNumber: true } } },
    });
    return { invoices: invoices.map(i => ({
      id: i.id, tenantName: i.tenant?.name, invoiceNumber: i.invoiceNumber,
      amount: i.amount.toString(), status: i.status, rejectionReason: i.rejectionReason,
      consumerPhone: i.consumerAccount?.phoneNumber, createdAt: i.createdAt,
    })) };
  });

  app.post('/api/admin/manual-review/:id/resolve', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { action, reason } = request.body as { action: 'approve' | 'reject'; reason: string };
    if (!action || !reason) return reply.status(400).send({ error: 'action and reason required' });

    const { resolveManualReview } = await import('../../../services/reconciliation.js');
    const result = await resolveManualReview({
      invoiceId: id, action, reason,
      resolverType: 'admin', resolverId: (request as any).admin.adminId,
    });
    return result;
  });
}
