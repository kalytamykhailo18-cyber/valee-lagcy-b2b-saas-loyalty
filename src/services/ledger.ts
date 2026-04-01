import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/client.js';
import type { LedgerEntry } from '@prisma/client';

// ============================================================
// TYPES
// ============================================================

export interface LedgerWriteParams {
  tenantId: string;
  eventType: 'INVOICE_CLAIMED' | 'REDEMPTION_PENDING' | 'REDEMPTION_CONFIRMED' | 'REDEMPTION_EXPIRED' | 'REVERSAL' | 'ADJUSTMENT_MANUAL' | 'TRANSFER_P2P';
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

  const payload = [
    entryId, tenantId, eventType, entryType,
    accountId, amount, assetTypeId, referenceId,
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
  const entries = await prisma.ledgerEntry.findMany({
    where: { tenantId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, tenantId: true, eventType: true, entryType: true,
      accountId: true, amount: true, assetTypeId: true,
      referenceId: true, prevHash: true, hash: true,
    },
  });

  let expectedPrevHash: string | null = null;

  for (const row of entries) {
    if (row.prevHash !== expectedPrevHash) {
      return { valid: false, brokenAt: row.id };
    }

    const recomputed = computeHash(
      row.id, row.tenantId, row.eventType, row.entryType,
      row.accountId, Number(row.amount).toFixed(8), row.assetTypeId,
      row.referenceId, row.prevHash
    );

    if (recomputed !== row.hash) {
      return { valid: false, brokenAt: row.id };
    }

    expectedPrevHash = row.hash;
  }

  return { valid: true };
}
