import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/client.js';
import type { LedgerEntry } from '@prisma/client';

// ============================================================
// TYPES
// ============================================================

export interface LedgerWriteParams {
  tenantId: string;
  eventType: 'INVOICE_CLAIMED' | 'REDEMPTION_PENDING' | 'REDEMPTION_CONFIRMED' | 'REDEMPTION_EXPIRED' | 'REVERSAL' | 'ADJUSTMENT_MANUAL' | 'TRANSFER_P2P' | 'PRESENCE_VALIDATED';
  debitAccountId: string;
  creditAccountId: string;
  amount: string;
  assetTypeId: string;
  referenceId: string;
  referenceType: 'invoice' | 'redemption_token' | 'manual_adjustment' | 'transfer' | 'system';
  branchId?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  deviceId?: string | null;
  status?: 'confirmed' | 'provisional' | 'reversed';
  metadata?: Record<string, unknown> | null;
}

// ============================================================
// HASH CHAIN
// ============================================================

function computeHash(
  entryId: string,
  tenantId: string,
  eventType: string,
  entryType: string,
  accountId: string,
  amount: string,
  assetTypeId: string,
  referenceId: string,
  prevHash: string | null
): string {
  const hmacSecret = process.env.HMAC_SECRET;
  if (!hmacSecret) throw new Error('HMAC_SECRET is not configured');

  // Normalize amount to a canonical string so writeDoubleEntry and
  // verifyHashChain agree regardless of what the caller passed in
  // (e.g. "28" at write time vs "28.00000000" when read back from a
  // Prisma Decimal column). Without this, every chain validation failed.
  const canonicalAmount = Number(amount).toFixed(8);

  const payload = [
    entryId, tenantId, eventType, entryType,
    accountId, canonicalAmount, assetTypeId, referenceId,
    prevHash || 'GENESIS',
  ].join('|');

  return createHmac('sha256', hmacSecret).update(payload).digest('hex');
}

// ============================================================
// DOUBLE-ENTRY WRITE
// ============================================================

export async function writeDoubleEntry(params: LedgerWriteParams): Promise<{ debit: LedgerEntry; credit: LedgerEntry }> {
  const debitId = uuidv4();
  const creditId = uuidv4();
  const status = params.status || 'confirmed';
  const metadata = params.metadata || undefined;

  // Use raw transaction for advisory lock + deferred constraints
  const [debit, credit] = await prisma.$transaction(async (tx) => {
    // Advisory lock to prevent concurrent hash chain corruption
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.tenantId}))`;

    // Defer FK constraints so both entries can reference each other
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;

    // Get last hash in tenant's chain
    const lastEntry = await tx.ledgerEntry.findFirst({
      where: { tenantId: params.tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { hash: true },
    });
    const prevHash = lastEntry?.hash || null;

    // Compute hashes
    const debitHash = computeHash(
      debitId, params.tenantId, params.eventType, 'DEBIT',
      params.debitAccountId, params.amount, params.assetTypeId,
      params.referenceId, prevHash
    );
    const creditHash = computeHash(
      creditId, params.tenantId, params.eventType, 'CREDIT',
      params.creditAccountId, params.amount, params.assetTypeId,
      params.referenceId, debitHash
    );

    // Insert DEBIT (paired to CREDIT)
    const debitEntry = await tx.ledgerEntry.create({
      data: {
        id: debitId,
        tenantId: params.tenantId,
        eventType: params.eventType,
        entryType: 'DEBIT',
        accountId: params.debitAccountId,
        pairedEntryId: creditId,
        amount: params.amount,
        assetTypeId: params.assetTypeId,
        referenceId: params.referenceId,
        referenceType: params.referenceType,
        branchId: params.branchId || null,
        latitude: params.latitude || null,
        longitude: params.longitude || null,
        deviceId: params.deviceId || null,
        status,
        prevHash,
        hash: debitHash,
        metadata: metadata as any,
      },
    });

    // Insert CREDIT (paired to DEBIT)
    const creditEntry = await tx.ledgerEntry.create({
      data: {
        id: creditId,
        tenantId: params.tenantId,
        eventType: params.eventType,
        entryType: 'CREDIT',
        accountId: params.creditAccountId,
        pairedEntryId: debitId,
        amount: params.amount,
        assetTypeId: params.assetTypeId,
        referenceId: params.referenceId,
        referenceType: params.referenceType,
        branchId: params.branchId || null,
        latitude: params.latitude || null,
        longitude: params.longitude || null,
        deviceId: params.deviceId || null,
        status,
        prevHash: debitHash,
        hash: creditHash,
        metadata: metadata as any,
      },
    });

    return [debitEntry, creditEntry];
  });

  return { debit, credit };
}

// ============================================================
// BALANCE QUERY
// ============================================================

export async function getAccountBalance(
  accountId: string,
  assetTypeId: string,
  tenantId: string
): Promise<string> {
  const result = await prisma.$queryRaw<[{ balance: string }]>`
    SELECT COALESCE(
      SUM(CASE WHEN entry_type = 'CREDIT' AND status != 'reversed' THEN amount ELSE 0 END) -
      SUM(CASE WHEN entry_type = 'DEBIT' AND status != 'reversed' THEN amount ELSE 0 END),
      0
    )::text AS balance
    FROM ledger_entries
    WHERE account_id = ${accountId}::uuid
      AND asset_type_id = ${assetTypeId}::uuid
      AND tenant_id = ${tenantId}::uuid
  `;

  return result[0].balance;
}

/**
 * Computes a breakdown of an account's balance into confirmed vs provisional.
 * - confirmed: sum of credits/debits where status = 'confirmed'
 * - provisional: net contribution of entries with status = 'provisional' (these are
 *   credits that have been provisionally granted but not yet confirmed by reconciliation)
 * - total: confirmed + provisional (the displayed balance)
 *
 * Reversed entries are excluded from both.
 */
export async function getAccountBalanceBreakdown(
  accountId: string,
  assetTypeId: string,
  tenantId: string
): Promise<{ confirmed: string; provisional: string; total: string }> {
  // REVERSALs land as status='confirmed' with event_type='REVERSAL'. The
  // raw status-bucketed formula used to leave their target amount in the
  // provisional bucket even after they had been reversed, because the
  // original provisional entry can't be updated in an immutable ledger.
  // Consumers saw phantom "X en verificacion" points that had already
  // been reversed (Eric hit this on Kozmo2 after the Bs→EUR fix).
  //
  // Treatment: REVERSALs on this account (debits) come out of the
  // provisional bucket — they're cancelling a previously-provisional
  // credit — and are excluded from the confirmed bucket. The grand total
  // is unchanged; only the split changes.
  const result = await prisma.$queryRaw<[{ confirmed: string; provisional: string }]>`
    SELECT
      COALESCE(
        SUM(CASE
          WHEN status = 'confirmed' AND event_type != 'REVERSAL' AND entry_type = 'CREDIT'
            THEN amount ELSE 0 END) -
        SUM(CASE
          WHEN status = 'confirmed' AND event_type != 'REVERSAL' AND entry_type = 'DEBIT'
            THEN amount ELSE 0 END),
        0
      )::text AS confirmed,
      COALESCE(
        SUM(CASE WHEN status = 'provisional' AND entry_type = 'CREDIT' THEN amount ELSE 0 END) -
        SUM(CASE WHEN status = 'provisional' AND entry_type = 'DEBIT' THEN amount ELSE 0 END) -
        SUM(CASE
          WHEN status = 'confirmed' AND event_type = 'REVERSAL' AND entry_type = 'DEBIT'
            THEN amount ELSE 0 END) +
        SUM(CASE
          WHEN status = 'confirmed' AND event_type = 'REVERSAL' AND entry_type = 'CREDIT'
            THEN amount ELSE 0 END),
        0
      )::text AS provisional
    FROM ledger_entries
    WHERE account_id = ${accountId}::uuid
      AND asset_type_id = ${assetTypeId}::uuid
      AND tenant_id = ${tenantId}::uuid
  `;

  const confirmed = result[0].confirmed;
  const provisional = result[0].provisional;
  const total = (Number(confirmed) + Number(provisional)).toFixed(8);
  return { confirmed, provisional, total };
}

/**
 * Computes an account's balance at a specific point in time.
 * Replays all events up to the given timestamp.
 * This fulfills the event sourcing requirement: any historical state is reconstructable.
 */
export async function getAccountBalanceAtTime(
  accountId: string,
  assetTypeId: string,
  tenantId: string,
  asOf: Date
): Promise<string> {
  const result = await prisma.$queryRaw<[{ balance: string }]>`
    SELECT COALESCE(
      SUM(CASE WHEN entry_type = 'CREDIT' AND status != 'reversed' THEN amount ELSE 0 END) -
      SUM(CASE WHEN entry_type = 'DEBIT' AND status != 'reversed' THEN amount ELSE 0 END),
      0
    )::text AS balance
    FROM ledger_entries
    WHERE account_id = ${accountId}::uuid
      AND asset_type_id = ${assetTypeId}::uuid
      AND tenant_id = ${tenantId}::uuid
      AND created_at <= ${asOf}
  `;

  return result[0].balance;
}

// ============================================================
// HISTORY
// ============================================================

export async function getAccountHistory(
  accountId: string,
  tenantId: string,
  limit: number = 50,
  offset: number = 0
): Promise<LedgerEntry[]> {
  return prisma.ledgerEntry.findMany({
    where: { accountId, tenantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

// ============================================================
// HASH CHAIN VERIFICATION
// ============================================================

export async function verifyHashChain(tenantId: string): Promise<{ valid: boolean; brokenAt?: string }> {
  // Order matters: writeDoubleEntry always writes DEBIT first then CREDIT and
  // chains credit.prevHash = debit.hash. Both rows have the same createdAt
  // (same transaction). Alphabetical "CREDIT" < "DEBIT" is the wrong tiebreak,
  // so we force DEBIT-before-CREDIT with an explicit CASE on the ORDER BY.
  const entries = await prisma.$queryRaw<Array<{
    id: string; tenant_id: string; event_type: string; entry_type: string;
    account_id: string; amount: string; asset_type_id: string;
    reference_id: string; prev_hash: string | null; hash: string;
  }>>`
    SELECT id, tenant_id, event_type, entry_type, account_id,
           amount::text AS amount, asset_type_id, reference_id,
           prev_hash, hash
    FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid
    ORDER BY created_at ASC,
             CASE entry_type WHEN 'DEBIT' THEN 0 ELSE 1 END ASC,
             id ASC
  `;

  let expectedPrevHash: string | null = null;

  for (const row of entries) {
    if (row.prev_hash !== expectedPrevHash) {
      return { valid: false, brokenAt: row.id };
    }

    const recomputed = computeHash(
      row.id, row.tenant_id, row.event_type, row.entry_type,
      row.account_id, row.amount, row.asset_type_id,
      row.reference_id, row.prev_hash
    );

    if (recomputed !== row.hash) {
      return { valid: false, brokenAt: row.id };
    }

    expectedPrevHash = row.hash;
  }

  return { valid: true };
}
