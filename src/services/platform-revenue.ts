/**
 * Platform Revenue Service
 *
 * Records the fees Valee earns from each tenant. Three configurable revenue streams:
 *
 * 1. Redemption fee: percentage of every redemption value
 * 2. Attributed sale fee: percentage of every Valee-influenced invoice
 * 3. Attributed customer fee: fixed fee per consumer who returned via Valee outreach
 *
 * Fees are configured per tenant in tenants.redemption_fee_percent,
 * tenants.attributed_sale_fee_percent, tenants.attributed_customer_fixed_fee.
 * Null = no fee for that stream.
 */

import prisma from '../db/client.js';
import type { ReferenceCurrency } from '@prisma/client';

/**
 * Record a redemption fee. Called from the redemption flow after a successful
 * REDEMPTION_CONFIRMED event.
 */
export async function recordRedemptionFee(params: {
  tenantId: string;
  redemptionValue: string;
  ledgerEntryId: string;
}): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: params.tenantId } });
  if (!tenant?.redemptionFeePercent) return;

  const feePercent = Number(tenant.redemptionFeePercent);
  const baseAmount = Number(params.redemptionValue);
  const feeAmount = (baseAmount * feePercent) / 100;
  if (feeAmount <= 0) return;

  await prisma.platformRevenue.create({
    data: {
      tenantId: params.tenantId,
      source: 'redemption_fee',
      amount: feeAmount.toFixed(8),
      currency: tenant.referenceCurrency,
      baseAmount: baseAmount.toFixed(8),
      feePercent: feePercent.toFixed(2),
      ledgerEntryId: params.ledgerEntryId,
      metadata: {
        rule: `${feePercent}% of redemption value`,
      },
    },
  });

  console.log(`[Revenue] Redemption fee recorded: ${feeAmount.toFixed(2)} (${feePercent}% of ${baseAmount})`);
}

/**
 * Record an attributed sale fee. Called from invoice-validation when an
 * INVOICE_CLAIMED is tagged as 'valee_influenced'.
 */
export async function recordAttributedSaleFee(params: {
  tenantId: string;
  invoiceAmount: string;
  ledgerEntryId: string;
  attributionNotificationId?: string;
}): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: params.tenantId } });
  if (!tenant?.attributedSaleFeePercent) return;

  const feePercent = Number(tenant.attributedSaleFeePercent);
  const baseAmount = Number(params.invoiceAmount);
  const feeAmount = (baseAmount * feePercent) / 100;
  if (feeAmount <= 0) return;

  await prisma.platformRevenue.create({
    data: {
      tenantId: params.tenantId,
      source: 'attributed_sale_fee',
      amount: feeAmount.toFixed(8),
      currency: tenant.referenceCurrency,
      baseAmount: baseAmount.toFixed(8),
      feePercent: feePercent.toFixed(2),
      ledgerEntryId: params.ledgerEntryId,
      metadata: {
        rule: `${feePercent}% of attributed invoice amount`,
        attributionNotificationId: params.attributionNotificationId,
      },
    },
  });

  // Also charge the fixed per-customer fee if configured (one-time per attribution)
  if (tenant.attributedCustomerFixedFee && Number(tenant.attributedCustomerFixedFee) > 0) {
    const fixedFee = Number(tenant.attributedCustomerFixedFee);
    await prisma.platformRevenue.create({
      data: {
        tenantId: params.tenantId,
        source: 'attributed_customer_fee',
        amount: fixedFee.toFixed(8),
        currency: tenant.referenceCurrency,
        ledgerEntryId: params.ledgerEntryId,
        metadata: {
          rule: `Fixed fee per attributed customer return`,
          attributionNotificationId: params.attributionNotificationId,
        },
      },
    });
  }

  console.log(`[Revenue] Attributed sale fee recorded: ${feeAmount.toFixed(2)} (${feePercent}% of ${baseAmount})`);
}

/**
 * Aggregate platform revenue for admin dashboard.
 */
export async function getPlatformRevenue(params: {
  tenantId?: string;
  fromDate?: Date;
  toDate?: Date;
}): Promise<{
  total: string;
  byTenant: Array<{ tenantId: string; tenantName: string; total: string }>;
  bySource: Record<string, string>;
  count: number;
}> {
  const fromDate = params.fromDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = params.toDate || new Date();

  const where: any = { createdAt: { gte: fromDate, lte: toDate } };
  if (params.tenantId) where.tenantId = params.tenantId;

  const rows = await prisma.platformRevenue.findMany({
    where,
    select: { tenantId: true, source: true, amount: true },
  });

  const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
  const count = rows.length;

  const bySource: Record<string, number> = {};
  const byTenantMap: Record<string, number> = {};

  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] || 0) + Number(r.amount);
    byTenantMap[r.tenantId] = (byTenantMap[r.tenantId] || 0) + Number(r.amount);
  }

  // Resolve tenant names
  const tenantIds = Object.keys(byTenantMap);
  const tenants = tenantIds.length > 0
    ? await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
    : [];
  const tenantNames = Object.fromEntries(tenants.map(t => [t.id, t.name]));

  const byTenant = Object.entries(byTenantMap).map(([tenantId, amount]) => ({
    tenantId,
    tenantName: tenantNames[tenantId] || 'Unknown',
    total: amount.toFixed(8),
  })).sort((a, b) => Number(b.total) - Number(a.total));

  const bySourceFormatted: Record<string, string> = {};
  for (const [k, v] of Object.entries(bySource)) {
    bySourceFormatted[k] = v.toFixed(8);
  }

  return {
    total: total.toFixed(8),
    byTenant,
    bySource: bySourceFormatted,
    count,
  };
}
