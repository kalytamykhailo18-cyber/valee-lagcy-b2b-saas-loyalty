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
  app.post('/api/admin/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
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

  // ---- GLOBAL LEDGER AUDIT ----
  app.get('/api/admin/ledger', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { tenantId, eventType, status, dateFrom, dateTo, limit = '50', offset = '0', raw } = request.query as any;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (tenantId && !UUID_RE.test(String(tenantId))) {
      return reply.status(400).send({ error: 'tenantId debe ser un UUID valido' });
    }

    const wantRaw = raw === '1' || raw === 'true';
    const lim = parseInt(limit);
    const off = parseInt(offset);

    if (wantRaw) {
      // Raw auditor view: every ledger row (both sides of double-entry).
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
        where, orderBy: { createdAt: 'desc' }, take: lim, skip: off,
        include: { tenant: { select: { name: true } }, account: { select: { phoneNumber: true } } },
      });
      const total = await prisma.ledgerEntry.count({ where });
      return { entries, total, mode: 'raw' };
    }

    // Default dedup mode: one row per event (the consumer-side entry if it
    // exists, else the CREDIT side for system-to-system transfers like
    // REDEMPTION_CONFIRMED). Mirrors the merchant transactions view so a
    // canje like "Burguer -700" appears once, not four times.
    const params: any[] = [];
    const conds: string[] = [];
    conds.push(`(
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
    if (tenantId) { params.push(tenantId); conds.push(`le.tenant_id = $${params.length}::uuid`); }
    if (eventType) { params.push(eventType); conds.push(`le.event_type = $${params.length}::"LedgerEventType"`); }
    if (status)    { params.push(status);    conds.push(`le.status     = $${params.length}::"LedgerStatus"`); }
    if (dateFrom)  { params.push(new Date(dateFrom).toISOString()); conds.push(`le.created_at >= $${params.length}::timestamptz`); }
    if (dateTo)    { params.push(new Date(dateTo).toISOString());   conds.push(`le.created_at <= $${params.length}::timestamptz`); }

    const where = conds.join(' AND ');
    const entries = await prisma.$queryRawUnsafe<any[]>(`
      SELECT le.id, le.tenant_id AS "tenantId", le.event_type AS "eventType",
             le.entry_type AS "entryType", le.amount::text AS amount, le.status,
             le.reference_id AS "referenceId", le.branch_id AS "branchId",
             le.created_at AS "createdAt", le.metadata,
             t.name AS "tenantName", a.phone_number AS "accountPhone"
      FROM ledger_entries le
      LEFT JOIN accounts a ON a.id = le.account_id
      LEFT JOIN tenants t ON t.id = le.tenant_id
      WHERE ${where}
      ORDER BY le.created_at DESC
      LIMIT ${lim} OFFSET ${off}
    `, ...params);

    const [{ count }] = await prisma.$queryRawUnsafe<[{ count: bigint }]>(`
      SELECT COUNT(*) AS count
      FROM ledger_entries le
      LEFT JOIN accounts a ON a.id = le.account_id
      WHERE ${where}
    `, ...params);

    const shaped = entries.map(e => ({
      ...e,
      tenant: { name: e.tenantName },
      account: { phoneNumber: e.accountPhone },
    }));
    return { entries: shaped, total: Number(count), mode: 'deduplicated' };
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

  // ---- PLATFORM HEALTH (admin observability) ----
  // Failure-focused aggregate so the platform operator can answer "is the
  // factura pipeline working for my merchants?" without jumping into logs.
  // Per-tenant breakdown, time-windowed, ordered so the merchants most at
  // risk float to the top.
  app.get('/api/admin/platform-health', { preHandler: [requireAdminAuth] }, async (request) => {
    const { windowHours = '24' } = request.query as { windowHours?: string };
    const hours = Math.min(720, Math.max(1, parseInt(windowHours) || 24));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Per-tenant invoice outcomes in the window. We only count rows whose
    // final state is interesting for ops (claimed / rejected / pending /
    // manual_review); 'available' means the CSV row was never consumed,
    // which is not a failure.
    const perTenant = await prisma.$queryRaw<Array<{
      tenant_id: string; tenant_name: string;
      claimed: bigint; rejected: bigint; pending: bigint; manual_review: bigint;
    }>>`
      SELECT
        t.id::text AS tenant_id,
        t.name AS tenant_name,
        COUNT(*) FILTER (WHERE i.status = 'claimed')           AS claimed,
        COUNT(*) FILTER (WHERE i.status = 'rejected')          AS rejected,
        COUNT(*) FILTER (WHERE i.status = 'pending_validation') AS pending,
        COUNT(*) FILTER (WHERE i.status = 'manual_review')     AS manual_review
      FROM tenants t
      LEFT JOIN invoices i ON i.tenant_id = t.id AND i.created_at >= ${since}
      WHERE t.status = 'active'
      GROUP BY t.id, t.name
      ORDER BY t.name ASC
    `;

    const tenants = perTenant.map(r => {
      const total = Number(r.claimed) + Number(r.rejected) + Number(r.pending) + Number(r.manual_review);
      const rejectionRate = total === 0 ? 0 : Number(r.rejected) / total;
      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        total,
        claimed: Number(r.claimed),
        rejected: Number(r.rejected),
        pending: Number(r.pending),
        manualReview: Number(r.manual_review),
        rejectionRate: Number(rejectionRate.toFixed(4)),
      };
    });

    // Platform totals + top rejection reasons. Truncate at 160 chars so a
    // runaway OCR string doesn't blow up the payload.
    const topRejections = await prisma.$queryRaw<Array<{ reason: string; count: bigint }>>`
      SELECT
        COALESCE(NULLIF(SUBSTRING(rejection_reason FROM 1 FOR 160), ''), '(unspecified)') AS reason,
        COUNT(*)::bigint AS count
      FROM invoices
      WHERE created_at >= ${since} AND status = 'rejected'
      GROUP BY reason
      ORDER BY count DESC
      LIMIT 10
    `;

    // Redemption token expiry vs confirmation in the window.
    const [redemptionStats] = await prisma.$queryRaw<[{
      confirmed: bigint; expired: bigint; pending: bigint;
    }]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'used')    AS confirmed,
        COUNT(*) FILTER (WHERE status = 'expired') AS expired,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending
      FROM redemption_tokens
      WHERE created_at >= ${since}
    `;

    // Backlog: invoices sitting in pending_validation or manual_review
    // regardless of window (what's currently stuck, not what landed in the
    // window).
    const [backlog] = await prisma.$queryRaw<[{ pending: bigint; manual_review: bigint }]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending_validation') AS pending,
        COUNT(*) FILTER (WHERE status = 'manual_review')     AS manual_review
      FROM invoices
    `;

    // Hash-chain audit snapshot (cheap — no per-tenant scan here, just a
    // pointer for the operator to run /verify-hash-chain if needed).
    const tenantCount = tenants.length;
    const atRiskTenants = tenants.filter(t => t.total >= 5 && t.rejectionRate >= 0.5);

    const totals = tenants.reduce((acc, t) => {
      acc.total += t.total; acc.claimed += t.claimed; acc.rejected += t.rejected;
      acc.pending += t.pending; acc.manualReview += t.manualReview;
      return acc;
    }, { total: 0, claimed: 0, rejected: 0, pending: 0, manualReview: 0 });
    const platformRejectionRate = totals.total === 0 ? 0 : totals.rejected / totals.total;

    return {
      windowHours: hours,
      since: since.toISOString(),
      activeTenants: tenantCount,
      platform: {
        ...totals,
        rejectionRate: Number(platformRejectionRate.toFixed(4)),
      },
      backlog: {
        pendingValidation: Number(backlog.pending),
        manualReview: Number(backlog.manual_review),
      },
      redemption: {
        confirmed: Number(redemptionStats.confirmed),
        expired: Number(redemptionStats.expired),
        pending: Number(redemptionStats.pending),
      },
      topRejectionReasons: topRejections.map(r => ({ reason: r.reason, count: Number(r.count) })),
      tenants: tenants.sort((a, b) => b.rejectionRate - a.rejectionRate),
      atRiskTenants: atRiskTenants.map(t => ({
        tenantId: t.tenantId, tenantName: t.tenantName,
        rejectionRate: t.rejectionRate, rejected: t.rejected, total: t.total,
      })),
    };
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

  // ---- EXEC DASHBOARD (Admin) ----
  // Aggregates everything Eric needs to eyeball the business health at a glance:
  // platform-wide counters, weekly transaction trend, top merchants by volume,
  // top consumers by LTV (cross-tenant), and a churn list (active merchants with
  // no transactions in the last N days).
  app.get('/api/admin/exec-dashboard', { preHandler: [requireAdminAuth] }, async (request) => {
    const { idleDays = '14', weeks = '8' } = request.query as { idleDays?: string; weeks?: string };
    const idleCutoff = new Date(Date.now() - Math.max(1, parseInt(idleDays)) * 24 * 60 * 60 * 1000);
    const weeksBack = Math.min(52, Math.max(1, parseInt(weeks)));
    const since = new Date(Date.now() - weeksBack * 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgoExec = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Platform-wide scalars (duplicated here so this endpoint is self-contained
    // and doesn't depend on the older /metrics endpoint's scope).
    const activeTenants = await prisma.tenant.count({ where: { status: 'active' } });
    const [shadowCount] = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*)::bigint AS count FROM accounts WHERE account_type = 'shadow'
    `;
    const [verifiedCount] = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*)::bigint AS count FROM accounts WHERE account_type = 'verified'
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
    const validationsLast30 = await prisma.ledgerEntry.count({
      where: {
        eventType: 'INVOICE_CLAIMED',
        entryType: 'CREDIT',
        createdAt: { gte: thirtyDaysAgoExec },
      },
    });

    const [valueIssued] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM ledger_entries
      WHERE event_type = 'INVOICE_CLAIMED' AND entry_type = 'CREDIT' AND status != 'reversed'
    `;
    const [valueRedeemed] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM ledger_entries
      WHERE event_type IN ('REDEMPTION_PENDING', 'REDEMPTION_CONFIRMED')
        AND entry_type = 'DEBIT' AND status != 'reversed'
    `;

    // Weekly transactions (last N weeks) — credits on invoice or presence
    const weeklyTx = await prisma.$queryRaw<Array<{ week: Date; count: bigint; value: string }>>`
      SELECT DATE_TRUNC('week', created_at) AS week,
             COUNT(*)::bigint AS count,
             COALESCE(SUM(amount), 0)::text AS value
      FROM ledger_entries
      WHERE created_at >= ${since}::timestamptz
        AND entry_type = 'CREDIT'
        AND event_type IN ('INVOICE_CLAIMED', 'PRESENCE_VALIDATED')
        AND status != 'reversed'
      GROUP BY week
      ORDER BY week ASC
    `;

    // Top merchants by 30-day volume
    const topMerchants = await prisma.$queryRaw<Array<{
      tenant_id: string; tenant_name: string; tenant_slug: string;
      tx: bigint; value_issued: string; unique_consumers: bigint;
    }>>`
      SELECT t.id::text AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
             COUNT(le.*)::bigint AS tx,
             COALESCE(SUM(le.amount), 0)::text AS value_issued,
             COUNT(DISTINCT le.account_id)::bigint AS unique_consumers
      FROM tenants t
      LEFT JOIN ledger_entries le ON le.tenant_id = t.id
        AND le.entry_type = 'CREDIT'
        AND le.event_type IN ('INVOICE_CLAIMED', 'PRESENCE_VALIDATED')
        AND le.status != 'reversed'
        AND le.created_at >= ${thirtyDaysAgoExec}::timestamptz
      WHERE t.status = 'active'
      GROUP BY t.id, t.name, t.slug
      ORDER BY tx DESC NULLS LAST
      LIMIT 10
    `;

    // Top consumers cross-tenant by lifetime points issued (credits)
    const topConsumers = await prisma.$queryRaw<Array<{
      phone_number: string; display_name: string | null;
      tenants_count: bigint; lifetime_earned: string;
    }>>`
      SELECT a.phone_number, MAX(a.display_name) AS display_name,
             COUNT(DISTINCT a.tenant_id)::bigint AS tenants_count,
             COALESCE(SUM(le.amount), 0)::text AS lifetime_earned
      FROM accounts a
      JOIN ledger_entries le ON le.account_id = a.id
      WHERE a.account_type IN ('shadow', 'verified')
        AND le.entry_type = 'CREDIT'
        AND le.event_type IN ('INVOICE_CLAIMED', 'PRESENCE_VALIDATED', 'ADJUSTMENT_MANUAL')
        AND le.status != 'reversed'
      GROUP BY a.phone_number
      ORDER BY SUM(le.amount) DESC
      LIMIT 10
    `;

    // Churn watch: active tenants whose most recent credit is older than idleCutoff
    const churn = await prisma.$queryRaw<Array<{
      tenant_id: string; tenant_name: string; tenant_slug: string;
      last_tx_at: Date | null; days_idle: number;
    }>>`
      SELECT t.id::text AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
             MAX(le.created_at) AS last_tx_at,
             COALESCE(EXTRACT(EPOCH FROM (NOW() - MAX(le.created_at))) / 86400, 9999)::int AS days_idle
      FROM tenants t
      LEFT JOIN ledger_entries le ON le.tenant_id = t.id
        AND le.entry_type = 'CREDIT'
        AND le.event_type IN ('INVOICE_CLAIMED', 'PRESENCE_VALIDATED')
        AND le.status != 'reversed'
      WHERE t.status = 'active'
      GROUP BY t.id, t.name, t.slug
      HAVING MAX(le.created_at) IS NULL OR MAX(le.created_at) < ${idleCutoff}::timestamptz
      ORDER BY days_idle DESC
    `;

    return {
      activeTenants,
      totalConsumers: Number(shadowCount.count) + Number(verifiedCount.count),
      verifiedConsumers: Number(verifiedCount.count),
      valueIssued: valueIssued.total,
      valueRedeemed: valueRedeemed.total,
      valueInCirculation: totalCirculation.total,
      validationsLast30Days: validationsLast30,
      weeklyTx: weeklyTx.map(r => ({
        week: r.week,
        count: Number(r.count),
        value: r.value,
      })),
      topMerchants: topMerchants.map(r => ({
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        tenantSlug: r.tenant_slug,
        transactions: Number(r.tx),
        valueIssued: r.value_issued,
        uniqueConsumers: Number(r.unique_consumers),
      })),
      topConsumers: topConsumers.map(r => ({
        phoneNumber: r.phone_number,
        displayName: r.display_name,
        tenantsCount: Number(r.tenants_count),
        lifetimeEarned: r.lifetime_earned,
      })),
      churn: churn.map(r => ({
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        tenantSlug: r.tenant_slug,
        lastTxAt: r.last_tx_at,
        daysIdle: Number(r.days_idle),
      })),
      idleThresholdDays: parseInt(idleDays),
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

    const { resolveManualReview } = await import('../../services/reconciliation.js');
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
