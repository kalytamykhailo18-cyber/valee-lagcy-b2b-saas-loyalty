/**
 * Sales Attribution Algorithm
 *
 * When the platform sends a re-engagement message (recurrence reminder, flash
 * offer) to a consumer and that consumer returns and validates an invoice
 * within the attribution window, the resulting transaction is tagged as
 * "valee_influenced" so the merchant can see exactly which sales were caused
 * by Valee's outreach.
 *
 * The window is configurable in .env: ATTRIBUTION_WINDOW_HOURS (default 48).
 */

import prisma from '../db/client.js';

export interface AttributionInfo {
  attributed: boolean;
  notificationId?: string;
  notificationType?: 'recurrence' | 'flash_offer';
  sentAt?: Date;
  windowHours: number;
}

/**
 * Check whether a consumer's incoming invoice should be attributed to a recent
 * Valee outreach. Looks back over `ATTRIBUTION_WINDOW_HOURS` for any
 * recurrence_notifications sent to this consumer.
 *
 * Returns the attribution info, or { attributed: false } if no recent outreach.
 */
export async function checkAttribution(params: {
  tenantId: string;
  consumerAccountId: string;
}): Promise<AttributionInfo> {
  const windowHours = parseInt(process.env.ATTRIBUTION_WINDOW_HOURS || '48');
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  // Most recent recurrence notification within the window
  const notification = await prisma.recurrenceNotification.findFirst({
    where: {
      tenantId: params.tenantId,
      consumerAccountId: params.consumerAccountId,
      sentAt: { gte: since },
    },
    orderBy: { sentAt: 'desc' },
  });

  if (notification) {
    return {
      attributed: true,
      notificationId: notification.id,
      notificationType: 'recurrence',
      sentAt: notification.sentAt,
      windowHours,
    };
  }

  // Future: also check flash_offer_sends table when that feature ships

  return { attributed: false, windowHours };
}

/**
 * Aggregate ROI metrics for a tenant: how many of their recent sales were
 * directly caused by Valee's outreach, and what value those sales generated.
 */
export async function getAttributionRoi(params: {
  tenantId: string;
  fromDate?: Date;
  toDate?: Date;
}): Promise<{
  totalInvoicesClaimed: number;
  attributedInvoices: number;
  attributedValueIssued: string;
  attributionRate: number;
  windowHours: number;
}> {
  const fromDate = params.fromDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = params.toDate || new Date();
  const windowHours = parseInt(process.env.ATTRIBUTION_WINDOW_HOURS || '48');

  // Count INVOICE_CLAIMED ledger entries in the period
  const totalRow = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count
    FROM ledger_entries
    WHERE tenant_id = ${params.tenantId}::uuid
      AND event_type = 'INVOICE_CLAIMED'
      AND entry_type = 'CREDIT'
      AND created_at >= ${fromDate}
      AND created_at <= ${toDate}
  `;
  const totalInvoicesClaimed = Number(totalRow[0].count);

  // Count attributed entries (those with metadata.attribution = 'valee_influenced')
  const attributedRow = await prisma.$queryRaw<[{ count: bigint; total: string | null }]>`
    SELECT
      COUNT(*)::bigint AS count,
      COALESCE(SUM(amount), 0)::text AS total
    FROM ledger_entries
    WHERE tenant_id = ${params.tenantId}::uuid
      AND event_type = 'INVOICE_CLAIMED'
      AND entry_type = 'CREDIT'
      AND metadata->>'attribution' = 'valee_influenced'
      AND created_at >= ${fromDate}
      AND created_at <= ${toDate}
  `;
  const attributedInvoices = Number(attributedRow[0].count);
  const attributedValueIssued = attributedRow[0].total || '0';

  return {
    totalInvoicesClaimed,
    attributedInvoices,
    attributedValueIssued,
    attributionRate: totalInvoicesClaimed > 0 ? Math.round((attributedInvoices / totalInvoicesClaimed) * 100) : 0,
    windowHours,
  };
}
