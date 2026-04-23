import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  // ---- DASHBOARD ANALYTICS (Owner only) ----
  app.get('/api/merchant/analytics', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;

    // valueIssued = INVOICE_CLAIMED credits − REVERSAL debits so Eric's
    // 'Emitido' metric doesn't double-count a factura that was later
    // reversed (the ledger is immutable, so status stays 'provisional'
    // on the original credit even after reversal).
    const [valueIssued] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(SUM(CASE
        WHEN event_type = 'INVOICE_CLAIMED' AND entry_type = 'CREDIT' THEN amount
        WHEN event_type = 'REVERSAL'        AND entry_type = 'DEBIT'  THEN -amount
        ELSE 0
      END), 0)::text AS total FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid AND status != 'reversed'
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

  // ---- MERCHANT METRICS (Owner only) — enhanced with branch filtering ----
  app.get('/api/merchant/metrics', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { branchId } = request.query as { branchId?: string };

    const { getMerchantMetrics } = await import('../../../services/metrics.js');
    const metrics = await getMerchantMetrics(tenantId, branchId || undefined);

    // Surface rifMissing so the dashboard can render a banner asking the
    // owner to finish setting their RIF. Without it, fiscal invoices get
    // rejected by the validation pipeline (Genesis M1).
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { rif: true } });
    return {
      ...metrics,
      rifMissing: !tenant?.rif,
    };
  });

  // ---- PRODUCT PERFORMANCE (Owner only) ----
  app.get('/api/merchant/product-performance', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;

    const { getProductPerformance } = await import('../../../services/metrics.js');
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

    // Collapse REDEMPTION_PENDING + REDEMPTION_CONFIRMED into a single row
    // per token so the merchant doesn't see "Canje pendiente -125" AND "Canje
    // confirmado +125" for the same redemption (Genesis M8). Reference IDs
    // are REDEEM-<tokenId> for the pending side and CONFIRMED-<tokenId> for
    // the confirmed side — same tokenId ties them. Keep the PENDING row
    // (it still holds the consumer account so phone/name render correctly)
    // but relabel it as REDEMPTION_CONFIRMED when a CONFIRMED exists in this
    // result window for the same token. Hide the system-side CONFIRMED row.
    // Build a map from ledger entry reference -> tokenId so the collapse
    // can group both halves of a redemption (PENDING leg + CONFIRMED /
    // EXPIRED leg) under a single key.
    //
    // Two sources of tokenId:
    //   1. Refs that directly encode the uuid (CONFIRMED-<uuid>,
    //      EXPIRED-<uuid>, and REDEEM-<uuid> for new redemptions where
    //      redemption.ts now reuses the token uuid for the ledger ref).
    //   2. Old redemptions where REDEEM-<throwaway> used a different uuid
    //      than the token. Those rows still link to the correct token via
    //      redemption_tokens.ledgerPendingEntryId. Bridging through that
    //      relation keeps historical data groupable (Genesis QA item 5/8).
    const tokenIdByRef = new Map<string, string>();
    const confirmedTokenIds = new Set<string>();
    const expiredTokenIds = new Set<string>();
    const pendingLedgerIds: string[] = [];
    for (const e of entries) {
      const ref = String(e.reference_id || '');
      const m = ref.match(/^(REDEEM|CONFIRMED|EXPIRED)-([0-9a-f-]{36})$/i);
      if (m) {
        tokenIdByRef.set(ref, m[2]);
        if (m[1].toUpperCase() === 'CONFIRMED') confirmedTokenIds.add(m[2]);
        if (m[1].toUpperCase() === 'EXPIRED')   expiredTokenIds.add(m[2]);
        if (m[1].toUpperCase() === 'REDEEM')    pendingLedgerIds.push(e.id);
      }
    }
    // Bridge old REDEEM-<throwaway> refs to their token via the
    // ledgerPendingEntryId relation, and pull token.status for all tokens.
    if (pendingLedgerIds.length > 0) {
      const bridges = await prisma.redemptionToken.findMany({
        where: { ledgerPendingEntryId: { in: pendingLedgerIds } },
        select: { id: true, status: true, ledgerPendingEntryId: true },
      });
      const pendingEntryIdToToken = new Map<string, { id: string; status: string }>();
      for (const b of bridges) {
        pendingEntryIdToToken.set(b.ledgerPendingEntryId, { id: b.id, status: b.status });
        if (b.status === 'used')    confirmedTokenIds.add(b.id);
        if (b.status === 'expired') expiredTokenIds.add(b.id);
      }
      // Now rewrite the tokenIdByRef for PENDING entries whose ref UUID
      // doesn't match the token uuid — bridge it back through the pending
      // entry id relation.
      for (const e of entries) {
        const ref = String(e.reference_id || '');
        const m = ref.match(/^REDEEM-[0-9a-f-]{36}$/i);
        if (!m) continue;
        const token = pendingEntryIdToToken.get(e.id);
        if (token) tokenIdByRef.set(ref, token.id);
      }
    }
    // Finally pull status for any tokenIds we got purely through ref parsing
    // (e.g. CONFIRMED-<uuid> on page 1 without the PENDING leg present).
    const collapseTokenIds = Array.from(new Set(tokenIdByRef.values()));
    if (collapseTokenIds.length > 0) {
      const statusRows = await prisma.redemptionToken.findMany({
        where: { id: { in: collapseTokenIds } },
        select: { id: true, status: true },
      });
      for (const r of statusRows) {
        if (r.status === 'used')    confirmedTokenIds.add(r.id);
        if (r.status === 'expired') expiredTokenIds.add(r.id);
      }
    }

    // Effective status for INVOICE_CLAIMED rows: a row stays raw
    // status='provisional' in the ledger (it's immutable), but if the
    // linked invoice has since been reconciled to status='claimed' via
    // CSV, the consumer + merchant UI should show it as confirmed. Eric
    // flagged this on 2026-04-22: his CSV page correctly labeled rows
    // Canjeada while the dashboard movimientos kept saying Provisional.
    // Mirror the same derivation already used in consumer history and
    // the balance breakdown.
    const pendingInvoiceNumbers = new Set<string>();
    for (const e of entries) {
      if (e.event_type !== 'INVOICE_CLAIMED' || e.status !== 'provisional') continue;
      const ref = String(e.reference_id || '');
      if (ref.startsWith('PENDING-')) pendingInvoiceNumbers.add(ref.slice('PENDING-'.length));
    }
    const claimedInvoices = pendingInvoiceNumbers.size > 0
      ? await prisma.invoice.findMany({
          where: { tenantId, invoiceNumber: { in: Array.from(pendingInvoiceNumbers) }, status: 'claimed' },
          select: { invoiceNumber: true },
        })
      : [];
    const claimedInvoiceNumbers = new Set(claimedInvoices.map(i => i.invoiceNumber));

    return {
      entries: entries
        .filter(e => {
          const tid = tokenIdByRef.get(String(e.reference_id || ''));
          if (!tid) return true;
          // Hide both legs of an expired-only redemption (consumer got
          // points back, no net movement — don't pollute the merchant log).
          if (expiredTokenIds.has(tid) && !confirmedTokenIds.has(tid)) return false;
          if (e.event_type === 'REDEMPTION_CONFIRMED' && confirmedTokenIds.has(tid)) return false;
          if (e.event_type === 'REDEMPTION_EXPIRED'   && e.entry_type === 'CREDIT')  return false;
          return true;
        })
        .map(e => {
          const meta: any = e.metadata || {};
          const tid = tokenIdByRef.get(String(e.reference_id || ''));
          // Welcome bonus is written as ADJUSTMENT_MANUAL with a WELCOME-
          // prefixed referenceId. The consumer history endpoint already
          // emits WELCOME_BONUS as a virtual event type for the same rows;
          // do the same here so the merchant dashboard labels them
          // 'Puntos de Bienvenida' instead of the generic 'Ajuste manual'
          // (Genesis L3).
          let effectiveEventType: string =
            e.event_type === 'ADJUSTMENT_MANUAL'
            && (String(e.reference_id || '').startsWith('WELCOME-')
                || meta?.type === 'welcome_bonus')
              ? 'WELCOME_BONUS'
              : e.event_type;
          // Relabel surviving PENDING to CONFIRMED when confirmation landed.
          if (tid && e.event_type === 'REDEMPTION_PENDING' && confirmedTokenIds.has(tid)) {
            effectiveEventType = 'REDEMPTION_CONFIRMED';
          }
          const ref = String(e.reference_id || '');
          const isReconciled = e.event_type === 'INVOICE_CLAIMED'
            && e.status === 'provisional'
            && ref.startsWith('PENDING-')
            && claimedInvoiceNumbers.has(ref.slice('PENDING-'.length));
          const effectiveStatus = isReconciled ? 'confirmed' : e.status;
          return {
            id: e.id,
            eventType: effectiveEventType,
            entryType: e.entry_type,
            amount: e.amount,
            status: effectiveStatus,
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
