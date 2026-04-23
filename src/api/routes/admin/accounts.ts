import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireAdminAuth } from './_middleware.js';

export async function registerAccountsRoutes(app: FastifyInstance): Promise<void> {
  // ---- ADMIN: SEARCH ACCOUNTS BY PHONE ----
  // Returns accounts whose phone tail matches — admin-scoped, cross-tenant,
  // so the operator can find a subject quickly before force-logging them
  // out. Last-10-digit match handles legacy format variants.
  app.get('/api/admin/accounts/search', { preHandler: [requireAdminAuth] }, async (request) => {
    const { phone } = request.query as { phone?: string };
    if (!phone || phone.trim().length < 4) return { accounts: [] };
    const tail = phone.replace(/\D/g, '').slice(-10);
    if (tail.length < 4) return { accounts: [] };

    const rows = await prisma.account.findMany({
      where: {
        phoneNumber: { endsWith: tail },
        accountType: { in: ['shadow', 'verified'] },
      },
      include: { tenant: { select: { name: true, slug: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      accounts: rows.map(a => ({
        id: a.id,
        phoneNumber: a.phoneNumber,
        displayName: a.displayName,
        accountType: a.accountType,
        tenantId: a.tenantId,
        tenantName: a.tenant.name,
        tenantSlug: a.tenant.slug,
        tokensInvalidatedAt: a.tokensInvalidatedAt,
        createdAt: a.createdAt,
      })),
    };
  });

  // ---- ADMIN: SEARCH STAFF BY EMAIL ----
  app.get('/api/admin/staff/search', { preHandler: [requireAdminAuth] }, async (request) => {
    const { email } = request.query as { email?: string };
    if (!email || email.trim().length < 3) return { staff: [] };
    const rows = await prisma.staff.findMany({
      where: { email: { contains: email.trim(), mode: 'insensitive' } },
      include: { tenant: { select: { name: true, slug: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      staff: rows.map(s => ({
        id: s.id,
        email: s.email,
        name: s.name,
        role: s.role,
        active: s.active,
        tenantId: s.tenantId,
        tenantName: s.tenant.name,
        tenantSlug: s.tenant.slug,
        tokensInvalidatedAt: s.tokensInvalidatedAt,
      })),
    };
  });

  // ---- ADMIN: UNLINK CEDULA (downgrade verified → shadow) ----
  app.post('/api/admin/unlink-cedula', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { accountId, tenantId, reason } = request.body as any;

    if (!accountId || !tenantId || !reason) {
      return reply.status(400).send({ error: 'accountId, tenantId, and reason are required' });
    }

    const account = await prisma.account.findFirst({ where: { id: accountId, tenantId } });
    if (!account) return reply.status(404).send({ error: 'Account not found' });
    if (account.accountType !== 'verified') {
      return reply.status(400).send({ error: 'Account is not verified — nothing to unlink' });
    }

    await prisma.account.update({
      where: { id: accountId },
      data: { accountType: 'shadow', cedula: null },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type,
        consumer_account_id, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${(request as any).admin.adminId}::uuid,
        'admin', 'admin', 'IDENTITY_UPGRADE',
        ${accountId}::uuid, 'success',
        ${JSON.stringify({ action: 'unlink_cedula', previousCedula: account.cedula, reason })}::jsonb, now())
    `;

    return { success: true, account: { id: accountId, accountType: 'shadow', cedula: null } };
  });

  // ---- ADMIN: FORCE-LOGOUT A CONSUMER ACCOUNT ----
  // Bumps accounts.tokens_invalidated_at to now(), which the auth middleware
  // reads on every authenticated request — any token issued before this call
  // is rejected at the next hop, regardless of TTL or where it's stored
  // (localStorage, httpOnly cookie, or copied off the wire).
  app.post('/api/admin/accounts/:id/force-logout', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason?: string };

    if (!reason || reason.trim().length < 5) {
      return reply.status(400).send({ error: 'A reason (min 5 chars) is required' });
    }

    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) return reply.status(404).send({ error: 'Account not found' });

    await prisma.account.update({
      where: { id },
      data: { tokensInvalidatedAt: new Date() },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type,
        consumer_account_id, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${account.tenantId}::uuid, ${(request as any).admin.adminId}::uuid,
        'admin', 'admin', 'SESSION_TERMINATED',
        ${id}::uuid, 'success',
        ${JSON.stringify({ reason: reason.trim(), subject: 'account' })}::jsonb, now())
    `;

    return { success: true, subject: 'account', id, invalidatedAt: new Date() };
  });

  // ---- ADMIN: FORCE-LOGOUT A STAFF MEMBER ----
  // Same mechanism as the consumer variant, targeting a specific owner or
  // cashier row. Useful when a merchant reports a staff credential leak or
  // when we need to kick a cashier off a shared device.
  app.post('/api/admin/staff/:id/force-logout', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason?: string };

    if (!reason || reason.trim().length < 5) {
      return reply.status(400).send({ error: 'A reason (min 5 chars) is required' });
    }

    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff) return reply.status(404).send({ error: 'Staff member not found' });

    await prisma.staff.update({
      where: { id },
      data: { tokensInvalidatedAt: new Date() },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type,
        outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${staff.tenantId}::uuid, ${(request as any).admin.adminId}::uuid,
        'admin', 'admin', 'SESSION_TERMINATED',
        'success',
        ${JSON.stringify({ reason: reason.trim(), subject: 'staff', staffId: id, staffEmail: staff.email })}::jsonb, now())
    `;

    return { success: true, subject: 'staff', id, invalidatedAt: new Date() };
  });
}
