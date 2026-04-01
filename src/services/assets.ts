import prisma from '../db/client.js';
import type { AssetType, TenantAssetConfig } from '@prisma/client';

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

export async function convertToLoyaltyValue(
  invoiceAmount: string,
  tenantId: string,
  assetTypeId: string
): Promise<string> {
  const rate = await getConversionRate(tenantId, assetTypeId);
  const value = parseFloat(invoiceAmount) * parseFloat(rate);
  return value.toFixed(8);
}
