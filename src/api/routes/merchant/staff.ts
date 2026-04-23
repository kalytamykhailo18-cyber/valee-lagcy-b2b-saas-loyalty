import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import prisma from '../../../db/client.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

export async function registerStaffRoutes(app: FastifyInstance): Promise<void> {
  // ---- STAFF MANAGEMENT (Owner only) ----
  app.post('/api/merchant/staff', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { name, email, password, role, branchId } = request.body as any;

    if (!name || !email || !password || !role) {
      return reply.status(400).send({ error: 'name, email, password, and role are required' });
    }

    // Cashiers must be assigned to a branch at creation time when the
    // tenant has any branches configured. Owners are cross-branch by nature,
    // so the rule only kicks in for role=cashier. If the tenant has zero
    // branches yet, we allow a null assignment so early-stage merchants
    // aren't blocked before Step 5.1 setup.
    if (branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: branchId, tenantId },
        select: { id: true },
      });
      if (!branch) return reply.status(400).send({ error: 'branchId does not belong to this tenant' });
    } else if (role === 'cashier') {
      const branchCount = await prisma.branch.count({ where: { tenantId, active: true } });
      if (branchCount > 0) {
        return reply.status(400).send({ error: 'Debes asignar una sucursal al cajero.' });
      }
    }

    // Plan limit check
    const { enforceLimit } = await import('../../../services/plan-limits.js');
    try { await enforceLimit(tenantId, 'staff_members'); }
    catch (e: any) { return reply.status(402).send({ error: e.message, usage: e.usage }); }

    const passwordHash = await bcrypt.hash(password, 10);
    const staff = await prisma.staff.create({
      data: { tenantId, name, email, passwordHash, role, branchId: branchId || null },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${request.staff!.staffId}::uuid, 'staff', 'owner', 'STAFF_CREATED', 'success',
        ${JSON.stringify({ staffId: staff.id, name, role, branchId: branchId || null })}::jsonb, now())
    `;

    return { staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role, branchId: staff.branchId } };
  });

  // ---- CHANGE CASHIER BRANCH (Owner only, one edit only) ----
  // Eric's rule: the cashier's branch assignment can be changed exactly once
  // by the merchant owner. A second attempt returns 403 with a message
  // instructing the owner to contact Valee support. Prior edits are counted
  // via audit_log (action_type = STAFF_BRANCH_CHANGED).
  app.patch('/api/merchant/staff/:id/branch', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId: actorId } = request.staff!;
    const { id } = request.params as { id: string };
    const { branchId } = (request.body || {}) as { branchId?: string };

    if (!branchId) return reply.status(400).send({ error: 'branchId is required' });

    const target = await prisma.staff.findFirst({ where: { id, tenantId } });
    if (!target) return reply.status(404).send({ error: 'Staff member not found' });

    const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId } });
    if (!branch) return reply.status(400).send({ error: 'branchId does not belong to this tenant' });

    if (target.branchId === branchId) {
      return reply.status(400).send({ error: 'El cajero ya esta asignado a esa sucursal.' });
    }

    // Raw SQL instead of prisma.auditLog.count with a metadata JSON filter:
    // Prisma types the nullable-JSON path/equals filter loosely, which some
    // IDE type-checkers flag as a mismatch even though tsc passes. The sibling
    // GET /staff endpoint already reads this column with raw SQL — keep both
    // lookups on the same primitive for consistency.
    const [{ n: priorChangesBig }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n
      FROM audit_log
      WHERE tenant_id = ${tenantId}::uuid
        AND action_type = 'STAFF_BRANCH_CHANGED'
        AND (metadata->>'staffId') = ${id}
    `;
    const priorChanges = Number(priorChangesBig);
    if (priorChanges >= 1) {
      return reply.status(403).send({
        error: 'La sucursal del cajero ya fue cambiada una vez. Para otro cambio, comunicate con soporte@valee.app.',
        changeCount: priorChanges,
      });
    }

    const fromBranchId = target.branchId;
    const updated = await prisma.staff.update({
      where: { id },
      data: { branchId },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${actorId}::uuid, 'staff', 'owner', 'STAFF_BRANCH_CHANGED', 'success',
        ${JSON.stringify({ staffId: id, name: target.name, fromBranchId, toBranchId: branchId })}::jsonb, now())
    `;

    return { staff: { id: updated.id, name: updated.name, branchId: updated.branchId } };
  });

  // ---- LIST STAFF (Owner only) ----
  app.get('/api/merchant/staff', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const staffList = await prisma.staff.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, email: true, role: true, active: true, branchId: true, createdAt: true,
        qrSlug: true, qrCodeUrl: true, qrGeneratedAt: true,
      },
    });

    // For each cashier, report whether a branch change has already been
    // spent. The frontend uses this to hide the "Cambiar sucursal" button
    // after the one allowed edit, matching Eric's rule.
    const changeRows = await prisma.$queryRaw<Array<{ staff_id: string; n: bigint }>>`
      SELECT (metadata->>'staffId') AS staff_id, COUNT(*)::bigint AS n
      FROM audit_log
      WHERE tenant_id = ${tenantId}::uuid
        AND action_type = 'STAFF_BRANCH_CHANGED'
      GROUP BY metadata->>'staffId'
    `;
    const changeCountBy = Object.fromEntries(changeRows.map(r => [r.staff_id, Number(r.n)]));

    return {
      staff: staffList.map(s => ({
        ...s,
        branchChangeCount: changeCountBy[s.id] || 0,
        branchLocked: (changeCountBy[s.id] || 0) >= 1,
      })),
    };
  });

  // ---- GENERATE STAFF QR (Owner only) ----
  app.post('/api/merchant/staff/:id/qr', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId: actorId } = request.staff!;
    const { id } = request.params as { id: string };

    const target = await prisma.staff.findFirst({ where: { id, tenantId } });
    if (!target) return reply.status(404).send({ error: 'Staff member not found' });

    const { generateStaffQR } = await import('../../../services/merchant-qr.js');
    const result = await generateStaffQR(id);

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${actorId}::uuid, 'staff', 'owner', 'STAFF_QR_GENERATED', 'success',
        ${JSON.stringify({ staffId: id, staffName: target.name, qrSlug: result.qrSlug })}::jsonb, now())
    `;

    return result;
  });

  // ---- STAFF PERFORMANCE (Owner only) ----
  // Aggregates INVOICE_CLAIMED and PRESENCE_VALIDATED credits whose ledger
  // metadata carries the staffId, grouped per staff. Returns counters for
  // the last 30 days by default.
  app.get('/api/merchant/staff-performance', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { days = '30' } = request.query as { days?: string };
    const since = new Date(Date.now() - Math.max(1, parseInt(days)) * 24 * 60 * 60 * 1000);

    const rows = await prisma.$queryRaw<Array<{
      staff_id: string;
      staff_name: string;
      staff_role: string;
      transactions: bigint;
      unique_consumers: bigint;
      value_issued: string;
    }>>`
      SELECT
        s.id::text AS staff_id,
        s.name AS staff_name,
        s.role::text AS staff_role,
        COUNT(*)::bigint AS transactions,
        COUNT(DISTINCT le.account_id)::bigint AS unique_consumers,
        COALESCE(SUM(le.amount), 0)::text AS value_issued
      FROM ledger_entries le
      JOIN staff s ON s.id = (le.metadata->>'staffId')::uuid
      WHERE le.tenant_id = ${tenantId}::uuid
        AND le.entry_type = 'CREDIT'
        AND le.event_type IN ('INVOICE_CLAIMED', 'PRESENCE_VALIDATED')
        AND le.created_at >= ${since}::timestamptz
        AND le.metadata->>'staffId' IS NOT NULL
      GROUP BY s.id, s.name, s.role
      ORDER BY transactions DESC
    `;

    return {
      sinceDays: parseInt(days),
      staff: rows.map(r => ({
        staffId: r.staff_id,
        staffName: r.staff_name,
        staffRole: r.staff_role,
        transactions: Number(r.transactions),
        uniqueConsumers: Number(r.unique_consumers),
        valueIssued: r.value_issued,
      })),
    };
  });

  // ---- DEACTIVATE STAFF (Owner only) ----
  app.patch('/api/merchant/staff/:id/deactivate', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId: actorId } = request.staff!;
    const { id } = request.params as { id: string };

    const target = await prisma.staff.findFirst({ where: { id, tenantId } });
    if (!target) return reply.status(404).send({ error: 'Staff member not found' });
    if (target.id === actorId) return reply.status(400).send({ error: 'Cannot deactivate yourself' });

    const updated = await prisma.staff.update({
      where: { id },
      data: { active: false },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${actorId}::uuid, 'staff', 'owner', 'STAFF_DEACTIVATED', 'success',
        ${JSON.stringify({ staffId: id, name: target.name })}::jsonb, now())
    `;

    return { staff: { id: updated.id, name: updated.name, active: updated.active } };
  });
}
