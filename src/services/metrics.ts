import prisma from '../db/client.js';

export interface MerchantMetrics {
  valueIssued: string;
  // Breakdown of valueIssued by source — invoices vs welcome bonuses vs
  // referral bonuses vs manual admin adjustments. Sum equals valueIssued
  // (modulo rounding). Exposed so the merchant sees WHERE emitted points
  // came from. Eric 2026-04-26: surfaced "Referidos" alongside the
  // existing three buckets.
  valueIssuedInvoices: string;
  valueIssuedWelcome: string;
  valueIssuedReferrals: string;
  valueIssuedManual: string;
  valueRedeemed: string;
  netCirculation: string;
  activeConsumers30d: number;
  totalRedemptions: number;
  redemptions30d: number;
  // When the caller asks for the tenant aggregate (no branchId), we also
  // surface the slice that has no branch_id assigned. This lets the dashboard
  // explain why "Todas las sucursales" can be greater than the sum of branch
  // slices: the difference is exactly this unassigned bucket (CSV uploads,
  // WhatsApp invoices, dual-scan, etc. that never got tagged to a branch).
  valueIssuedUnassigned?: string;
  valueRedeemedUnassigned?: string;
}

export async function getMerchantMetrics(tenantId: string, branchId?: string): Promise<MerchantMetrics> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Tenant-global netCirculation (Genesis item 3). Points live at the
  // tenant, not per-branch, so when a branch slice is requested the
  // CIRCULACION tile must still reflect the whole merchant's figure —
  // only EMITIDO and CANJEADO filter per-branch. Compute once up front
  // and reuse across branchless / branched / _unassigned returns.
  const globalNetCirculation = async (): Promise<string> => {
    const [gvi] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(SUM(CASE
        WHEN event_type = 'INVOICE_CLAIMED'   AND entry_type = 'CREDIT' THEN amount
        WHEN event_type = 'REVERSAL'          AND entry_type = 'DEBIT'  THEN -amount
        WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT'
             AND (reference_id LIKE 'WELCOME-%'
                  OR account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId}::uuid AND account_type IN ('shadow','verified')))
          THEN amount
        ELSE 0
      END), 0)::text AS total
      FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid AND status != 'reversed'
    `;
    const [gvr] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid AND event_type = 'REDEMPTION_CONFIRMED'
        AND entry_type = 'CREDIT' AND status != 'reversed'
    `;
    return (parseFloat(gvi.total) - parseFloat(gvr.total)).toFixed(8);
  };

  // Sentinel for "entries without any branch_id assigned"
  if (branchId === '_unassigned') {
    // valueIssued = invoices + welcome + manual admin adjustments.
    // Invoices: INVOICE_CLAIMED credits minus REVERSAL debits. Immutable
    // ledger: reversing a provisional invoice writes a separate REVERSAL
    // event instead of updating the original's status, so summing
    // status!='reversed' INVOICE_CLAIMED credits alone over-counts.
    // Welcome: ADJUSTMENT_MANUAL credits with reference_id starting 'WELCOME-'.
    // Manual: ADJUSTMENT_MANUAL credits to consumer accounts (shadow/verified)
    // that are NOT welcome bonuses — admin manual +adjustments and referrals.
    const [vi] = await prisma.$queryRaw<[{ invoices: string; welcome: string; referrals: string; manual: string }]>`
      SELECT
        COALESCE(SUM(CASE
          WHEN event_type = 'INVOICE_CLAIMED' AND entry_type = 'CREDIT' THEN amount
          WHEN event_type = 'REVERSAL'        AND entry_type = 'DEBIT'  THEN -amount
          ELSE 0
        END), 0)::text AS invoices,
        COALESCE(SUM(CASE
          WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT' AND reference_id LIKE 'WELCOME-%'
          THEN amount ELSE 0
        END), 0)::text AS welcome,
        COALESCE(SUM(CASE
          WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT' AND reference_id LIKE 'REFERRAL-%'
          THEN amount ELSE 0
        END), 0)::text AS referrals,
        COALESCE(SUM(CASE
          WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT'
            AND reference_id NOT LIKE 'WELCOME-%'
            AND reference_id NOT LIKE 'REFERRAL-%'
            AND account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId}::uuid AND account_type IN ('shadow','verified'))
          THEN amount ELSE 0
        END), 0)::text AS manual
      FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid AND status != 'reversed' AND branch_id IS NULL
    `;
    const viTotal = (parseFloat(vi.invoices) + parseFloat(vi.welcome) + parseFloat(vi.referrals) + parseFloat(vi.manual)).toFixed(8);
    const [vr] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid AND event_type = 'REDEMPTION_CONFIRMED'
        AND entry_type = 'CREDIT' AND status != 'reversed'
        AND branch_id IS NULL
    `;
    const [ac] = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(DISTINCT account_id) as count FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid
        AND branch_id IS NULL
        AND account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId}::uuid AND account_type IN ('shadow', 'verified'))
        AND created_at >= ${thirtyDaysAgo}
    `;
    const totalRedemptions = await prisma.ledgerEntry.count({
      where: { tenantId, eventType: 'REDEMPTION_CONFIRMED', entryType: 'CREDIT', branchId: null },
    });
    const redemptions30d = await prisma.ledgerEntry.count({
      where: { tenantId, eventType: 'REDEMPTION_CONFIRMED', entryType: 'CREDIT', branchId: null, createdAt: { gte: thirtyDaysAgo } },
    });
    return {
      valueIssued: viTotal,
      valueIssuedInvoices: vi.invoices,
      valueIssuedWelcome: vi.welcome,
      valueIssuedReferrals: vi.referrals,
      valueIssuedManual: vi.manual,
      valueRedeemed: vr.total,
      netCirculation: await globalNetCirculation(),
      activeConsumers30d: Number(ac.count),
      totalRedemptions,
      redemptions30d,
    };
  }

  // When a branchId is selected, filter all queries to that branch only.
  // branch_id is nullable — entries without a branch are excluded when filtering.
  if (branchId) {
    const [valueIssued] = await prisma.$queryRaw<[{ invoices: string; welcome: string; referrals: string; manual: string }]>`
      SELECT
        COALESCE(SUM(CASE
          WHEN event_type = 'INVOICE_CLAIMED' AND entry_type = 'CREDIT' THEN amount
          WHEN event_type = 'REVERSAL'        AND entry_type = 'DEBIT'  THEN -amount
          ELSE 0
        END), 0)::text AS invoices,
        COALESCE(SUM(CASE
          WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT' AND reference_id LIKE 'WELCOME-%'
          THEN amount ELSE 0
        END), 0)::text AS welcome,
        COALESCE(SUM(CASE
          WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT' AND reference_id LIKE 'REFERRAL-%'
          THEN amount ELSE 0
        END), 0)::text AS referrals,
        COALESCE(SUM(CASE
          WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT'
            AND reference_id NOT LIKE 'WELCOME-%'
            AND reference_id NOT LIKE 'REFERRAL-%'
            AND account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId}::uuid AND account_type IN ('shadow','verified'))
          THEN amount ELSE 0
        END), 0)::text AS manual
      FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid AND status != 'reversed'
        AND branch_id = ${branchId}::uuid
    `;
    const valueIssuedTotal = (parseFloat(valueIssued.invoices) + parseFloat(valueIssued.welcome) + parseFloat(valueIssued.referrals) + parseFloat(valueIssued.manual)).toFixed(8);

    const [valueRedeemed] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid AND event_type = 'REDEMPTION_CONFIRMED'
        AND entry_type = 'CREDIT' AND status != 'reversed'
        AND branch_id = ${branchId}::uuid
    `;

    const [activeConsumers] = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(DISTINCT account_id) as count FROM ledger_entries
      WHERE tenant_id = ${tenantId}::uuid
        AND branch_id = ${branchId}::uuid
        AND account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId}::uuid AND account_type IN ('shadow', 'verified'))
        AND created_at >= ${thirtyDaysAgo}
    `;

    const totalRedemptions = await prisma.ledgerEntry.count({
      where: { tenantId, eventType: 'REDEMPTION_CONFIRMED', entryType: 'CREDIT', branchId },
    });

    const redemptions30d = await prisma.ledgerEntry.count({
      where: { tenantId, eventType: 'REDEMPTION_CONFIRMED', entryType: 'CREDIT', branchId, createdAt: { gte: thirtyDaysAgo } },
    });

    return {
      valueIssued: valueIssuedTotal,
      valueIssuedInvoices: valueIssued.invoices,
      valueIssuedWelcome: valueIssued.welcome,
      valueIssuedReferrals: valueIssued.referrals,
      valueIssuedManual: valueIssued.manual,
      valueRedeemed: valueRedeemed.total,
      netCirculation: await globalNetCirculation(),
      activeConsumers30d: Number(activeConsumers.count),
      totalRedemptions,
      redemptions30d,
    };
  }

  // No branch filter — aggregate all branches
  const [valueIssued] = await prisma.$queryRaw<[{ invoices: string; welcome: string; referrals: string; manual: string }]>`
    SELECT
      COALESCE(SUM(CASE
        WHEN event_type = 'INVOICE_CLAIMED' AND entry_type = 'CREDIT' THEN amount
        WHEN event_type = 'REVERSAL'        AND entry_type = 'DEBIT'  THEN -amount
        ELSE 0
      END), 0)::text AS invoices,
      COALESCE(SUM(CASE
        WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT' AND reference_id LIKE 'WELCOME-%'
        THEN amount ELSE 0
      END), 0)::text AS welcome,
      COALESCE(SUM(CASE
        WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT' AND reference_id LIKE 'REFERRAL-%'
        THEN amount ELSE 0
      END), 0)::text AS referrals,
      COALESCE(SUM(CASE
        WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT'
          AND reference_id NOT LIKE 'WELCOME-%'
          AND reference_id NOT LIKE 'REFERRAL-%'
          AND account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId}::uuid AND account_type IN ('shadow','verified'))
        THEN amount ELSE 0
      END), 0)::text AS manual
    FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid AND status != 'reversed'
  `;
  const valueIssuedTotal = (parseFloat(valueIssued.invoices) + parseFloat(valueIssued.welcome) + parseFloat(valueIssued.referrals) + parseFloat(valueIssued.manual)).toFixed(8);

  const [valueRedeemed] = await prisma.$queryRaw<[{ total: string }]>`
    SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid AND event_type = 'REDEMPTION_CONFIRMED' AND entry_type = 'CREDIT' AND status != 'reversed'
  `;

  const [activeConsumers] = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(DISTINCT account_id) as count FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid
      AND account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId}::uuid AND account_type IN ('shadow', 'verified'))
      AND created_at >= ${thirtyDaysAgo}
  `;

  const totalRedemptions = await prisma.ledgerEntry.count({
    where: { tenantId, eventType: 'REDEMPTION_CONFIRMED', entryType: 'CREDIT' },
  });

  const redemptions30d = await prisma.ledgerEntry.count({
    where: { tenantId, eventType: 'REDEMPTION_CONFIRMED', entryType: 'CREDIT', createdAt: { gte: thirtyDaysAgo } },
  });

  // Also compute the unassigned slice so the dashboard can render it as its
  // own chip. valueIssuedUnassigned + sum(branch.valueIssued) === valueIssued.
  const [valueIssuedUnassignedRow] = await prisma.$queryRaw<[{ invoices: string; welcome: string; referrals: string; manual: string }]>`
    SELECT
      COALESCE(SUM(CASE
        WHEN event_type = 'INVOICE_CLAIMED' AND entry_type = 'CREDIT' THEN amount
        WHEN event_type = 'REVERSAL'        AND entry_type = 'DEBIT'  THEN -amount
        ELSE 0
      END), 0)::text AS invoices,
      COALESCE(SUM(CASE
        WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT' AND reference_id LIKE 'WELCOME-%'
        THEN amount ELSE 0
      END), 0)::text AS welcome,
      COALESCE(SUM(CASE
        WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT' AND reference_id LIKE 'REFERRAL-%'
        THEN amount ELSE 0
      END), 0)::text AS referrals,
      COALESCE(SUM(CASE
        WHEN event_type = 'ADJUSTMENT_MANUAL' AND entry_type = 'CREDIT'
          AND reference_id NOT LIKE 'WELCOME-%'
          AND reference_id NOT LIKE 'REFERRAL-%'
          AND account_id IN (SELECT id FROM accounts WHERE tenant_id = ${tenantId}::uuid AND account_type IN ('shadow','verified'))
        THEN amount ELSE 0
      END), 0)::text AS manual
    FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid AND status != 'reversed' AND branch_id IS NULL
  `;
  const valueIssuedUnassignedTotal = (parseFloat(valueIssuedUnassignedRow.invoices) + parseFloat(valueIssuedUnassignedRow.welcome) + parseFloat(valueIssuedUnassignedRow.referrals) + parseFloat(valueIssuedUnassignedRow.manual)).toFixed(8);
  const [valueRedeemedUnassigned] = await prisma.$queryRaw<[{ total: string }]>`
    SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid AND event_type = 'REDEMPTION_CONFIRMED'
      AND entry_type = 'CREDIT' AND status != 'reversed' AND branch_id IS NULL
  `;

  return {
    valueIssued: valueIssuedTotal,
    valueIssuedInvoices: valueIssued.invoices,
    valueIssuedWelcome: valueIssued.welcome,
    valueIssuedReferrals: valueIssued.referrals,
    valueIssuedManual: valueIssued.manual,
    valueRedeemed: valueRedeemed.total,
    netCirculation: (parseFloat(valueIssuedTotal) - parseFloat(valueRedeemed.total)).toFixed(8),
    activeConsumers30d: Number(activeConsumers.count),
    totalRedemptions,
    redemptions30d,
    valueIssuedUnassigned: valueIssuedUnassignedTotal,
    valueRedeemedUnassigned: valueRedeemedUnassigned.total,
  };
}

export interface ProductPerformance {
  productId: string;
  name: string;
  photoUrl: string | null;
  stock: number;
  redemptionsTotal: number;
  redemptions30d: number;
  totalValueRedeemed: string;
}

export async function getProductPerformance(tenantId: string): Promise<ProductPerformance[]> {
  const products = await prisma.product.findMany({ where: { tenantId } });
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const results: ProductPerformance[] = [];

  for (const p of products) {
    const totalTokens = await prisma.redemptionToken.count({
      where: { tenantId, productId: p.id, status: 'used' },
    });

    const recent = await prisma.redemptionToken.count({
      where: { tenantId, productId: p.id, status: 'used', usedAt: { gte: thirtyDaysAgo } },
    });

    const [totalValue] = await prisma.$queryRaw<[{ total: string }]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM redemption_tokens
      WHERE tenant_id = ${tenantId}::uuid AND product_id = ${p.id}::uuid AND status = 'used'
    `;

    results.push({
      productId: p.id,
      name: p.name,
      photoUrl: p.photoUrl,
      stock: p.stock,
      redemptionsTotal: totalTokens,
      redemptions30d: recent,
      totalValueRedeemed: totalValue.total,
    });
  }

  return results;
}
