import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import prisma from '../../db/client.js';
import { authenticateStaff, issueStaffTokens } from '../../services/auth.js';
import { processCSV } from '../../services/csv-upload.js';
import { enqueueCsvJob } from '../../services/workers.js';
import { processRedemption } from '../../services/redemption.js';
import { upgradeToVerified } from '../../services/accounts.js';
import { getAccountBalance, getAccountHistory } from '../../services/ledger.js';
import { requireStaffAuth, requireOwnerRole } from '../middleware/auth.js';
import { verifyAndResolveLedgerEntry } from '../../services/qr-token.js';

export default async function merchantRoutes(app: FastifyInstance) {

  // ---- AUTH: Staff login ----
  app.post('/api/merchant/auth/login', async (request, reply) => {
    const { email, password, tenantSlug } = request.body as { email: string; password: string; tenantSlug: string };

    if (!email || !password || !tenantSlug) {
      return reply.status(400).send({ error: 'email, password, and tenantSlug are required' });
    }

    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) return reply.status(404).send({ error: 'Merchant not found' });

    const staff = await authenticateStaff(email, password, tenant.id);
    if (!staff) return reply.status(401).send({ error: 'Invalid credentials' });

    const tokens = issueStaffTokens({
      staffId: staff.id,
      tenantId: tenant.id,
      role: staff.role as 'owner' | 'cashier',
      type: 'staff',
    });

    return { success: true, ...tokens, staff: { id: staff.id, name: staff.name, role: staff.role } };
  });

  // ---- CSV UPLOAD (Owner only) ----
  app.post('/api/merchant/csv-upload', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { csvContent, async: useAsync } = request.body as { csvContent: string; async?: boolean };

    if (!csvContent) return reply.status(400).send({ error: 'csvContent is required' });

    // If async=true and Redis is configured, queue the job
    if (useAsync && process.env.REDIS_URL) {
      const jobId = await enqueueCsvJob(csvContent, tenantId, staffId);
      return { success: true, jobId, status: 'queued', message: 'CSV processing queued' };
    }

    // Otherwise process synchronously
    const result = await processCSV(csvContent, tenantId, staffId);

    // Audit log
    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'owner', 'CSV_UPLOAD', 'success',
        ${JSON.stringify({ batchId: result.batchId, rowsLoaded: result.rowsLoaded, rowsSkipped: result.rowsSkipped, rowsErrored: result.rowsErrored })}::jsonb, now())
    `;

    return result;
  });

  // ---- CSV UPLOAD STATUS (Owner only) ----
  app.get('/api/merchant/csv-upload/:batchId', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { batchId } = request.params as { batchId: string };

    const batch = await prisma.uploadBatch.findFirst({ where: { id: batchId, tenantId } });
    if (!batch) return reply.status(404).send({ error: 'Batch not found' });

    return {
      batchId: batch.id,
      status: batch.status,
      rowsLoaded: batch.rowsLoaded,
      rowsSkipped: batch.rowsSkipped,
      rowsErrored: batch.rowsErrored,
      errorDetails: batch.errorDetails,
      createdAt: batch.createdAt,
      completedAt: batch.completedAt,
    };
  });

  // ---- CATALOG MANAGEMENT (Owner only) ----
  app.get('/api/merchant/products', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const products = await prisma.product.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return { products };
  });

  app.post('/api/merchant/products', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { name, description, photoUrl, redemptionCost, assetTypeId, stock, minLevel } = request.body as any;

    if (!name || !redemptionCost || !assetTypeId) {
      return reply.status(400).send({ error: 'name, redemptionCost, and assetTypeId are required' });
    }

    const product = await prisma.product.create({
      data: { tenantId, name, description, photoUrl, redemptionCost, assetTypeId, stock: stock || 0, minLevel: minLevel || 1, active: true },
    });

    // Audit
    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${request.staff!.staffId}::uuid, 'staff', 'owner', 'PRODUCT_CREATED', 'success',
        ${JSON.stringify({ productId: product.id, name })}::jsonb, now())
    `;

    return { product };
  });

  app.put('/api/merchant/products/:id', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };
    const data = request.body as any;

    const product = await prisma.product.findFirst({ where: { id, tenantId } });
    if (!product) return reply.status(404).send({ error: 'Product not found' });

    const updated = await prisma.product.update({
      where: { id },
      data: {
        name: data.name ?? product.name,
        description: data.description ?? product.description,
        photoUrl: data.photoUrl ?? product.photoUrl,
        redemptionCost: data.redemptionCost ?? product.redemptionCost,
        stock: data.stock ?? product.stock,
        active: data.active ?? product.active,
      },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${request.staff!.staffId}::uuid, 'staff', 'owner', 'PRODUCT_UPDATED', 'success',
        ${JSON.stringify({ productId: id })}::jsonb, now())
    `;

    return { product: updated };
  });

  app.patch('/api/merchant/products/:id/toggle', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };

    const product = await prisma.product.findFirst({ where: { id, tenantId } });
    if (!product) return reply.status(404).send({ error: 'Product not found' });

    const updated = await prisma.product.update({
      where: { id },
      data: { active: !product.active },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${request.staff!.staffId}::uuid, 'staff', 'owner', 'PRODUCT_TOGGLED', 'success',
        ${JSON.stringify({ productId: id, active: updated.active })}::jsonb, now())
    `;

    return { product: updated };
  });

  // ---- CASHIER QR SCANNER ----
  app.post('/api/merchant/scan-redemption', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { staffId, tenantId } = request.staff!;
    const { token } = request.body as { token: string };

    if (!token) return reply.status(400).send({ error: 'token is required' });

    const result = await processRedemption({
      token,
      cashierStaffId: staffId,
      cashierTenantId: tenantId,
    });

    if (!result.success) {
      // Audit failure
      await prisma.$executeRaw`
        INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, failure_reason, created_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff',
          ${request.staff!.role}::"AuditActorRole", 'QR_SCAN_FAILURE', 'failure', ${result.message}, now())
      `;
    }

    return result;
  });

  // ---- VERIFY OUTPUT TOKEN (Merchant confirms a validation event) ----
  app.post('/api/merchant/verify-token', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { token } = request.body as { token: string };

    if (!token) return reply.status(400).send({ error: 'token is required' });

    const result = await verifyAndResolveLedgerEntry(token);

    if (!result.valid) {
      return reply.status(400).send({ valid: false, reason: result.reason });
    }

    // Ensure the token belongs to this merchant's tenant
    if (result.payload!.tenantId !== tenantId) {
      return reply.status(403).send({ valid: false, reason: 'Token belongs to a different merchant' });
    }

    return {
      valid: true,
      ledgerEntry: {
        id: result.ledgerEntry!.id,
        eventType: result.ledgerEntry!.eventType,
        amount: result.ledgerEntry!.amount.toString(),
        referenceId: result.ledgerEntry!.referenceId,
        createdAt: result.ledgerEntry!.createdAt,
        status: result.ledgerEntry!.status,
      },
      payload: result.payload,
    };
  });

  // ---- CUSTOMER LOOKUP (Cashier + Owner) ----
  app.get('/api/merchant/customer-lookup/:phoneNumber', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { phoneNumber } = request.params as { phoneNumber: string };

    const account = await prisma.account.findUnique({
      where: { tenantId_phoneNumber: { tenantId, phoneNumber } },
    });

    if (!account) return reply.status(404).send({ error: 'Customer not found' });

    const assetType = await prisma.assetType.findFirst();
    const balance = assetType ? await getAccountBalance(account.id, assetType.id, tenantId) : '0';
    const history = await getAccountHistory(account.id, tenantId, 20);

    // Audit
    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, consumer_account_id, outcome, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${request.staff!.staffId}::uuid, 'staff',
        ${request.staff!.role}::"AuditActorRole", 'CUSTOMER_LOOKUP', ${account.id}::uuid, 'success', now())
    `;

    return {
      account: {
        id: account.id,
        phoneNumber: account.phoneNumber,
        accountType: account.accountType,
        cedula: account.cedula,
        createdAt: account.createdAt,
      },
      balance,
      history: history.map(e => ({
        id: e.id,
        eventType: e.eventType,
        entryType: e.entryType,
        amount: e.amount.toString(),
        status: e.status,
        createdAt: e.createdAt,
      })),
    };
  });

  // ---- IDENTITY UPGRADE (Cashier + Owner) ----
  app.post('/api/merchant/identity-upgrade', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { phoneNumber, cedula } = request.body as { phoneNumber: string; cedula: string };

    if (!phoneNumber || !cedula) {
      return reply.status(400).send({ error: 'phoneNumber and cedula are required' });
    }

    const account = await prisma.account.findUnique({
      where: { tenantId_phoneNumber: { tenantId, phoneNumber } },
    });

    if (!account) return reply.status(404).send({ error: 'Customer not found' });
    if (account.accountType === 'verified') {
      return reply.status(400).send({ error: 'Account is already verified' });
    }

    // Check if cedula is already linked to another phone
    const existing = await prisma.account.findUnique({
      where: { tenantId_cedula: { tenantId, cedula } },
    });

    if (existing && existing.id !== account.id) {
      return reply.status(409).send({
        error: 'This cedula is already linked to another phone number',
        existingPhone: existing.phoneNumber,
        requiresConfirmation: true,
      });
    }

    const upgraded = await upgradeToVerified(account.id, tenantId, cedula);

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, consumer_account_id, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff',
        ${request.staff!.role}::"AuditActorRole", 'IDENTITY_UPGRADE', ${account.id}::uuid, 'success',
        ${JSON.stringify({ cedula })}::jsonb, now())
    `;

    return { success: true, account: { id: upgraded.id, accountType: upgraded.accountType, cedula: upgraded.cedula } };
  });

  // ---- STAFF MANAGEMENT (Owner only) ----
  app.post('/api/merchant/staff', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { name, email, password, role, branchId } = request.body as any;

    if (!name || !email || !password || !role) {
      return reply.status(400).send({ error: 'name, email, password, and role are required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const staff = await prisma.staff.create({
      data: { tenantId, name, email, passwordHash, role, branchId },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${request.staff!.staffId}::uuid, 'staff', 'owner', 'STAFF_CREATED', 'success',
        ${JSON.stringify({ staffId: staff.id, name, role })}::jsonb, now())
    `;

    return { staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role } };
  });

  // ---- CONVERSION MULTIPLIER (Owner only) ----
  app.get('/api/merchant/multiplier', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const config = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = config
      ? await prisma.assetType.findUnique({ where: { id: config.assetTypeId } })
      : await prisma.assetType.findFirst();

    return {
      currentRate: config?.conversionRate?.toString() || assetType?.defaultConversionRate?.toString() || '1',
      defaultRate: assetType?.defaultConversionRate?.toString() || '1',
      assetTypeId: assetType?.id || null,
    };
  });

  app.put('/api/merchant/multiplier', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { multiplier, assetTypeId } = request.body as { multiplier: string; assetTypeId: string };

    if (!multiplier || !assetTypeId) {
      return reply.status(400).send({ error: 'multiplier and assetTypeId are required' });
    }

    const rate = parseFloat(multiplier);
    if (isNaN(rate) || rate <= 0) {
      return reply.status(400).send({ error: 'multiplier must be a positive number' });
    }

    const config = await prisma.tenantAssetConfig.upsert({
      where: { tenantId_assetTypeId: { tenantId, assetTypeId } },
      update: { conversionRate: rate.toFixed(8) },
      create: { tenantId, assetTypeId, conversionRate: rate.toFixed(8) },
    });

    return { success: true, newRate: config.conversionRate.toString() };
  });

  // ---- RECURRENCE RULES (Owner only) ----
  app.get('/api/merchant/recurrence-rules', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const rules = await prisma.recurrenceRule.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return { rules };
  });

  app.post('/api/merchant/recurrence-rules', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { name, intervalDays, graceDays, messageTemplate, bonusAmount } = request.body as any;

    if (!name || !intervalDays || !messageTemplate) {
      return reply.status(400).send({ error: 'name, intervalDays, and messageTemplate are required' });
    }

    const rule = await prisma.recurrenceRule.create({
      data: { tenantId, name, intervalDays: parseInt(intervalDays), graceDays: parseInt(graceDays || '1'), messageTemplate, bonusAmount: bonusAmount || null },
    });
    return { rule };
  });

  app.patch('/api/merchant/recurrence-rules/:id/toggle', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };

    const rule = await prisma.recurrenceRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });

    const updated = await prisma.recurrenceRule.update({ where: { id }, data: { active: !rule.active } });
    return { rule: updated };
  });

  app.get('/api/merchant/recurrence-notifications', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { limit = '50', offset = '0' } = request.query as any;

    const notifications = await prisma.recurrenceNotification.findMany({
      where: { tenantId },
      orderBy: { sentAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
      include: { rule: { select: { name: true } }, consumerAccount: { select: { phoneNumber: true } } },
    });
    return { notifications };
  });

  // ---- DASHBOARD ANALYTICS (Owner only) ----
  app.get('/api/merchant/analytics', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;

    const [valueIssued] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid AND event_type = 'INVOICE_CLAIMED' AND entry_type = 'CREDIT' AND status != 'reversed'
    `;

    const [valueRedeemed] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid AND event_type = 'REDEMPTION_CONFIRMED' AND entry_type = 'CREDIT' AND status != 'reversed'
    `;

    const consumerCount = await prisma.account.count({
      where: { tenantId, accountType: { in: ['shadow', 'verified'] } },
    });

    const transactionCount = await prisma.ledgerEntry.count({
      where: { tenantId, entryType: 'CREDIT' },
    });

    return {
      valueIssued: valueIssued.total,
      valueRedeemed: valueRedeemed.total,
      netBalance: (parseFloat(valueIssued.total) - parseFloat(valueRedeemed.total)).toFixed(8),
      consumerCount,
      transactionCount,
    };
  });
}
