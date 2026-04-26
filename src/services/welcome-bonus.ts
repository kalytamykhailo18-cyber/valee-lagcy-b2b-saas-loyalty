/**
 * Welcome bonus: credits a one-time bonus to new consumer accounts.
 * Amount is per-tenant (tenant.welcomeBonusAmount), fallback to WELCOME_BONUS_AMOUNT in .env.
 */

import prisma from '../db/client.js';
import { writeDoubleEntry } from './ledger.js';
import { getSystemAccount } from './accounts.js';

export async function grantWelcomeBonus(
  accountId: string,
  tenantId: string,
  assetTypeId: string,
  branchId?: string | null,
): Promise<{ granted: boolean; amount: string }> {
  // Check if already granted
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.welcomeBonusGranted) {
    return { granted: false, amount: '0' };
  }

  // System accounts don't get bonuses
  if (account.accountType === 'system') {
    return { granted: false, amount: '0' };
  }

  // Get tenant-specific bonus amount + active toggle + cap (Eric 2026-04-25).
  // Active=false → never grant + bot must not mention it.
  // Limit set → stop granting after the cap is reached.
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant || tenant.welcomeBonusActive === false) {
    return { granted: false, amount: '0' };
  }
  const bonusAmount = tenant.welcomeBonusAmount?.toString()
    || process.env.WELCOME_BONUS_AMOUNT
    || '50';

  if (parseInt(bonusAmount) <= 0) {
    return { granted: false, amount: '0' };
  }

  if (tenant.welcomeBonusLimit != null) {
    const granted = await prisma.ledgerEntry.count({
      where: {
        tenantId,
        eventType: 'ADJUSTMENT_MANUAL',
        entryType: 'CREDIT',
        referenceId: { startsWith: 'WELCOME-' },
      },
    });
    if (granted >= tenant.welcomeBonusLimit) {
      return { granted: false, amount: '0' };
    }
  }

  const poolAccount = await getSystemAccount(tenantId, 'issued_value_pool');
  if (!poolAccount) {
    return { granted: false, amount: '0' };
  }

  // Credit the bonus via double-entry. Stamp branchId when the caller
  // knows one (branch QR scan, cashier-attributed flow). Null means the
  // consumer arrived with no branch context (tenant-wide).
  await writeDoubleEntry({
    tenantId,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: poolAccount.id,
    creditAccountId: accountId,
    amount: parseFloat(bonusAmount).toFixed(8),
    assetTypeId,
    referenceId: `WELCOME-${accountId}`,
    referenceType: 'manual_adjustment',
    branchId: branchId ?? null,
    metadata: { type: 'welcome_bonus', amount: bonusAmount },
  });

  // Mark as granted — never again
  await prisma.account.update({
    where: { id: accountId },
    data: { welcomeBonusGranted: true },
  });

  return { granted: true, amount: parseFloat(bonusAmount).toFixed(8) };
}
