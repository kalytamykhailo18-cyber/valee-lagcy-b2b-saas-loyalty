import prisma from '../db/client.js';

export interface MerchantMetrics {
  valueIssued: string;
  valueRedeemed: string;
  netCirculation: string;
  activeConsumers30d: number;
  totalRedemptions: number;
  redemptions30d: number;
}

export async function getMerchantMetrics(tenantId: string, branchId?: string): Promise<MerchantMetrics> {
  const branchFilter = branchId ? `AND branch_id = '${branchId}'::uuid` : '';

  const [valueIssued] = await prisma.$queryRaw<[{ total: string }]>`
    SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid AND event_type = 'INVOICE_CLAIMED' AND entry_type = 'CREDIT' AND status != 'reversed'
  `;

  const [valueRedeemed] = await prisma.$queryRaw<[{ total: string }]>`
    SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid AND event_type = 'REDEMPTION_CONFIRMED' AND entry_type = 'CREDIT' AND status != 'reversed'
  `;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

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

  return {
    valueIssued: valueIssued.total,
    valueRedeemed: valueRedeemed.total,
    netCirculation: (parseFloat(valueIssued.total) - parseFloat(valueRedeemed.total)).toFixed(8),
    activeConsumers30d: Number(activeConsumers.count),
    totalRedemptions,
    redemptions30d,
  };
}

export interface ProductPerformance {
  productId: string;
  name: string;
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
      stock: p.stock,
      redemptionsTotal: totalTokens,
      redemptions30d: recent,
      totalValueRedeemed: totalValue.total,
    });
  }

  return results;
}
