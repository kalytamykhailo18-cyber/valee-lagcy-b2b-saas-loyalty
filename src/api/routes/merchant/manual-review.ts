import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

export async function registerManualReviewRoutes(app: FastifyInstance): Promise<void> {
  // ---- MANUAL REVIEW QUEUE (Owner only) ----
  app.get('/api/merchant/manual-review', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const invoices = await prisma.invoice.findMany({
      where: { tenantId, status: { in: ['manual_review', 'pending_validation'] } },
      orderBy: { createdAt: 'desc' },
      include: { consumerAccount: { select: { phoneNumber: true } } },
    });
    return { invoices: invoices.map(i => ({
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      amount: i.amount.toString(),
      status: i.status,
      customerPhone: i.customerPhone,
      consumerPhone: i.consumerAccount?.phoneNumber,
      rejectionReason: i.rejectionReason,
      submittedLatitude: i.submittedLatitude?.toString(),
      submittedLongitude: i.submittedLongitude?.toString(),
      createdAt: i.createdAt,
    })) };
  });

  app.post('/api/merchant/manual-review/:id/resolve', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { staffId } = request.staff!;
    const { id } = request.params as { id: string };
    const { action, reason } = request.body as { action: 'approve' | 'reject'; reason: string };

    if (!action || !reason) return reply.status(400).send({ error: 'action and reason required' });

    const { resolveManualReview } = await import('../../../services/reconciliation.js');
    const result = await resolveManualReview({
      invoiceId: id, action, reason, resolverType: 'staff', resolverId: staffId,
    });
    return result;
  });
}
