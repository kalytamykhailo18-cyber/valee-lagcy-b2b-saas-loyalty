import prisma from '../db/client.js';
import type { AssetType, TenantAssetConfig } from '@prisma/client';
import { convertBsToReference } from './exchange-rates.js';

export async function createAssetType(
  name: string,
  unitLabel: string,
  defaultConversionRate: string
): Promise<AssetType> {
  return prisma.assetType.create({
    data: { name, unitLabel, defaultConversionRate },
  });
}

export async function getAssetTypeById(id: string): Promise<AssetType | null> {
  return prisma.assetType.findUnique({ where: { id } });
}

export async function listAssetTypes(): Promise<AssetType[]> {
  return prisma.assetType.findMany({ orderBy: { name: 'asc' } });
}

export async function setTenantConversionRate(
  tenantId: string,
  assetTypeId: string,
  conversionRate: string
): Promise<TenantAssetConfig> {
  return prisma.tenantAssetConfig.upsert({
    where: { tenantId_assetTypeId: { tenantId, assetTypeId } },
    update: { conversionRate },
    create: { tenantId, assetTypeId, conversionRate },
  });
}

export async function getConversionRate(
  tenantId: string,
  assetTypeId: string
): Promise<string> {
  const override = await prisma.tenantAssetConfig.findUnique({
    where: { tenantId_assetTypeId: { tenantId, assetTypeId } },
  });

  if (override) {
    return override.conversionRate.toString();
  }

  const assetType = await prisma.assetType.findUnique({ where: { id: assetTypeId } });
  if (!assetType) throw new Error(`Asset type ${assetTypeId} not found`);

  return assetType.defaultConversionRate.toString();
}

/**
 * Convert an invoice amount into loyalty points.
 *
 * `amountCurrency` tells this function whether the incoming amount is already
 * in the tenant's reference currency (USD/EUR — callers that did their own
 * BS→ref normalization upstream) or still in Bs and needs to be normalized
 * using the tenant's configured exchange source + transaction date.
 *
 * Bug Eric hit: CSV upload + dual-scan were passing raw Bs amounts but this
 * function was multiplying them directly by the points-per-unit rate, giving
 * absurd totals. Now: raw Bs → ref currency via exchange rate → points.
 */
export async function convertToLoyaltyValue(
  invoiceAmount: string,
  tenantId: string,
  assetTypeId: string,
  transactionDate?: Date,
  amountCurrency: 'bs' | 'reference' = 'reference',
): Promise<string> {
  const rate = await getConversionRate(tenantId, assetTypeId);

  let amountInReference = parseFloat(invoiceAmount);

  if (amountCurrency === 'bs') {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { preferredExchangeSource: true, referenceCurrency: true },
    });
    if (tenant?.preferredExchangeSource && tenant.referenceCurrency) {
      const normalized = await convertBsToReference(
        amountInReference,
        tenant.preferredExchangeSource,
        tenant.referenceCurrency,
        transactionDate,
      );
      if (normalized != null) amountInReference = normalized;
    }
  }

  const value = amountInReference * parseFloat(rate);
  // Round to whole numbers — cleaner for consumers, avoids confusing decimals.
  // Minimum 1 point: the ledger has a chk_ledger_amount_positive constraint
  // that rejects zero-value entries. Any positive invoice earns at least 1 pt.
  const rounded = Math.round(value);
  return Math.max(1, rounded).toFixed(0);
}
