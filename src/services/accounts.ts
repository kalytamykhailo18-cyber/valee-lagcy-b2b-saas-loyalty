import prisma from '../db/client.js';
import type { Account } from '@prisma/client';

/**
 * Normalize a Venezuelan phone number to canonical E.164 form: "+58XXXXXXXXXX".
 *
 * Accepts any of:
 *   "04140446569"      (local with leading 0)
 *   "4140446569"       (local without 0)
 *   "584140446569"     (digits with country code, no +)
 *   "+584140446569"    (canonical)
 *   "+58 414 044 65 69" (with separators)
 *
 * Returns the canonical "+58XXXXXXXXXX" string. If the input is too short
 * or clearly not Venezuelan, returns whatever the user typed (digits-only,
 * with + prefix when there are 11+ digits) so non-VE numbers still work.
 */
export function normalizeVenezuelanPhone(input: string): string {
  if (!input) return input;
  const digits = input.replace(/\D/g, '');

  // If input explicitly starts with + and a country code, trust it
  const trimmed = input.trim();
  if (trimmed.startsWith('+') && digits.length >= 10) {
    return '+' + digits;
  }

  // Already 12 digits with country code 58 → canonical VE
  if (digits.length === 12 && digits.startsWith('58')) {
    return '+' + digits;
  }
  // 11 digits starting with 1 → US/Canada number
  if (digits.length === 11 && digits.startsWith('1')) {
    return '+' + digits;
  }
  // 11 digits with leading 0 (Venezuelan local format) → strip 0, prepend 58
  if (digits.length === 11 && digits.startsWith('0')) {
    return '+58' + digits.slice(1);
  }
  // 10 digits starting with 4 → Venezuelan mobile (04XX), prepend 58
  if (digits.length === 10 && digits.startsWith('4')) {
    return '+58' + digits;
  }
  // 10 digits not starting with 4 → could be US without country code, prepend 1
  if (digits.length === 10 && !digits.startsWith('4')) {
    return '+1' + digits;
  }
  // Unknown format → return with + if it has at least 10 digits, else as-is
  if (digits.length >= 10) return '+' + digits;
  return input;
}

/**
 * Returns the last 10 digits of any phone string. Used as a robust matching key
 * across format variations (e.g. "04140446569" and "+584140446569" both end in
 * "4140446569").
 */
export function phoneTail(input: string): string {
  return (input || '').replace(/\D/g, '').slice(-10);
}

export async function findOrCreateConsumerAccount(
  tenantId: string,
  phoneNumber: string,
  displayName?: string | null
): Promise<{ account: Account; created: boolean }> {
  const canonical = normalizeVenezuelanPhone(phoneNumber);
  const tail = phoneTail(canonical);

  // First try exact match on canonical
  let existing = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId, phoneNumber: canonical } },
  });

  // Fallback: any record for this tenant whose tail matches (handles legacy
  // accounts stored in non-canonical formats)
  if (!existing && tail.length === 10) {
    existing = await prisma.account.findFirst({
      where: { tenantId, phoneNumber: { endsWith: tail } },
    });
  }

  if (existing) {
    // Update display name if we have one now but didn't before
    if (displayName && !existing.displayName) {
      await prisma.account.update({
        where: { id: existing.id },
        data: { displayName },
      });
      existing = { ...existing, displayName };
    }
    return { account: existing, created: false };
  }

  const account = await prisma.account.create({
    data: { tenantId, phoneNumber: canonical, accountType: 'shadow', displayName: displayName || null },
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
