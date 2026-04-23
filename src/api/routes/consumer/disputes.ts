import type { FastifyInstance } from 'fastify';
import { createDispute } from '../../../services/disputes.js';
import { requireConsumerAuth } from '../../middleware/auth.js';

export async function registerDisputesRoutes(app: FastifyInstance): Promise<void> {
  // ---- SUBMIT DISPUTE ----
  app.post('/api/consumer/disputes', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;
    const { description, screenshotUrl } = request.body as { description: string; screenshotUrl?: string };

    if (!description || description.trim().length === 0) {
      return reply.status(400).send({ error: 'description is required' });
    }

    const dispute = await createDispute({
      tenantId,
      consumerAccountId: accountId,
      description: description.trim(),
      screenshotUrl: screenshotUrl || undefined,
    });

    return { success: true, dispute: { id: dispute.id, status: dispute.status, createdAt: dispute.createdAt } };
  });
}
