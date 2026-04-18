import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import prisma from '../../db/client.js';
import { authenticateStaff, issueStaffTokens, verifyStaffToken } from '../../services/auth.js';
import { processCSV } from '../../services/csv-upload.js';
import { enqueueCsvJob } from '../../services/workers.js';
import { processRedemption } from '../../services/redemption.js';
import { upgradeToVerified, normalizeVenezuelanPhone, phoneTail } from '../../services/accounts.js';
import { getAccountBalance, getAccountHistory } from '../../services/ledger.js';
import { requireStaffAuth, requireOwnerRole } from '../middleware/auth.js';
import { verifyAndResolveLedgerEntry } from '../../services/qr-token.js';
import { uploadImage } from '../../services/cloudinary.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../../services/idempotency.js';
import { createBranch, listBranches, toggleBranch } from '../../services/branches.js';
import { generateBranchQR, generateMerchantQR } from '../../services/merchant-qr.js';
import { listDisputes, resolveDispute } from '../../services/disputes.js';
import { createSystemAccounts } from '../../services/accounts.js';

export default async function merchantRoutes(app: FastifyInstance) {

  // ---- PUBLIC SIGNUP (no auth required) ----
  app.post('/api/merchant/signup', async (request, reply) => {
    const {
      businessName, slug: slugInput, ownerName, ownerEmail, password,
      address, contactPhone, rif, description,
    } = request.body as {
      businessName?: string;
      slug?: string;
      ownerName?: string;
      ownerEmail?: string;
      password?: string;
      address?: string;
      contactPhone?: string;
      rif?: string;
      description?: string;
    };

    // Validation
    if (!businessName || businessName.trim().length < 2) {
      return reply.status(400).send({ error: 'El nombre del comercio es obligatorio (minimo 2 caracteres)' });
    }

    // Auto-derive slug from the business name when the client doesn't send one.
    // The slug is still the public URL identifier (valee.app/?merchant=<slug>),
    // but we no longer make the user pick it during signup — they can rename
    // it later from Configuracion.
    function deriveSlug(name: string): string {
      return name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 50)
        .replace(/^-+|-+$/g, '');
    }
    let slug = (slugInput || '').trim().toLowerCase() || deriveSlug(businessName);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(slug)) {
      // Fall back to a sanitized derivation if the provided one failed validation
      slug = deriveSlug(businessName);
    }
    if (!slug || slug.length < 2) {
      return reply.status(400).send({ error: 'No pude generar un identificador valido a partir del nombre. Usa al menos 2 letras o numeros.' });
    }
    // Ensure uniqueness by appending a short random suffix on collision.
    let attempts = 0;
    while (await prisma.tenant.findUnique({ where: { slug } })) {
      if (attempts++ > 5) break;
      const suffix = Math.random().toString(36).slice(2, 6);
      slug = `${deriveSlug(businessName).slice(0, 45)}-${suffix}`;
    }
    if (!ownerName || ownerName.trim().length < 2) {
      return reply.status(400).send({ error: 'Nombre del propietario obligatorio' });
    }
    if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      return reply.status(400).send({ error: 'Email invalido' });
    }
    if (!password || password.length < 8) {
      return reply.status(400).send({ error: 'La contrasena debe tener al menos 8 caracteres' });
    }

    // Normalize and validate optional RIF
    let normalizedRif: string | null = null;
    if (rif && rif.trim()) {
      const m = rif.trim().toUpperCase().replace(/\s+/g, '').match(/^([JVEGP])-?(\d{7,9})-?(\d)$/);
      if (!m) return reply.status(400).send({ error: 'RIF invalido. Formato: J-XXXXXXXX-X' });
      normalizedRif = `${m[1]}-${m[2]}-${m[3]}`;
    }

    // Validate optional contact phone (10-15 digits)
    if (contactPhone && contactPhone.trim()) {
      const digits = contactPhone.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) {
        return reply.status(400).send({ error: 'Telefono invalido. Debe tener entre 10 y 15 digitos.' });
      }
    }

    // Slug uniqueness already handled by the auto-suffix loop above. If after
    // all retries we still have a collision, refuse — extremely unlikely.
    const existingSlug = await prisma.tenant.findUnique({ where: { slug } });
    if (existingSlug) {
      return reply.status(409).send({ error: 'No pude reservar un identificador unico para el comercio. Intenta de nuevo.' });
    }

    // Check RIF not already registered
    if (normalizedRif) {
      const existingRif = await prisma.tenant.findFirst({ where: { rif: normalizedRif } });
      if (existingRif) {
        return reply.status(409).send({ error: 'Ese RIF ya esta registrado en la plataforma.' });
      }
    }

    // Check email not used by another staff
    const existingStaff = await prisma.staff.findFirst({ where: { email: ownerEmail } });
    if (existingStaff) {
      return reply.status(409).send({ error: 'Ese email ya tiene una cuenta. Inicia sesion en lugar de registrarte.' });
    }

    // Create tenant
    const tenant = await prisma.tenant.create({
      data: {
        name: businessName.trim(),
        slug,
        ownerEmail,
        rif: normalizedRif,
        address: address?.trim() || null,
        contactPhone: contactPhone?.trim() || null,
        contactEmail: ownerEmail,
        description: description?.trim() || null,
      },
    });

    // System accounts (issued_value_pool, redemption_holding)
    await createSystemAccounts(tenant.id);

    // Default asset config (use first asset type, conversion 1:1)
    const defaultAsset = await prisma.assetType.findFirst();
    if (defaultAsset) {
      await prisma.tenantAssetConfig.create({
        data: { tenantId: tenant.id, assetTypeId: defaultAsset.id, conversionRate: 1 },
      });
    }

    // Owner staff account
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.staff.create({
      data: { tenantId: tenant.id, name: ownerName.trim(), email: ownerEmail, passwordHash, role: 'owner' },
    });

    // Generate merchant QR (best effort, don't fail signup if Cloudinary down)
    try {
      await generateMerchantQR(tenant.id);
    } catch (err) {
      console.error('[Signup] QR generation failed (non-fatal):', err);
    }

    // Auto-login: issue staff tokens so the new owner lands authenticated
    const newStaff = await prisma.staff.findFirst({ where: { tenantId: tenant.id, role: 'owner' } });
    if (!newStaff) return reply.status(500).send({ error: 'Error inesperado tras crear cuenta' });
    const tokens = issueStaffTokens({ staffId: newStaff.id, tenantId: tenant.id, role: 'owner', type: 'staff' });

    return {
      success: true,
      ...tokens,
      staff: { id: newStaff.id, name: newStaff.name, role: newStaff.role },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    };
  });

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
    const { email, password, tenantSlug } = request.body as { email: string; password: string; tenantSlug?: string };

    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password required' });
    }

    // Resolve tenant: explicit slug wins; otherwise try to infer it from the
    // email. The slug only becomes mandatory when the same email exists as
    // staff in more than one tenant (rare in practice — typically a consultant
    // working for several stores).
    let tenant = null as Awaited<ReturnType<typeof prisma.tenant.findUnique>>;
    if (tenantSlug) {
      tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
      if (!tenant) return reply.status(404).send({ error: 'Merchant not found' });
    } else {
      const matches = await prisma.staff.findMany({
        where: { email, active: true },
        include: { tenant: true },
      });
      if (matches.length === 0) return reply.status(401).send({ error: 'Invalid credentials' });
      if (matches.length > 1) {
        return reply.status(409).send({
          error: 'Este email esta vinculado a varios comercios. Indica el codigo del comercio.',
          requiresTenantSlug: true,
          tenantOptions: matches.map(m => ({ slug: m.tenant.slug, name: m.tenant.name })),
        });
      }
      tenant = matches[0].tenant;
    }

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
    const { csvContent, async: useAsync, requestId } = request.body as { csvContent: string; async?: boolean; requestId?: string };

    if (!csvContent) return reply.status(400).send({ error: 'csvContent is required' });

    // Client-supplied requestId idempotency. Re-submitting the same batch
    // (e.g. owner double-clicks upload, or the client retries after a flaky
    // connection) returns the first result instead of re-running processCSV.
    // Per-row idempotency is already guaranteed by the UNIQUE(tenant_id,
    // invoice_number) constraint — this just avoids redoing the parse.
    if (requestId) {
      const cacheKey = `csv:${tenantId}:${requestId}`;
      const cached = await checkIdempotencyKey(cacheKey);
      if (cached) return cached;
    }

    // Plan limit check
    const { enforceLimit } = await import('../../services/plan-limits.js');
    try { await enforceLimit(tenantId, 'csv_uploads'); }
    catch (e: any) { return reply.status(402).send({ error: e.message, usage: e.usage }); }

    // If async=true and Redis is configured, queue the job
    if (useAsync && process.env.REDIS_URL) {
      const jobId = await enqueueCsvJob(csvContent, tenantId, staffId);
      const queuedResult = { success: true, jobId, status: 'queued', message: 'CSV processing queued' };
      if (requestId) {
        await storeIdempotencyKey(`csv:${tenantId}:${requestId}`, 'csv_upload', queuedResult);
      }
      return queuedResult;
    }

    // Otherwise process synchronously
    const result = await processCSV(csvContent, tenantId, staffId);

    if (requestId) {
      await storeIdempotencyKey(`csv:${tenantId}:${requestId}`, 'csv_upload', result);
    }

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

  // List invoices (from CSV uploads + claimed/pending). Provides the "did my
  // CSV actually land?" visibility the merchant dashboard was missing.
  app.get('/api/merchant/invoices', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { status, batchId, search, limit = '50', offset = '0' } = request.query as {
      status?: string; batchId?: string; search?: string; limit?: string; offset?: string;
    };
    const where: any = { tenantId };
    if (status) where.status = status;
    if (batchId) where.uploadBatchId = batchId;
    if (search) where.invoiceNumber = { contains: search, mode: 'insensitive' };

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(limit) || 50, 200),
        skip: parseInt(offset) || 0,
      }),
      prisma.invoice.count({ where }),
    ]);

    const statusCounts = await prisma.invoice.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: { _all: true },
    });
    const counts: Record<string, number> = { available: 0, claimed: 0, pending_validation: 0, rejected: 0 };
    for (const row of statusCounts) counts[row.status] = row._count._all;

    return {
      invoices: invoices.map(i => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        amount: i.amount.toString(),
        transactionDate: i.transactionDate,
        customerPhone: i.customerPhone,
        status: i.status,
        uploadBatchId: i.uploadBatchId,
        createdAt: i.createdAt,
      })),
      total,
      counts,
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
    const { token, requestId } = request.body as { token: string; requestId?: string };

    if (!token) return reply.status(400).send({ error: 'token is required' });

    // Client-supplied requestId idempotency: a client offline-queue resubmit of
    // the SAME scan should return the first result, not re-process. Canonical
    // protection against double-processing is still the RedemptionToken row
    // itself (status='used' on first scan, second scan rejects), but retries
    // that hit us before the token mutates benefit from this cache.
    if (requestId) {
      const cacheKey = `scan:${tenantId}:${requestId}`;
      const cached = await checkIdempotencyKey(cacheKey);
      if (cached) return cached;
    }

    const result = await processRedemption({
      token,
      cashierStaffId: staffId,
      cashierTenantId: tenantId,
    });

    if (requestId) {
      const cacheKey = `scan:${tenantId}:${requestId}`;
      await storeIdempotencyKey(cacheKey, 'redemption_scan', result);
    }

    if (!result.success) {
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
      // Invoices can be linked to the account directly (consumer_account_id)
      // OR only carry customer_phone (older CSV rows, before the auto-credit
      // link was added). Match both so older data still shows up.
      const tail = phoneTail(acc.phoneNumber);
      const invoiceWhere: any = {
        tenantId,
        OR: [
          { consumerAccountId: acc.id },
          ...(tail.length === 10 ? [{ customerPhone: { endsWith: tail } }] : []),
        ],
      };
      const invoiceCount = await prisma.invoice.count({ where: invoiceWhere });
      const lastInvoice = await prisma.invoice.findFirst({
        where: invoiceWhere,
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

    // Get invoice submission history — match by linked account OR by phone
    // tail so CSV rows without consumer_account_id still surface.
    const tail = phoneTail(account.phoneNumber);
    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId,
        OR: [
          { consumerAccountId: account.id },
          ...(tail.length === 10 ? [{ customerPhone: { endsWith: tail } }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: { branch: { select: { id: true, name: true } } },
      take: 20,
    });

    return {
      account: {
        id: account.id,
        phoneNumber: account.phoneNumber,
        displayName: account.displayName,
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
        uploadedAt: i.createdAt,
        createdAt: i.createdAt,
        branch: i.branch ? { id: i.branch.id, name: i.branch.name } : null,
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

  // ---- UPDATE CUSTOMER DATA (displayName, cedula) ----
  app.patch('/api/merchant/customers/:id', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { id } = request.params as { id: string };
    const { displayName, cedula } = request.body as { displayName?: string | null; cedula?: string | null };

    const account = await prisma.account.findFirst({
      where: { id, tenantId, accountType: { in: ['shadow', 'verified'] } },
    });
    if (!account) return reply.status(404).send({ error: 'Cliente no encontrado' });

    const updates: { displayName?: string | null; cedula?: string | null } = {};

    if (displayName !== undefined) {
      const trimmed = displayName ? displayName.trim() : null;
      updates.displayName = trimmed || null;
    }

    if (cedula !== undefined) {
      const normalized = cedula ? cedula.replace(/[\s\-]/g, '').toUpperCase() : null;
      if (normalized) {
        // Check cedula isn't already linked to a different account in this tenant
        const conflict = await prisma.account.findFirst({
          where: { tenantId, cedula: normalized, NOT: { id } },
          select: { id: true, phoneNumber: true },
        });
        if (conflict) {
          return reply.status(409).send({
            error: 'Esta cedula ya esta vinculada a otro cliente',
            existingPhone: conflict.phoneNumber,
          });
        }
      }
      updates.cedula = normalized;
    }

    const updated = await prisma.account.update({
      where: { id },
      data: updates,
    });

    try {
      await prisma.$executeRaw`
        INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, consumer_account_id, outcome, metadata, created_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff',
          ${request.staff!.role}::"AuditActorRole", 'CUSTOMER_LOOKUP', ${id}::uuid, 'success',
          ${JSON.stringify({ action: 'customer_edit', updates })}::jsonb, now())
      `;
    } catch (err) {
      console.error('[Audit] customer edit log failed:', err);
    }

    return {
      success: true,
      account: {
        id: updated.id,
        phoneNumber: updated.phoneNumber,
        displayName: updated.displayName,
        cedula: updated.cedula,
        accountType: updated.accountType,
      },
    };
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
      select: {
        id: true, name: true, email: true, role: true, active: true, branchId: true, createdAt: true,
        qrSlug: true, qrCodeUrl: true, qrGeneratedAt: true,
      },
    });
    return { staff: staffList };
  });

  // ---- GENERATE STAFF QR (Owner only) ----
  app.post('/api/merchant/staff/:id/qr', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId: actorId } = request.staff!;
    const { id } = request.params as { id: string };

    const target = await prisma.staff.findFirst({ where: { id, tenantId } });
    if (!target) return reply.status(404).send({ error: 'Staff member not found' });

    const { generateStaffQR } = await import('../../services/merchant-qr.js');
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
      referralBonusAmount: tenant?.referralBonusAmount ?? 100,
      rif: tenant?.rif || null,
      name: tenant?.name || '',
      logoUrl: tenant?.logoUrl || null,
      address: tenant?.address || null,
      contactPhone: tenant?.contactPhone || null,
      contactEmail: tenant?.contactEmail || null,
      website: tenant?.website || null,
      description: tenant?.description || null,
      instagramHandle: tenant?.instagramHandle || null,
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
    const {
      welcomeBonusAmount, referralBonusAmount, rif, preferredExchangeSource, referenceCurrency, trustLevel, logoUrl,
      name, address, contactPhone, contactEmail, website, description, instagramHandle,
    } = request.body as {
      welcomeBonusAmount?: number;
      referralBonusAmount?: number;
      rif?: string;
      preferredExchangeSource?: string | null;
      referenceCurrency?: string;
      trustLevel?: string;
      logoUrl?: string | null;
      name?: string;
      address?: string | null;
      contactPhone?: string | null;
      contactEmail?: string | null;
      website?: string | null;
      description?: string | null;
      instagramHandle?: string | null;
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
    if (referralBonusAmount !== undefined) {
      if (typeof referralBonusAmount !== 'number' || referralBonusAmount < 0) {
        return reply.status(400).send({ error: 'referralBonusAmount must be a non-negative number' });
      }
      data.referralBonusAmount = referralBonusAmount;
    }
    if (rif !== undefined) {
      if (!rif || (typeof rif === 'string' && !rif.trim())) {
        data.rif = null;
      } else {
        // Normalize and validate: [JVEGP]-XXXXXXXX-X (7-9 digits body + 1 check digit)
        const normalized = String(rif).trim().toUpperCase().replace(/\s+/g, '');
        const match = normalized.match(/^([JVEGP])-?(\d{7,9})-?(\d)$/);
        if (!match) {
          return reply.status(400).send({
            error: 'RIF invalido. Formato: J-XXXXXXXX-X (prefijo J, V, E, G o P; 7-9 digitos; 1 digito verificador)',
          });
        }
        data.rif = `${match[1]}-${match[2]}-${match[3]}`;
      }
    }
    if (preferredExchangeSource !== undefined) {
      if (preferredExchangeSource !== null && !validSources.includes(preferredExchangeSource)) {
        return reply.status(400).send({ error: `preferredExchangeSource must be one of: ${validSources.join(', ')} or null` });
      }
      data.preferredExchangeSource = preferredExchangeSource;

      // Each source only has rates for a specific currency. If the merchant
      // changes the source, auto-align reference_currency so we never end up
      // asking for (euro_bcv, usd) — a combination that has no exchange rate
      // and would silently fall back to treating Bs as if it were the ref
      // currency, giving absurd point totals.
      const sourceToCurrency: Record<string, string> = {
        bcv: 'usd',
        promedio: 'usd',
        euro_bcv: 'eur',
      };
      const aligned = sourceToCurrency[preferredExchangeSource as string];
      if (aligned) data.referenceCurrency = aligned;
    }
    if (referenceCurrency !== undefined && data.referenceCurrency === undefined) {
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
    if (logoUrl !== undefined) {
      data.logoUrl = logoUrl || null;
    }
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (trimmed.length < 2 || trimmed.length > 255) {
        return reply.status(400).send({ error: 'Nombre debe tener entre 2 y 255 caracteres' });
      }
      data.name = trimmed;
    }
    if (address !== undefined) {
      const v = address ? String(address).trim() : null;
      if (v && v.length > 500) return reply.status(400).send({ error: 'Direccion no puede exceder 500 caracteres' });
      data.address = v || null;
    }
    if (contactPhone !== undefined) {
      const v = contactPhone ? String(contactPhone).trim() : null;
      if (v && v.length > 30) return reply.status(400).send({ error: 'Telefono no puede exceder 30 caracteres' });
      data.contactPhone = v || null;
    }
    if (contactEmail !== undefined) {
      const v = contactEmail ? String(contactEmail).trim() : null;
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        return reply.status(400).send({ error: 'Email invalido' });
      }
      data.contactEmail = v || null;
    }
    if (website !== undefined) {
      const v = website ? String(website).trim() : null;
      data.website = v || null;
    }
    if (description !== undefined) {
      const v = description ? String(description).trim() : null;
      if (v && v.length > 1000) return reply.status(400).send({ error: 'Descripcion no puede exceder 1000 caracteres' });
      data.description = v || null;
    }
    if (instagramHandle !== undefined) {
      const v = instagramHandle ? String(instagramHandle).trim().replace(/^@/, '') : null;
      if (v && v.length > 100) return reply.status(400).send({ error: 'Instagram no puede exceder 100 caracteres' });
      data.instagramHandle = v || null;
    }

    const updated = await prisma.tenant.update({ where: { id: tenantId }, data });
    return {
      welcomeBonusAmount: updated.welcomeBonusAmount,
      rif: updated.rif,
      name: updated.name,
      logoUrl: updated.logoUrl,
      address: updated.address,
      contactPhone: updated.contactPhone,
      contactEmail: updated.contactEmail,
      website: updated.website,
      description: updated.description,
      instagramHandle: updated.instagramHandle,
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

    // Include the current Bs→reference exchange rate so the merchant UI can
    // preview how many points a given Bs amount will produce before committing
    // (e.g. the dual-scan "transaccion sin factura" widget).
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { preferredExchangeSource: true, referenceCurrency: true },
    });
    let exchangeRateBs: number | null = null;
    if (tenant?.preferredExchangeSource && tenant.referenceCurrency) {
      const { getCurrentRate } = await import('../../services/exchange-rates.js');
      const rate = await getCurrentRate(tenant.preferredExchangeSource, tenant.referenceCurrency);
      if (rate) exchangeRateBs = rate.rateBs;
    }

    return {
      currentRate: config?.conversionRate?.toString() || assetType?.defaultConversionRate?.toString() || '1',
      defaultRate: assetType?.defaultConversionRate?.toString() || '1',
      assetTypeId: assetType?.id || null,
      preferredExchangeSource: tenant?.preferredExchangeSource || null,
      referenceCurrency: tenant?.referenceCurrency || null,
      exchangeRateBs,
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
    const { name, intervalDays, graceDays, messageTemplate, bonusAmount, targetPhones } = request.body as any;

    if (!name || !intervalDays || !messageTemplate) {
      return reply.status(400).send({ error: 'name, intervalDays, and messageTemplate are required' });
    }

    const normalizedPhones = Array.isArray(targetPhones)
      ? targetPhones.map((p: string) => normalizeVenezuelanPhone(String(p))).filter((p: string) => p && p.length >= 10)
      : [];

    const rule = await prisma.recurrenceRule.create({
      data: {
        tenantId, name, intervalDays: parseInt(intervalDays), graceDays: parseInt(graceDays || '1'),
        messageTemplate, bonusAmount: bonusAmount || null,
        targetPhones: normalizedPhones,
      },
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

  app.patch('/api/merchant/recurrence-rules/:id', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };
    const { name, intervalDays, graceDays, messageTemplate, bonusAmount, targetPhones } = request.body as any;

    const rule = await prisma.recurrenceRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });

    const updates: any = {};
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (trimmed.length < 4 || trimmed.length > 80) {
        return reply.status(400).send({ error: 'Nombre debe tener entre 4 y 80 caracteres' });
      }
      updates.name = trimmed;
    }
    if (intervalDays !== undefined) {
      const n = parseInt(intervalDays);
      if (isNaN(n) || n < 1 || n > 365) {
        return reply.status(400).send({ error: 'Intervalo debe estar entre 1 y 365 dias' });
      }
      updates.intervalDays = n;
    }
    if (graceDays !== undefined) {
      const n = parseInt(graceDays);
      if (isNaN(n) || n < 0 || n > 90) {
        return reply.status(400).send({ error: 'Gracia debe estar entre 0 y 90 dias' });
      }
      updates.graceDays = n;
    }
    if (messageTemplate !== undefined) {
      const trimmed = String(messageTemplate).trim();
      if (trimmed.length < 20 || trimmed.length > 500) {
        return reply.status(400).send({ error: 'Mensaje debe tener entre 20 y 500 caracteres' });
      }
      updates.messageTemplate = trimmed;
    }
    if (bonusAmount !== undefined) {
      if (bonusAmount === null || bonusAmount === '') {
        updates.bonusAmount = null;
      } else {
        const n = parseInt(bonusAmount);
        if (isNaN(n) || n < 1) {
          return reply.status(400).send({ error: 'Bono debe ser un numero positivo' });
        }
        updates.bonusAmount = n;
      }
    }
    if (targetPhones !== undefined) {
      if (!Array.isArray(targetPhones)) {
        return reply.status(400).send({ error: 'targetPhones debe ser un array' });
      }
      updates.targetPhones = targetPhones
        .map((p: string) => normalizeVenezuelanPhone(String(p)))
        .filter((p: string) => p && p.length >= 10);
    }

    const updated = await prisma.recurrenceRule.update({ where: { id }, data: updates });
    return { rule: updated };
  });

  app.delete('/api/merchant/recurrence-rules/:id', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };

    const rule = await prisma.recurrenceRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });

    // Hard delete: remove dependent notifications first, then the rule.
    // Notifications are historical records — losing them is acceptable for a
    // user-initiated delete (they're not financial). The audit_log row for
    // CUSTOMER_LOOKUP/etc. lives separately and is preserved.
    await prisma.recurrenceNotification.deleteMany({ where: { ruleId: id } });
    await prisma.recurrenceRule.delete({ where: { id } });
    return { success: true };
  });

  // Preview: list the consumers who would receive a message from this rule right now
  app.get('/api/merchant/recurrence-rules/:id/eligible', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };

    const rule = await prisma.recurrenceRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });

    const thresholdDays = rule.intervalDays + rule.graceDays;
    const cutoffDate = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);

    // Find consumers whose last INVOICE_CLAIMED was before the cutoff
    let lapsed = await prisma.$queryRaw<Array<{
      account_id: string;
      phone_number: string;
      display_name: string | null;
      cedula: string | null;
      last_visit: Date;
    }>>`
      SELECT a.id AS account_id, a.phone_number, a.display_name, a.cedula, sub.last_visit
      FROM accounts a
      INNER JOIN (
        SELECT account_id, MAX(created_at) AS last_visit
        FROM ledger_entries
        WHERE tenant_id = ${tenantId}::uuid
          AND event_type = 'INVOICE_CLAIMED'
          AND entry_type = 'CREDIT'
          AND status != 'reversed'
        GROUP BY account_id
        HAVING MAX(created_at) < ${cutoffDate}
      ) sub ON sub.account_id = a.id
      WHERE a.tenant_id = ${tenantId}::uuid
        AND a.account_type IN ('shadow', 'verified')
        AND a.phone_number IS NOT NULL
      ORDER BY sub.last_visit ASC
    `;

    // If the rule has a targetPhones list, restrict to those (compare last 10 digits)
    if (rule.targetPhones && rule.targetPhones.length > 0) {
      const targetTails = new Set(rule.targetPhones.map(p => p.replace(/\D/g, '').slice(-10)));
      lapsed = lapsed.filter(c => targetTails.has(c.phone_number.replace(/\D/g, '').slice(-10)));
    }

    // Check which ones have already been notified for their current absence event
    const consumers = await Promise.all(lapsed.map(async c => {
      const notified = await prisma.recurrenceNotification.findUnique({
        where: {
          tenantId_ruleId_consumerAccountId_lastVisitAt: {
            tenantId,
            ruleId: rule.id,
            consumerAccountId: c.account_id,
            lastVisitAt: c.last_visit,
          },
        },
        select: { id: true, sentAt: true },
      });
      const daysSince = Math.floor(
        (Date.now() - new Date(c.last_visit).getTime()) / (24 * 60 * 60 * 1000)
      );
      return {
        accountId: c.account_id,
        phoneNumber: c.phone_number,
        displayName: c.display_name,
        cedula: c.cedula,
        lastVisit: c.last_visit.toISOString(),
        daysSince,
        alreadyNotified: !!notified,
        notifiedAt: notified?.sentAt.toISOString() || null,
      };
    }));

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      thresholdDays,
      total: consumers.length,
      pending: consumers.filter(c => !c.alreadyNotified).length,
      alreadyNotified: consumers.filter(c => c.alreadyNotified).length,
      consumers,
    };
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

    // Deduplicate double-entry: each financial event writes TWO ledger rows
    // (debit+credit). Showing both doubles the list and confuses the owner —
    // they see "+12" and "-12" for the same event. Keep the consumer-side row
    // when it exists (the one touching a shadow/verified account); when both
    // sides are system accounts (e.g. REDEMPTION_CONFIRMED: holding→pool),
    // keep the CREDIT row so the event still appears exactly once.
    conditions.push(`(
      a.account_type IN ('shadow', 'verified')
      OR (
        le.entry_type = 'CREDIT'
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries le2
          LEFT JOIN accounts a2 ON a2.id = le2.account_id
          WHERE le2.tenant_id = le.tenant_id
            AND le2.reference_id = le.reference_id
            AND a2.account_type IN ('shadow', 'verified')
        )
      )
    )`);

    const whereClause = conditions.join(' AND ');
    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    const entries = await prisma.$queryRawUnsafe<any[]>(`
      SELECT le.id, le.event_type, le.entry_type, le.amount::text, le.status, le.reference_id,
             le.branch_id, le.created_at, le.metadata,
             a.phone_number as account_phone,
             a.display_name as account_name,
             b.name as branch_name
      FROM ledger_entries le
      LEFT JOIN accounts a ON a.id = le.account_id
      LEFT JOIN branches b ON b.id = le.branch_id
      WHERE ${whereClause}
      ORDER BY le.created_at DESC
      LIMIT ${lim} OFFSET ${off}
    `, ...params);

    const [countResult] = await prisma.$queryRawUnsafe<[{ count: bigint }]>(`
      SELECT COUNT(*) as count
      FROM ledger_entries le
      LEFT JOIN accounts a ON a.id = le.account_id
      WHERE ${whereClause}
    `, ...params);

    return {
      entries: entries.map(e => {
        const meta: any = e.metadata || {};
        return {
          id: e.id,
          eventType: e.event_type,
          entryType: e.entry_type,
          amount: e.amount,
          status: e.status,
          referenceId: e.reference_id,
          branchId: e.branch_id,
          branchName: e.branch_name,
          accountPhone: e.account_phone,
          accountName: e.account_name || null,
          // Product info stamped at write time survives token cleanup; also
          // pull invoice number when the event is an invoice claim so the
          // merchant row shows "which invoice" without clicking in. Fallback
          // to referenceId for INVOICE_CLAIMED rows that predate the metadata
          // stamping (referenceId on those is the invoice number itself).
          productName: meta.productName || null,
          productPhotoUrl: meta.productPhotoUrl || null,
          invoiceNumber: meta.invoiceNumber
            || (e.event_type === 'INVOICE_CLAIMED'
                ? String(e.reference_id || '').replace(/^(REVIEW|PENDING|CSV-[^:]+:)-?/i, '')
                : null),
          createdAt: e.created_at,
        };
      }),
      total: Number(countResult.count),
    };
  });
}
