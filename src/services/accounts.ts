import prisma from '../db/client.js';
import type { Account } from '@prisma/client';

export async function findOrCreateConsumerAccount(
  tenantId: string,
  phoneNumber: string
): Promise<{ account: Account; created: boolean }> {
  const existing = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId, phoneNumber } },
  });

  if (existing) {
    return { account: existing, created: false };
  }

  const account = await prisma.account.create({
    data: { tenantId, phoneNumber, accountType: 'shadow' },
  });

  return { account, created: true };
}

export async function createSystemAccounts(tenantId: string): Promise<{ pool: Account; holding: Account }> {
  const pool = await prisma.account.upsert({
    where: { tenantId_systemAccountType: { tenantId, systemAccountType: 'issued_value_pool' } },
    update: {},
    create: { tenantId, accountType: 'system', systemAccountType: 'issued_value_pool' },
  });

  const holding = await prisma.account.upsert({
    where: { tenantId_systemAccountType: { tenantId, systemAccountType: 'redemption_holding' } },
    update: {},
    create: { tenantId, accountType: 'system', systemAccountType: 'redemption_holding' },
  });

  return { pool, holding };
}

export async function getSystemAccount(
  tenantId: string,
  systemType: 'issued_value_pool' | 'redemption_holding'
): Promise<Account | null> {
  return prisma.account.findUnique({
    where: { tenantId_systemAccountType: { tenantId, systemAccountType: systemType } },
  });
}

export async function getAccountByPhone(
  tenantId: string,
  phoneNumber: string
): Promise<Account | null> {
  return prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId, phoneNumber } },
  });
}

export async function upgradeToVerified(
  accountId: string,
  tenantId: string,
  cedula: string
): Promise<Account> {
  return prisma.account.update({
    where: { id: accountId, tenantId },
    data: { accountType: 'verified', cedula },
  });
}
