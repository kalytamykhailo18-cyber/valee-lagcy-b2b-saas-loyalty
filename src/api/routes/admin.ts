import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import prisma from '../../db/client.js';
import { authenticateAdmin, issueAdminTokens } from '../../services/auth.js';
import { writeDoubleEntry, verifyHashChain, getAccountBalance } from '../../services/ledger.js';
import { createSystemAccounts } from '../../services/accounts.js';
import { sendTenantCredentials } from '../../services/email.js';
import { generateMerchantQR } from '../../services/merchant-qr.js';

// Admin auth middleware
async function requireAdminAuth(request: any, reply: any) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Authentication required' });
  }
  try {
    const jwt = await import('jsonwebtoken');
    const payload = jwt.default.verify(authHeader.slice(7), process.env.JWT_SECRET!) as any;
    if (payload.type !== 'admin') return reply.status(403).send({ error: 'Admin access required' });
    request.admin = payload;
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export default async function adminRoutes(app: FastifyInstance) {

  // ---- AUTH: Admin login ----
  app.post('/api/admin/auth/login', async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };
    if (!email || !password) return reply.status(400).send({ error: 'email and password required' });

    const admin = await authenticateAdmin(email, password);
    if (!admin) return reply.status(401).send({ error: 'Invalid credentials' });

    const tokens = issueAdminTokens({ adminId: admin.id, type: 'admin' });
    return { success: true, ...tokens, admin: { id: admin.id, name: admin.name } };
  });

  // ---- TENANT MANAGEMENT ----
  app.get('/api/admin/tenants', { preHandler: [requireAdminAuth] }, async () => {
    const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } });
    return { tenants };
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
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' });

    const updated = await prisma.tenant.update({ where: { id }, data: { status: 'inactive' } });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${id}::uuid, ${(request as any).admin.adminId}::uuid,
        'admin', 'admin', 'TENANT_DEACTIVATED', 'success',
        ${JSON.stringify({ tenantName: tenant.name })}::jsonb, now())
    `;

    return { success: true, tenant: updated };
  });

  // ---- GLOBAL LEDGER AUDIT ----
  app.get('/api/admin/ledger', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { tenantId, eventType, status, dateFrom, dateTo, limit = '50', offset = '0' } = request.query as any;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (tenantId && !UUID_RE.test(String(tenantId))) {
      return reply.status(400).send({ error: 'tenantId debe ser un UUID valido' });
    }

    const where: any = {};
    if (tenantId) where.tenantId = tenantId;
    if (eventType) where.eventType = eventType;
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    const entries = await prisma.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
      include: { tenant: { select: { name: true } }, account: { select: { phoneNumber: true } } },
    });

    const total = await prisma.ledgerEntry.count({ where });

    return { entries, total };
  });

  // ---- HASH CHAIN INTEGRITY CHECK ----
  app.post('/api/admin/verify-hash-chain', { preHandler: [requireAdminAuth] }, async (request) => {
    const { tenantId } = request.body as { tenantId?: string };

    if (tenantId) {
      const result = await verifyHashChain(tenantId);
      return { tenantId, ...result };
    }

    // Check all tenants
    const tenants = await prisma.tenant.findMany();
    const results: Array<{ tenantId: string; tenantName: string; valid: boolean; brokenAt?: string }> = [];

    for (const tenant of tenants) {
      const result = await verifyHashChain(tenant.id);
      results.push({ tenantId: tenant.id, tenantName: tenant.name, ...result });
    }

    return { results, allValid: results.every(r => r.valid) };
  });

  // ---- MANUAL ADJUSTMENT ----
  app.post('/api/admin/manual-adjustment', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { accountId, tenantId, amount, direction, reason, assetTypeId } = request.body as any;

    if (!accountId || !tenantId || !amount || !direction || !reason || !assetTypeId) {
      return reply.status(400).send({ error: 'accountId, tenantId, amount, direction, reason, and assetTypeId are all required' });
    }

    if (!reason || reason.trim().length < 5) {
      return reply.status(400).send({ error: 'A mandatory reason (min 5 characters) must be provided' });
    }

    const account = await prisma.account.findFirst({ where: { id: accountId, tenantId } });
    if (!account) return reply.status(404).send({ error: 'Account not found' });

    // Get or create a system adjustment account
    const poolAccount = await prisma.account.findFirst({
      where: { tenantId, systemAccountType: 'issued_value_pool' },
    });
    if (!poolAccount) return reply.status(500).send({ error: 'System pool account not found' });

    const adminId = (request as any).admin.adminId;

    const debitAccountId = direction === 'credit' ? poolAccount.id : accountId;
    const creditAccountId = direction === 'credit' ? accountId : poolAccount.id;

    const ledgerResult = await writeDoubleEntry({
      tenantId,
      eventType: 'ADJUSTMENT_MANUAL',
      debitAccountId,
      creditAccountId,
      amount,
      assetTypeId,
      referenceId: `ADJ-${Date.now()}-${adminId.slice(0, 8)}`,
      referenceType: 'manual_adjustment',
      metadata: { adminId, reason, direction },
    });

    // Audit
    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type,
        consumer_account_id, amount, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${adminId}::uuid,
        'admin', 'admin', 'MANUAL_ADJUSTMENT',
        ${accountId}::uuid, ${parseFloat(amount)}, 'success',
        ${JSON.stringify({ reason, direction, ledgerEntryId: ledgerResult.credit.id })}::jsonb, now())
    `;

    const newBalance = await getAccountBalance(accountId, assetTypeId, tenantId);

    return { success: true, newBalance, ledgerEntryId: ledgerResult.credit.id };
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

  // ---- PLATFORM METRICS ----
  app.get('/api/admin/metrics', { preHandler: [requireAdminAuth] }, async () => {
    const activeTenants = await prisma.tenant.count({ where: { status: 'active' } });

    const [shadowCount] = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) FROM accounts WHERE account_type = 'shadow'
    `;
    const [verifiedCount] = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) FROM accounts WHERE account_type = 'verified'
    `;

    const [totalCirculation] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(
        SUM(CASE WHEN entry_type = 'CREDIT' AND status != 'reversed' THEN amount ELSE 0 END) -
        SUM(CASE WHEN entry_type = 'DEBIT' AND status != 'reversed' THEN amount ELSE 0 END),
        0
      )::text AS total
      FROM ledger_entries
      WHERE account_id IN (SELECT id FROM accounts WHERE account_type IN ('shadow', 'verified'))
    `;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const validationsLast30 = await prisma.ledgerEntry.count({
      where: {
        eventType: 'INVOICE_CLAIMED',
        entryType: 'CREDIT',
        createdAt: { gte: thirtyDaysAgo },
      },
    });

    return {
      activeTenants,
      shadowAccounts: Number(shadowCount.count),
      verifiedAccounts: Number(verifiedCount.count),
      totalConsumers: Number(shadowCount.count) + Number(verifiedCount.count),
      totalValueInCirculation: totalCirculation.total,
      validationsLast30Days: validationsLast30,
    };
  });

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

    const { resolveManualReview } = await import('../services/reconciliation.js');
    const result = await resolveManualReview({
      invoiceId: id, action, reason,
      resolverType: 'admin', resolverId: (request as any).admin.adminId,
    });
    return result;
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
    const { getPlatformRevenue } = await import('../../services/platform-revenue.js');
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

  // ---- WHATSAPP TEMPLATES ----
  // List all logical templates the system uses, with example messages.
  // Genesis uses this list to know exactly which templates to register in Meta Manager.
  app.get('/api/admin/whatsapp-templates', { preHandler: [requireAdminAuth] }, async () => {
    const { listTemplates } = await import('../../services/whatsapp-templates.js');
    return { templates: listTemplates() };
  });

  // Send a test template message to verify Meta has approved it
  app.post('/api/admin/whatsapp-templates/test', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { templateName, phoneNumber, payload } = request.body as { templateName: string; phoneNumber: string; payload?: any };
    if (!templateName || !phoneNumber) {
      return reply.status(400).send({ error: 'templateName and phoneNumber required' });
    }
    const { sendTemplateMessage } = await import('../../services/whatsapp-templates.js');
    const ok = await sendTemplateMessage(templateName, phoneNumber, payload || {}, 'auto');
    return { success: ok };
  });

  // ---- AUDIT LOG VIEW ----
  app.get('/api/admin/audit-log', { preHandler: [requireAdminAuth] }, async (request) => {
    const { tenantId, actionType, limit = '50', offset = '0' } = request.query as any;

    const where: any = {};
    if (tenantId) where.tenantId = tenantId;
    if (actionType) where.actionType = actionType;

    const entries = await prisma.$queryRaw<any[]>`
      SELECT al.*, t.name as tenant_name
      FROM audit_log al
      LEFT JOIN tenants t ON t.id = al.tenant_id
      ${tenantId ? prisma.$queryRaw`WHERE al.tenant_id = ${tenantId}::uuid` : prisma.$queryRaw`WHERE 1=1`}
      ORDER BY al.created_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `;

    return { entries };
  });
}
