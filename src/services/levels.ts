/**
 * Consumer level system.
 * Level is determined by the count of confirmed INVOICE_CLAIMED events.
 * Thresholds are configurable — for MVP:
 *   Level 1: 0+ claims (default)
 *   Level 2: 5+ claims
 *   Level 3: 15+ claims
 *   Level 4: 30+ claims
 *   Level 5: 50+ claims
 *
 * Called after every successful invoice validation to check for level-up.
 */

import prisma from '../db/client.js';

const LEVEL_THRESHOLDS = [
  { level: 5, minClaims: 50 },
  { level: 4, minClaims: 30 },
  { level: 3, minClaims: 15 },
  { level: 2, minClaims: 5 },
  { level: 1, minClaims: 0 },
];

/**
 * Compute what level a consumer should be at based on their claim history.
 */
export async function computeLevel(accountId: string, tenantId: string): Promise<number> {
  const claimCount = await prisma.ledgerEntry.count({
    where: {
      tenantId,
      accountId,
      eventType: 'INVOICE_CLAIMED',
      entryType: 'CREDIT',
      status: { not: 'reversed' },
    },
  });

  for (const threshold of LEVEL_THRESHOLDS) {
    if (claimCount >= threshold.minClaims) {
      return threshold.level;
    }
  }

  return 1;
}

/**
 * Check and update a consumer's level after a qualifying event.
 * Returns { leveled: true, oldLevel, newLevel } if the level changed.
 */
export async function checkAndUpdateLevel(
  accountId: string,
  tenantId: string
): Promise<{ leveled: boolean; oldLevel: number; newLevel: number }> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.accountType === 'system') {
    return { leveled: false, oldLevel: 0, newLevel: 0 };
  }

  const newLevel = await computeLevel(accountId, tenantId);
  const oldLevel = account.level;

  if (newLevel > oldLevel) {
    await prisma.account.update({
      where: { id: accountId },
      data: { level: newLevel },
    });
    return { leveled: true, oldLevel, newLevel };
  }

  return { leveled: false, oldLevel, newLevel: oldLevel };
}
