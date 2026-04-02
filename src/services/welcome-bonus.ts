/**
 * Welcome bonus: credits a one-time bonus to new consumer accounts.
 * Amount from WELCOME_BONUS_AMOUNT in .env.
 */

import prisma from '../db/client.js';
import { writeDoubleEntry } from './ledger.js';
import { getSystemAccount } from './accounts.js';

export async function grantWelcomeBonus(
  accountId: string,
  tenantId: string,
  assetTypeId: string
): Promise<{ granted: boolean; amount: string }> {
  const bonusAmount = process.env.WELCOME_BONUS_AMOUNT || '50';

  // Check if already granted
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.welcomeBonusGranted) {
    return { granted: false, amount: '0' };
  }

  // System accounts don't get bonuses
  if (account.accountType === 'system') {
    return { granted: false, amount: '0' };
  }

  const poolAccount = await getSystemAccount(tenantId, 'issued_value_pool');
  if (!poolAccount) {
    return { granted: false, amount: '0' };
  }

  // Credit the bonus via double-entry
  await writeDoubleEntry({
    tenantId,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: poolAccount.id,
    creditAccountId: accountId,
    amount: parseFloat(bonusAmount).toFixed(8),
    assetTypeId,
    referenceId: `WELCOME-${accountId}`,
    referenceType: 'manual_adjustment',
    metadata: { type: 'welcome_bonus', amount: bonusAmount },
  });

  // Mark as granted — never again
  await prisma.account.update({
    where: { id: accountId },
    data: { welcomeBonusGranted: true },
  });

  return { granted: true, amount: parseFloat(bonusAmount).toFixed(8) };
}
