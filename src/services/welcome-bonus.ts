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
      // Eric 2026-05-05: if the limit was already exhausted before this
      // call (e.g. tenant lowered the limit retroactively, or this is a
      // late scanner contact firing after the cap closed), make sure the
      // toggle reflects reality and flip it off too. Without this, the
      // toggle could stay visually ON while every grant attempt silently
      // returns "no grant" — the merchant has no signal that the bono is
      // already paused.
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { welcomeBonusActive: false },
      });
      console.log(`[WelcomeBonus] Cap already reached for tenant=${tenantId} (${granted}/${tenant.welcomeBonusLimit}) — auto-disabled welcomeBonusActive`);
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

  // Eric 2026-05-05 (Notion "Puntos de bienvenida priorida mvp"): when the
  // grant we just wrote exhausts the merchant's limit, automatically turn
  // the bono OFF. Without this, "Restante: 0" shows in the metrics card
  // but the toggle button stays visually ON, which confuses the merchant
  // (the bot already stops mentioning the bono — but the toggle is the
  // single most-watched control on this page). If they want to restart,
  // they raise the limit and flip the toggle back manually.
  if (tenant.welcomeBonusLimit != null) {
    const grantedAfter = await prisma.ledgerEntry.count({
      where: {
        tenantId,
        eventType: 'ADJUSTMENT_MANUAL',
        entryType: 'CREDIT',
        referenceId: { startsWith: 'WELCOME-' },
      },
    });
    if (grantedAfter >= tenant.welcomeBonusLimit) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { welcomeBonusActive: false },
      });
      console.log(`[WelcomeBonus] Cap reached for tenant=${tenantId} (${grantedAfter}/${tenant.welcomeBonusLimit}) — auto-disabled welcomeBonusActive`);
    }
  }

  return { granted: true, amount: parseFloat(bonusAmount).toFixed(8) };
}
