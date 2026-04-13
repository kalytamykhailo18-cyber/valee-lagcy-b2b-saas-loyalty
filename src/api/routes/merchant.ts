import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import prisma from '../../db/client.js';
import { authenticateStaff, issueStaffTokens, verifyStaffToken } from '../../services/auth.js';
import { processCSV } from '../../services/csv-upload.js';
import { enqueueCsvJob } from '../../services/workers.js';
import { processRedemption } from '../../services/redemption.js';
import { upgradeToVerified } from '../../services/accounts.js';
import { getAccountBalance, getAccountHistory } from '../../services/ledger.js';
import { requireStaffAuth, requireOwnerRole } from '../middleware/auth.js';
import { verifyAndResolveLedgerEntry } from '../../services/qr-token.js';
import { uploadImage } from '../../services/cloudinary.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../../services/idempotency.js';
import { createBranch, listBranches, toggleBranch } from '../../services/branches.js';
import { generateBranchQR } from '../../services/merchant-qr.js';
import { listDisputes, resolveDispute } from '../../services/disputes.js';

export default async function merchantRoutes(app: FastifyInstance) {

  // ---- IMAGE UPLOAD (Owner only) ----
  app.post('/api/merchant/upload-image', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return reply.status(400).send({ error: 'Invalid file type. Allowed: JPEG, PNG, WebP, GIF' });
    }

    const buffer = await file.toBuffer();
    const url = await uploadImage(buffer, 'loyalty-platform/products');

    if (!url) {
      return reply.status(500).send({ error: 'Image upload failed. Check Cloudinary configuration.' });
    }

    return { success: true, url };
  });

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

  // ---- AUTH: Refresh staff token ----
  app.post('/api/merchant/auth/refresh', async (request, reply) => {
    const refreshToken = (request.body as any)?.refreshToken;
    if (!refreshToken) return reply.status(400).send({ error: 'refreshToken required' });

    try {
      const payload = verifyStaffToken(refreshToken);
      const tokens = issueStaffTokens({
        staffId: payload.staffId,
        tenantId: payload.tenantId,
        role: payload.role,
        type: 'staff',
      });
      return { success: true, ...tokens };
    } catch {
      return reply.status(401).send({ error: 'Invalid refresh token' });
    }
  });

  // ---- CSV UPLOAD (Owner only) ----
  app.post('/api/merchant/csv-upload', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { csvContent, async: useAsync } = request.body as { csvContent: string; async?: boolean };

    if (!csvContent) return reply.status(400).send({ error: 'csvContent is required' });

    // Plan limit check
    const { enforceLimit } = await import('../../services/plan-limits.js');
    try { await enforceLimit(tenantId, 'csv_uploads'); }
    catch (e: any) { return reply.status(402).send({ error: e.message, usage: e.usage }); }

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
    const { name, description, photoUrl, redemptionCost, cashPrice, assetTypeId, stock, minLevel } = request.body as any;

    if (!name || !redemptionCost || !assetTypeId) {
      return reply.status(400).send({ error: 'name, redemptionCost, and assetTypeId are required' });
    }

    // Plan limit check
    const { enforceLimit } = await import('../../services/plan-limits.js');
    try { await enforceLimit(tenantId, 'products_in_catalog'); }
    catch (e: any) { return reply.status(402).send({ error: e.message, usage: e.usage }); }

    const product = await prisma.product.create({
      data: { tenantId, name, description, photoUrl, redemptionCost, cashPrice: cashPrice || null, assetTypeId, stock: stock || 0, minLevel: minLevel || 1, active: true },
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
        cashPrice: data.cashPrice !== undefined ? (data.cashPrice || null) : product.cashPrice,
        stock: data.stock != null ? parseInt(data.stock) : product.stock,
        minLevel: data.minLevel != null ? parseInt(data.minLevel) : product.minLevel,
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

  // ---- DUAL-SCAN: Cashier initiates a transaction without a fiscal invoice ----
  app.post('/api/merchant/dual-scan/initiate', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { staffId, tenantId } = request.staff!;
    const { amount, branchId } = request.body as { amount: string; branchId?: string };

    if (!amount || typeof amount !== 'string') {
      return reply.status(400).send({ error: 'amount is required (string)' });
    }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return reply.status(400).send({ error: 'amount must be a positive number' });
    }

    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();
    if (!assetType) return reply.status(500).send({ error: 'No asset type configured' });

    // Resolve branch: if cashier has a branchId, use that; otherwise use the provided one
    const cashier = await prisma.staff.findUnique({ where: { id: staffId } });
    const effectiveBranchId = cashier?.branchId || branchId || null;

    const { initiateDualScan } = await import('../../services/dual-scan.js');
    const result = await initiateDualScan({
      tenantId,
      cashierId: staffId,
      branchId: effectiveBranchId,
      amount,
      assetTypeId: assetType.id,
    });

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    // Audit the cashier action
    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type,
        amount, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'cashier',
        'QR_SCAN_SUCCESS', ${amountNum}, 'success',
        ${JSON.stringify({ kind: 'dual_scan_initiate', branchId: effectiveBranchId })}::jsonb, now())
    `;

    return { success: true, token: result.token, expiresAt: result.expiresAt };
  });

  // ---- CASHIER QR SCANNER ----
  app.post('/api/merchant/scan-redemption', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { staffId, tenantId } = request.staff!;
    const { token } = request.body as { token: string };

    if (!token) return reply.status(400).send({ error: 'token is required' });

    // Idempotency check: use the token itself as the natural idempotency key
    const idempotencyKey = `scan:${tenantId}:${token}`;
    const cached = await checkIdempotencyKey(idempotencyKey);
    if (cached) {
      return cached;
    }

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

    // Store idempotency after successful scan
    if (result.success) {
      await storeIdempotencyKey(idempotencyKey, 'scan_redemption', result);
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
  // ---- CUSTOMERS LIST (all consumers who have interacted with this merchant) ----
  app.get('/api/merchant/customers', { preHandler: [requireStaffAuth] }, async (request) => {
    const { tenantId } = request.staff!;
    const { limit = '50', offset = '0', search = '' } = request.query as { limit?: string; offset?: string; search?: string };

    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();

    const where: any = {
      tenantId,
      accountType: { in: ['shadow', 'verified'] },
    };
    if (search) {
      where.OR = [
        { phoneNumber: { contains: search } },
        { cedula: { contains: search } },
      ];
    }

    const [accounts, total] = await Promise.all([
      prisma.account.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: lim,
        skip: off,
      }),
      prisma.account.count({ where }),
    ]);

    const customers = await Promise.all(accounts.map(async (acc) => {
      let balance = '0';
      if (assetType) {
        balance = await getAccountBalance(acc.id, assetType.id, tenantId);
      }
      const invoiceCount = await prisma.invoice.count({
        where: { tenantId, consumerAccountId: acc.id },
      });
      const lastInvoice = await prisma.invoice.findFirst({
        where: { tenantId, consumerAccountId: acc.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, invoiceNumber: true, amount: true, status: true },
      });

      return {
        id: acc.id,
        phoneNumber: acc.phoneNumber,
        accountType: acc.accountType,
        cedula: acc.cedula,
        level: acc.level,
        balance,
        invoiceCount,
        lastInvoice: lastInvoice ? {
          invoiceNumber: lastInvoice.invoiceNumber,
          amount: lastInvoice.amount.toString(),
          status: lastInvoice.status,
          date: lastInvoice.createdAt,
        } : null,
        createdAt: acc.createdAt,
      };
    }));

    return { customers, total, unitLabel: assetType?.unitLabel || 'pts' };
  });

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

    // Get invoice submission history
    const invoices = await prisma.invoice.findMany({
      where: { tenantId, consumerAccountId: account.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      account: {
        id: account.id,
        phoneNumber: account.phoneNumber,
        accountType: account.accountType,
        cedula: account.cedula,
        level: account.level,
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
      invoices: invoices.map(i => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        amount: i.amount.toString(),
        status: i.status,
        transactionDate: i.transactionDate,
        createdAt: i.createdAt,
      })),
    };
  });

  // ---- IDENTITY UPGRADE (Cashier + Owner) ----
  app.post('/api/merchant/identity-upgrade', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { phoneNumber, cedula, force } = request.body as { phoneNumber: string; cedula: string; force?: boolean };

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
      if (!force) {
        return reply.status(409).send({
          error: 'This cedula is already linked to another phone number',
          existingPhone: existing.phoneNumber,
          requiresConfirmation: true,
        });
      }
      // Force-override: unlink the cedula from the previous account
      await prisma.account.update({
        where: { id: existing.id },
        data: { cedula: null },
      });
      await prisma.$executeRaw`
        INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, consumer_account_id, outcome, metadata, created_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff',
          ${request.staff!.role}::"AuditActorRole", 'IDENTITY_UPGRADE', ${existing.id}::uuid, 'success',
          ${JSON.stringify({ action: 'cedula_unlinked_for_override', cedula, transferredTo: account.id })}::jsonb, now())
      `;
    }

    const upgraded = await upgradeToVerified(account.id, tenantId, cedula);

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, consumer_account_id, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff',
        ${request.staff!.role}::"AuditActorRole", 'IDENTITY_UPGRADE', ${account.id}::uuid, 'success',
        ${JSON.stringify({ cedula, forced: !!force })}::jsonb, now())
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

    // Plan limit check
    const { enforceLimit } = await import('../../services/plan-limits.js');
    try { await enforceLimit(tenantId, 'staff_members'); }
    catch (e: any) { return reply.status(402).send({ error: e.message, usage: e.usage }); }

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

  // ---- LIST STAFF (Owner only) ----
  app.get('/api/merchant/staff', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const staffList = await prisma.staff.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, email: true, role: true, active: true, branchId: true, createdAt: true },
    });
    return { staff: staffList };
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

  // ---- AUDIT TRAIL (Owner only) ----
  app.get('/api/merchant/audit-log', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { limit = '50', offset = '0', actionType } = request.query as any;

    const where: any = { tenantId };
    if (actionType) where.actionType = actionType;

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

  // ---- TENANT SETTINGS (Owner only) ----
  app.get('/api/merchant/settings', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();
    return {
      welcomeBonusAmount: tenant?.welcomeBonusAmount ?? 50,
      rif: tenant?.rif || null,
      name: tenant?.name || '',
      preferredExchangeSource: tenant?.preferredExchangeSource || null,
      referenceCurrency: tenant?.referenceCurrency || 'usd',
      trustLevel: tenant?.trustLevel || 'level_2_standard',
      assetTypeId: assetType?.id || null,
      assetTypeName: assetType?.name || null,
      unitLabel: assetType?.unitLabel || 'pts',
    };
  });

  app.put('/api/merchant/settings', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { welcomeBonusAmount, rif, preferredExchangeSource, referenceCurrency, trustLevel } = request.body as {
      welcomeBonusAmount?: number;
      rif?: string;
      preferredExchangeSource?: string | null;
      referenceCurrency?: string;
      trustLevel?: string;
    };

    const validSources = ['bcv', 'binance_p2p', 'bybit_p2p', 'promedio', 'euro_bcv'];
    const validCurrencies = ['usd', 'eur', 'bs'];
    const validTrustLevels = ['level_1_strict', 'level_2_standard', 'level_3_presence'];

    const data: any = {};
    if (welcomeBonusAmount !== undefined) {
      if (typeof welcomeBonusAmount !== 'number' || welcomeBonusAmount < 0) {
        return reply.status(400).send({ error: 'welcomeBonusAmount must be a non-negative number' });
      }
      data.welcomeBonusAmount = welcomeBonusAmount;
    }
    if (rif !== undefined) {
      data.rif = rif || null;
    }
    if (preferredExchangeSource !== undefined) {
      if (preferredExchangeSource !== null && !validSources.includes(preferredExchangeSource)) {
        return reply.status(400).send({ error: `preferredExchangeSource must be one of: ${validSources.join(', ')} or null` });
      }
      data.preferredExchangeSource = preferredExchangeSource;
    }
    if (referenceCurrency !== undefined) {
      if (!validCurrencies.includes(referenceCurrency)) {
        return reply.status(400).send({ error: `referenceCurrency must be one of: ${validCurrencies.join(', ')}` });
      }
      data.referenceCurrency = referenceCurrency;
    }
    if (trustLevel !== undefined) {
      if (!validTrustLevels.includes(trustLevel)) {
        return reply.status(400).send({ error: `trustLevel must be one of: ${validTrustLevels.join(', ')}` });
      }
      data.trustLevel = trustLevel;
    }

    const updated = await prisma.tenant.update({ where: { id: tenantId }, data });
    return {
      welcomeBonusAmount: updated.welcomeBonusAmount,
      rif: updated.rif,
      name: updated.name,
      preferredExchangeSource: updated.preferredExchangeSource,
      referenceCurrency: updated.referenceCurrency,
      trustLevel: updated.trustLevel,
    };
  });

  // ---- ATTRIBUTION ROI ----
  app.get('/api/merchant/attribution-roi', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { from, to } = request.query as { from?: string; to?: string };
    const { getAttributionRoi } = await import('../../services/attribution.js');
    return getAttributionRoi({
      tenantId,
      fromDate: from ? new Date(from) : undefined,
      toDate: to ? new Date(to) : undefined,
    });
  });

  // ---- PLAN USAGE ----
  app.get('/api/merchant/plan-usage', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { getUsageSummary } = await import('../../services/plan-limits.js');
    return getUsageSummary(tenantId);
  });

  // Read-only: current exchange rates available in the system
  app.get('/api/merchant/exchange-rates', { preHandler: [requireStaffAuth] }, async () => {
    const rates = await prisma.$queryRaw<any[]>`
      SELECT DISTINCT ON (source, currency)
        source, currency, rate_bs as "rateBs", reported_at as "reportedAt", fetched_at as "fetchedAt"
      FROM exchange_rates
      ORDER BY source, currency, fetched_at DESC
    `;
    return { rates: rates.map(r => ({ ...r, rateBs: Number(r.rateBs) })) };
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
    const { tenantId, staffId } = request.staff!;
    const { id } = request.params as { id: string };
    const { action, reason } = request.body as { action: 'approve' | 'reject'; reason: string };

    if (!action || !reason) return reply.status(400).send({ error: 'action and reason required' });

    const { resolveManualReview } = await import('../../services/reconciliation.js');
    const result = await resolveManualReview({
      invoiceId: id, action, reason, resolverType: 'staff', resolverId: staffId,
    });
    return result;
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

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'owner', 'BRANCH_CREATED', 'success',
        ${JSON.stringify({ branchId: branch.id, name })}::jsonb, now())
    `;

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

  app.post('/api/merchant/branches/:id/generate-qr', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { id } = request.params as { id: string };

    // Verify branch belongs to tenant
    const branch = await prisma.branch.findFirst({ where: { id, tenantId } });
    if (!branch) return reply.status(404).send({ error: 'Branch not found' });

    try {
      const result = await generateBranchQR(id);

      await prisma.$executeRaw`
        INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'owner', 'BRANCH_QR_GENERATED', 'success',
          ${JSON.stringify({ branchId: id, branchName: branch.name })}::jsonb, now())
      `;

      return { success: true, deepLink: result.deepLink, qrCodeUrl: result.qrCodeUrl };
    } catch (e: any) {
      return reply.status(500).send({ error: e.message || 'Failed to generate QR' });
    }
  });

  // ---- DISPUTES (Owner only) ----
  app.get('/api/merchant/disputes', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { status } = request.query as { status?: string };

    const disputes = await listDisputes(tenantId, status || undefined);

    // Enrich with consumer info
    const enriched = await Promise.all(disputes.map(async (d) => {
      const account = await prisma.account.findUnique({ where: { id: d.consumerAccountId } });
      return {
        id: d.id,
        description: d.description,
        screenshotUrl: d.screenshotUrl,
        status: d.status,
        consumerPhone: account?.phoneNumber || null,
        consumerAccountId: d.consumerAccountId,
        resolutionReason: d.resolutionReason,
        createdAt: d.createdAt,
        resolvedAt: d.resolvedAt,
      };
    }));

    return { disputes: enriched };
  });

  app.post('/api/merchant/disputes/:id/resolve', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { id } = request.params as { id: string };
    const { action, reason, adjustmentAmount, assetTypeId } = request.body as {
      action: 'approve' | 'reject' | 'escalate';
      reason: string;
      adjustmentAmount?: string;
      assetTypeId?: string;
    };

    if (!action || !reason) return reply.status(400).send({ error: 'action and reason are required' });

    // Verify dispute belongs to this tenant
    const dispute = await prisma.dispute.findFirst({ where: { id, tenantId } });
    if (!dispute) return reply.status(404).send({ error: 'Dispute not found' });

    // For approve, get assetTypeId if not provided
    let resolvedAssetTypeId = assetTypeId;
    if (action === 'approve' && adjustmentAmount && !resolvedAssetTypeId) {
      const at = await prisma.assetType.findFirst();
      resolvedAssetTypeId = at?.id;
    }

    const result = await resolveDispute({
      disputeId: id,
      action,
      reason,
      resolverId: staffId,
      resolverType: 'staff',
      adjustmentAmount: action === 'approve' ? adjustmentAmount : undefined,
      assetTypeId: action === 'approve' ? resolvedAssetTypeId : undefined,
    });

    return result;
  });

  // ---- MERCHANT METRICS (Owner only) — enhanced with branch filtering ----
  app.get('/api/merchant/metrics', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { branchId } = request.query as { branchId?: string };

    const { getMerchantMetrics } = await import('../../services/metrics.js');
    const metrics = await getMerchantMetrics(tenantId, branchId || undefined);

    return metrics;
  });

  // ---- PRODUCT PERFORMANCE (Owner only) ----
  app.get('/api/merchant/product-performance', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;

    const { getProductPerformance } = await import('../../services/metrics.js');
    const products = await getProductPerformance(tenantId);

    return { products };
  });

  // ---- FILTERABLE TRANSACTION HISTORY (Owner only) ----
  app.get('/api/merchant/transactions', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { startDate, endDate, eventType, status, branchId, limit = '50', offset = '0' } = request.query as {
      startDate?: string;
      endDate?: string;
      eventType?: string;
      status?: string;
      branchId?: string;
      limit?: string;
      offset?: string;
    };

    const params: any[] = [tenantId];
    const conditions: string[] = ['le.tenant_id = $1::uuid'];
    let paramIndex = 2;

    if (startDate) {
      conditions.push(`le.created_at >= $${paramIndex}::timestamptz`);
      params.push(startDate);
      paramIndex++;
    }
    if (endDate) {
      conditions.push(`le.created_at <= $${paramIndex}::timestamptz`);
      params.push(endDate);
      paramIndex++;
    }
    if (eventType) {
      conditions.push(`le.event_type = $${paramIndex}::"LedgerEventType"`);
      params.push(eventType);
      paramIndex++;
    }
    if (status) {
      conditions.push(`le.status = $${paramIndex}::"LedgerStatus"`);
      params.push(status);
      paramIndex++;
    }
    if (branchId) {
      conditions.push(`le.branch_id = $${paramIndex}::uuid`);
      params.push(branchId);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');
    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    const entries = await prisma.$queryRawUnsafe<any[]>(`
      SELECT le.id, le.event_type, le.entry_type, le.amount::text, le.status, le.reference_id,
             le.branch_id, le.created_at,
             a.phone_number as account_phone,
             b.name as branch_name
      FROM ledger_entries le
      LEFT JOIN accounts a ON a.id = le.account_id
      LEFT JOIN branches b ON b.id = le.branch_id
      WHERE ${whereClause}
      ORDER BY le.created_at DESC
      LIMIT ${lim} OFFSET ${off}
    `, ...params);

    const [countResult] = await prisma.$queryRawUnsafe<[{ count: bigint }]>(`
      SELECT COUNT(*) as count FROM ledger_entries le WHERE ${whereClause}
    `, ...params);

    return {
      entries: entries.map(e => ({
        id: e.id,
        eventType: e.event_type,
        entryType: e.entry_type,
        amount: e.amount,
        status: e.status,
        referenceId: e.reference_id,
        branchId: e.branch_id,
        branchName: e.branch_name,
        accountPhone: e.account_phone,
        createdAt: e.created_at,
      })),
      total: Number(countResult.count),
    };
  });
}
