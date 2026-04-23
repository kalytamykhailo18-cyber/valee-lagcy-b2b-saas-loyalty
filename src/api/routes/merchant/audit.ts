import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  // ---- AUDIT TRAIL (Owner only) ----
  app.get('/api/merchant/audit-log', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { limit = '50', offset = '0', actionType } = request.query as any;

    // actionType reserved for later filtering — explicit no-op for now so
    // the param doesn't silently do nothing if someone adds the where clause.
    void actionType;

    const entries = await prisma.$queryRaw<any[]>`
      SELECT al.*, s.name as actor_name
      FROM audit_log al
      LEFT JOIN staff s ON s.id = al.actor_id AND al.actor_type = 'staff'
      WHERE al.tenant_id = ${tenantId}::uuid
      ORDER BY al.created_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `;

    return { entries };
  });
}
