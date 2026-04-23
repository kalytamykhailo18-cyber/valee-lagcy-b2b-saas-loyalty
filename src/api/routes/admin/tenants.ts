import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import prisma from '../../../db/client.js';
import { createSystemAccounts } from '../../../services/accounts.js';
import { sendTenantCredentials } from '../../../services/email.js';
import { generateMerchantQR } from '../../../services/merchant-qr.js';
import { requireAdminAuth } from './_middleware.js';

export async function registerTenantsRoutes(app: FastifyInstance): Promise<void> {
  // ---- TENANT MANAGEMENT ----
  app.get('/api/admin/tenants', { preHandler: [requireAdminAuth] }, async () => {
    const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } });
    return { tenants };
  });

  // Tenants with missing RIF — for the admin backfill audit (Genesis M1).
  // Fiscal invoices to these tenants get auto-rejected until the owner
  // fills it in, so admin needs to see the list and prod owners to finish.
  app.get('/api/admin/tenants-missing-rif', { preHandler: [requireAdminAuth] }, async () => {
    const tenants = await prisma.tenant.findMany({
      where: { OR: [{ rif: null }, { rif: '' }], status: 'active' },
      select: {
        id: true, name: true, slug: true, ownerEmail: true,
        createdAt: true, contactPhone: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return { tenants, count: tenants.length };
  });

  app.post('/api/admin/tenants', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { name, slug, ownerEmail, ownerName, ownerPassword, assetTypeId, conversionRate } = request.body as any;
    if (!name || !slug || !ownerEmail || !ownerName || !ownerPassword) {
      return reply.status(400).send({ error: 'name, slug, ownerEmail, ownerName, ownerPassword required' });
    }

    // Create tenant
    const tenant = await prisma.tenant.create({ data: { name, slug, ownerEmail } });

    // Create system accounts
    await createSystemAccounts(tenant.id);

    // Create owner staff account
    const passwordHash = await bcrypt.hash(ownerPassword, 10);
    await prisma.staff.create({
      data: { tenantId: tenant.id, name: ownerName, email: ownerEmail, passwordHash, role: 'owner' },
    });

    // Set conversion rate if provided
    if (assetTypeId && conversionRate) {
      await prisma.tenantAssetConfig.create({
        data: { tenantId: tenant.id, assetTypeId, conversionRate },
      });
    }

    // Generate static merchant QR code
    await generateMerchantQR(tenant.id);

    // Send credentials to owner via email
    await sendTenantCredentials(ownerEmail, ownerName, name, ownerPassword, slug);

    // Audit
    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenant.id}::uuid, ${(request as any).admin.adminId}::uuid,
        'admin', 'admin', 'TENANT_CREATED', 'success',
        ${JSON.stringify({ tenantName: name, slug })}::jsonb, now())
    `;

    return { success: true, tenant };
  });

  // ---- GENERATE/REGENERATE MERCHANT QR ----
  app.post('/api/admin/tenants/:id/generate-qr', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });

    const result = await generateMerchantQR(id);
    return { success: true, deepLink: result.deepLink, qrCodeUrl: result.qrCodeUrl };
  });

  app.patch('/api/admin/tenants/:id/deactivate', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body as { reason?: string }) || {};
    if (!reason || reason.trim().length < 5) {
      return reply.status(400).send({ error: 'A reason (min 5 chars) is required' });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });

    // Atomic so a partial suspension (staff locked out but tenant status
    // still 'active') is never observable.
    const [updated, staffBump] = await prisma.$transaction([
      prisma.tenant.update({ where: { id }, data: { status: 'inactive' } }),
      // Kill every existing staff session in this tenant. Consumer sessions
      // are left alone on purpose — they'll hit the tenant.status='active'
      // gate on every tenant-scoped endpoint, so the suspension is
      // effective without mass-logging-out thousands of end users.
      prisma.staff.updateMany({
        where: { tenantId: id },
        data: { tokensInvalidatedAt: new Date() },
      }),
    ]);

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${id}::uuid, ${(request as any).admin.adminId}::uuid,
        'admin', 'admin', 'TENANT_DEACTIVATED', 'success',
        ${JSON.stringify({ tenantName: tenant.name, reason: reason.trim(), staffSessionsKilled: staffBump.count })}::jsonb, now())
    `;

    return {
      success: true,
      tenant: updated,
      staffSessionsKilled: staffBump.count,
    };
  });

  // ---- ADMIN: Reactivate tenant ----
  // Tenants currently can't be reactivated via the API — only deactivated.
  // This endpoint flips status back to 'active' with a mandatory reason so
  // a mistake or lifted suspension doesn't require a DB session.
  app.patch('/api/admin/tenants/:id/reactivate', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body as { reason?: string }) || {};
    if (!reason || reason.trim().length < 5) {
      return reply.status(400).send({ error: 'A reason (min 5 chars) is required' });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });

    const [updated] = await prisma.$transaction([
      prisma.tenant.update({ where: { id }, data: { status: 'active' } }),
      // Clear the force-logout marker so staff can log back in and get a
      // working token. Without this, fresh tokens issued right after
      // reactivation have iat <= tokens_invalidated_at and silently 401.
      prisma.staff.updateMany({
        where: { tenantId: id },
        data: { tokensInvalidatedAt: null },
      }),
    ]);

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${id}::uuid, ${(request as any).admin.adminId}::uuid,
        'admin', 'admin', 'TENANT_CREATED', 'success',
        ${JSON.stringify({ tenantName: tenant.name, reason: reason.trim(), event: 'reactivated' })}::jsonb, now())
    `;

    return { success: true, tenant: updated };
  });

  // ---- REVENUE MODEL (Admin only) ----
  // Configure platform fees per tenant
  app.patch('/api/admin/tenants/:id/revenue-config', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { redemptionFeePercent, attributedSaleFeePercent, attributedCustomerFixedFee } = request.body as {
      redemptionFeePercent?: number | null;
      attributedSaleFeePercent?: number | null;
      attributedCustomerFixedFee?: number | null;
    };

    const data: any = {};
    if (redemptionFeePercent !== undefined) {
      data.redemptionFeePercent = redemptionFeePercent === null ? null : Number(redemptionFeePercent);
    }
    if (attributedSaleFeePercent !== undefined) {
      data.attributedSaleFeePercent = attributedSaleFeePercent === null ? null : Number(attributedSaleFeePercent);
    }
    if (attributedCustomerFixedFee !== undefined) {
      data.attributedCustomerFixedFee = attributedCustomerFixedFee === null ? null : Number(attributedCustomerFixedFee);
    }

    const updated = await prisma.tenant.update({ where: { id }, data });
    return {
      id: updated.id,
      redemptionFeePercent: updated.redemptionFeePercent,
      attributedSaleFeePercent: updated.attributedSaleFeePercent,
      attributedCustomerFixedFee: updated.attributedCustomerFixedFee,
    };
  });

  // Aggregate platform revenue across all tenants (or filtered by tenant)
  app.get('/api/admin/platform-revenue', { preHandler: [requireAdminAuth] }, async (request) => {
    const { tenantId, from, to } = request.query as { tenantId?: string; from?: string; to?: string };
    const { getPlatformRevenue } = await import('../../../services/platform-revenue.js');
    return getPlatformRevenue({
      tenantId,
      fromDate: from ? new Date(from) : undefined,
      toDate: to ? new Date(to) : undefined,
    });
  });

  // ---- PLAN MANAGEMENT (Admin only) ----
  app.patch('/api/admin/tenants/:id/plan', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { plan } = request.body as { plan: 'basic' | 'pro' | 'x10' };
    if (!['basic', 'pro', 'x10'].includes(plan)) {
      return reply.status(400).send({ error: 'plan must be basic, pro, or x10' });
    }
    const updated = await prisma.tenant.update({
      where: { id },
      data: { plan },
    });
    return { id: updated.id, plan: updated.plan };
  });
}
