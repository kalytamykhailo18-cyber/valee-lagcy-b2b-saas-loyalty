import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireAdminAuth } from './_middleware.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
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
}
