import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { createBranch, listBranches, toggleBranch } from '../../../services/branches.js';
import { generateBranchQR } from '../../../services/merchant-qr.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

export async function registerBranchesRoutes(app: FastifyInstance): Promise<void> {
  // ---- BRANCH MANAGEMENT (Owner only) ----
  app.get('/api/merchant/branches', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const branches = await listBranches(tenantId);
    return { branches };
  });

  app.post('/api/merchant/branches', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { name, address, latitude, longitude } = request.body as {
      name: string; address?: string; latitude?: number; longitude?: number;
    };

    if (!name) return reply.status(400).send({ error: 'name is required' });

    const branch = await createBranch({
      tenantId,
      name,
      address: address || undefined,
      latitude: latitude != null ? latitude : undefined,
      longitude: longitude != null ? longitude : undefined,
    });

    // Audit log — wrap in try/catch so a logging error never breaks the response
    try {
      await prisma.$executeRaw`
        INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'owner', 'BRANCH_CREATED', 'success',
          ${JSON.stringify({ branchId: branch.id, name })}::jsonb, now())
      `;
    } catch (err) {
      console.error('[Audit] BRANCH_CREATED log failed:', err);
    }

    return { branch };
  });

  app.patch('/api/merchant/branches/:id/toggle', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { id } = request.params as { id: string };

    try {
      const branch = await toggleBranch(id, tenantId);

      await prisma.$executeRaw`
        INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'owner', 'BRANCH_TOGGLED', 'success',
          ${JSON.stringify({ branchId: id, active: branch.active })}::jsonb, now())
      `;

      return { branch };
    } catch (e: any) {
      return reply.status(404).send({ error: e.message || 'Branch not found' });
    }
  });

  app.patch('/api/merchant/branches/:id', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };
    const { name, address, latitude, longitude } = request.body as {
      name?: string; address?: string | null; latitude?: number | null; longitude?: number | null;
    };

    const branch = await prisma.branch.findFirst({ where: { id, tenantId } });
    if (!branch) return reply.status(404).send({ error: 'Sucursal no encontrada' });

    const updates: any = {};
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (trimmed.length < 1) return reply.status(400).send({ error: 'El nombre no puede estar vacio' });
      if (trimmed.length > 255) return reply.status(400).send({ error: 'Nombre maximo 255 caracteres' });
      updates.name = trimmed;
    }
    if (address !== undefined) updates.address = address ? String(address).trim() : null;
    if (latitude !== undefined) {
      if (latitude !== null && (typeof latitude !== 'number' || latitude < -90 || latitude > 90)) {
        return reply.status(400).send({ error: 'Latitud invalida (-90 a 90)' });
      }
      updates.latitude = latitude;
    }
    if (longitude !== undefined) {
      if (longitude !== null && (typeof longitude !== 'number' || longitude < -180 || longitude > 180)) {
        return reply.status(400).send({ error: 'Longitud invalida (-180 a 180)' });
      }
      updates.longitude = longitude;
    }

    const updated = await prisma.branch.update({ where: { id }, data: updates });
    return { branch: updated };
  });

  app.delete('/api/merchant/branches/:id', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };

    const branch = await prisma.branch.findFirst({ where: { id, tenantId } });
    if (!branch) return reply.status(404).send({ error: 'Sucursal no encontrada' });

    // Block delete if branch has any ledger entries (preserves financial history)
    const entryCount = await prisma.ledgerEntry.count({ where: { branchId: id } });
    if (entryCount > 0) {
      return reply.status(409).send({
        error: `No se puede eliminar: la sucursal tiene ${entryCount} transacciones registradas. Desactivala en su lugar.`,
      });
    }
    // Block delete if cashiers are assigned
    const staffCount = await prisma.staff.count({ where: { branchId: id } });
    if (staffCount > 0) {
      return reply.status(409).send({
        error: `No se puede eliminar: ${staffCount} cajero(s) asignado(s). Reasignalos primero.`,
      });
    }

    await prisma.branch.delete({ where: { id } });
    return { success: true };
  });

  app.post('/api/merchant/branches/:id/generate-qr', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { id } = request.params as { id: string };
    const { reason } = (request.body || {}) as { reason?: string };

    const branch = await prisma.branch.findFirst({ where: { id, tenantId } });
    if (!branch) return reply.status(404).send({ error: 'Branch not found' });

    // If the branch already has a QR, this is a REGENERATION — require a
    // reason and enforce a max of 2 regenerations. This discourages casual
    // re-rolling (the printed QR becomes useless) and creates an audit trail
    // that surfaces sabotage attempts.
    const isRegen = !!branch.qrCodeUrl;
    if (isRegen) {
      if (!reason || reason.trim().length < 3) {
        return reply.status(400).send({ error: 'Debes indicar la razon del cambio de QR.' });
      }
      // Only count actual regenerations (isRegen=true), not the initial generation.
      const priorRegens = await prisma.auditLog.count({
        where: {
          tenantId,
          actionType: 'BRANCH_QR_GENERATED',
          metadata: { path: ['branchId'], equals: id },
          AND: { metadata: { path: ['isRegen'], equals: true } },
        },
      });
      if (priorRegens >= 2) {
        return reply.status(403).send({
          error: 'Este QR ya fue regenerado 2 veces. Para otro cambio, comunicate con el equipo de Valee.',
          regenCount: priorRegens,
        });
      }
    }

    try {
      const result = await generateBranchQR(id);

      await prisma.$executeRaw`
        INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'owner', 'BRANCH_QR_GENERATED', 'success',
          ${JSON.stringify({ branchId: id, branchName: branch.name, isRegen, reason: reason?.trim() || null })}::jsonb, now())
      `;

      return { success: true, deepLink: result.deepLink, qrCodeUrl: result.qrCodeUrl };
    } catch (e: any) {
      return reply.status(500).send({ error: e.message || 'Failed to generate QR' });
    }
  });
}
