import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { writeDoubleEntry, verifyHashChain, getAccountBalance } from '../../../services/ledger.js';
import { requireAdminAuth } from './_middleware.js';

export async function registerLedgerRoutes(app: FastifyInstance): Promise<void> {
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
}
