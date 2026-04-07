/**
 * Dual-Scan Transaction Service
 *
 * For merchants who do NOT issue fiscal invoices. The cashier generates a
 * short-lived HMAC-signed QR with the transaction amount. The customer scans
 * it from the consumer PWA/WhatsApp. The system records a PRESENCE_VALIDATED
 * ledger event tying cashier + customer + amount + branch + timestamp.
 *
 * Anti-fraud rules:
 * - Only authenticated cashiers can initiate
 * - Short TTL (default 60 seconds, configurable per tenant)
 * - Daily cap per cashier (default 50)
 * - Daily cap per consumer (default 5)
 * - Token can only be used once (idempotency via reference_id)
 */

import crypto from 'crypto';
import prisma from '../db/client.js';
import { writeDoubleEntry, getAccountBalance } from './ledger.js';
import { findOrCreateConsumerAccount, getSystemAccount } from './accounts.js';
import { convertToLoyaltyValue } from './assets.js';

interface DualScanPayload {
  tenantId: string;
  branchId: string | null;
  cashierId: string;
  amount: string;
  assetTypeId: string;
  expiresAt: number; // Unix ms
  nonce: string;
}

function getSecret(): string {
  const secret = process.env.HMAC_SECRET;
  if (!secret) throw new Error('HMAC_SECRET not configured in .env');
  return secret;
}

function signPayload(payload: DualScanPayload): string {
  const json = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', getSecret()).update(json).digest('hex');
  const token = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
  return token;
}

function verifyToken(token: string): { valid: boolean; payload?: DualScanPayload; error?: string } {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    const { payload, signature } = decoded;
    if (!payload || !signature) return { valid: false, error: 'Token mal formado' };
    const expected = crypto.createHmac('sha256', getSecret()).update(JSON.stringify(payload)).digest('hex');
    if (expected !== signature) return { valid: false, error: 'Firma invalida' };
    if (Date.now() > payload.expiresAt) return { valid: false, error: 'QR expirado' };
    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: 'Token invalido' };
  }
}

/**
 * Cashier initiates a dual-scan: generates a token QR for the customer to scan.
 * Enforces the per-cashier daily cap.
 */
export async function initiateDualScan(params: {
  tenantId: string;
  cashierId: string;
  branchId: string | null;
  amount: string;
  assetTypeId: string;
}): Promise<{ success: boolean; token?: string; expiresAt?: number; error?: string }> {
  const tenant = await prisma.tenant.findUnique({ where: { id: params.tenantId } });
  if (!tenant) return { success: false, error: 'Tenant no encontrado' };

  const ttlSeconds = tenant.dualScanTtlSeconds;
  const dailyCap = tenant.dualScanCapPerCashier;

  // Cap check: count PRESENCE_VALIDATED events initiated by this cashier in the last 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dailyCount = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count
    FROM ledger_entries
    WHERE tenant_id = ${params.tenantId}::uuid
      AND event_type = 'PRESENCE_VALIDATED'
      AND created_at >= ${since}
      AND metadata->>'cashierId' = ${params.cashierId}
  `;

  if (Number(dailyCount[0].count) >= dailyCap) {
    return { success: false, error: `Limite diario alcanzado (${dailyCap} transacciones por cajero)` };
  }

  // Validate amount
  const amountNum = parseFloat(params.amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return { success: false, error: 'Monto invalido' };
  }

  const expiresAt = Date.now() + ttlSeconds * 1000;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload: DualScanPayload = {
    tenantId: params.tenantId,
    branchId: params.branchId,
    cashierId: params.cashierId,
    amount: params.amount,
    assetTypeId: params.assetTypeId,
    expiresAt,
    nonce,
  };

  const token = signPayload(payload);
  return { success: true, token, expiresAt };
}

/**
 * Consumer confirms a dual-scan by submitting the token.
 * Verifies HMAC, checks TTL, checks per-consumer daily cap, then creates the
 * PRESENCE_VALIDATED ledger event.
 */
export async function confirmDualScan(params: {
  token: string;
  consumerPhone: string;
}): Promise<{
  success: boolean;
  message: string;
  valueAssigned?: string;
  newBalance?: string;
  branchId?: string | null;
}> {
  const verification = verifyToken(params.token);
  if (!verification.valid || !verification.payload) {
    return { success: false, message: verification.error || 'Token invalido' };
  }

  const payload = verification.payload;
  const tenant = await prisma.tenant.findUnique({ where: { id: payload.tenantId } });
  if (!tenant) return { success: false, message: 'Comercio no encontrado' };

  // Find or create the consumer account
  const { account: consumerAccount } = await findOrCreateConsumerAccount(payload.tenantId, params.consumerPhone);

  // Cap check: count PRESENCE_VALIDATED for this consumer in the last 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const consumerDailyCount = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count
    FROM ledger_entries
    WHERE tenant_id = ${payload.tenantId}::uuid
      AND account_id = ${consumerAccount.id}::uuid
      AND event_type = 'PRESENCE_VALIDATED'
      AND created_at >= ${since}
  `;
  if (Number(consumerDailyCount[0].count) >= tenant.dualScanCapPerConsumer) {
    return { success: false, message: `Limite diario alcanzado (${tenant.dualScanCapPerConsumer} escaneos por dia)` };
  }

  // Idempotency: the nonce uniquely identifies this token. Use it as reference_id.
  const referenceId = `DUALSCAN-${payload.nonce}`;
  const existingEntry = await prisma.ledgerEntry.findFirst({
    where: { tenantId: payload.tenantId, referenceId },
  });
  if (existingEntry) {
    return { success: false, message: 'Este QR ya fue usado' };
  }

  // Calculate loyalty value (apply BS normalization if tenant uses it)
  let normalizedAmount = payload.amount;
  if (tenant.preferredExchangeSource) {
    const { convertBsToReference } = await import('./exchange-rates.js');
    const converted = await convertBsToReference(
      Number(payload.amount),
      tenant.preferredExchangeSource,
      tenant.referenceCurrency,
      new Date(),
    );
    if (converted !== null) normalizedAmount = converted.toFixed(8);
  }
  const loyaltyValue = await convertToLoyaltyValue(normalizedAmount, payload.tenantId, payload.assetTypeId);

  const poolAccount = await getSystemAccount(payload.tenantId, 'issued_value_pool');
  if (!poolAccount) return { success: false, message: 'Cuenta del comercio no configurada' };

  // Write the PRESENCE_VALIDATED double-entry
  await writeDoubleEntry({
    tenantId: payload.tenantId,
    eventType: 'PRESENCE_VALIDATED',
    debitAccountId: poolAccount.id,
    creditAccountId: consumerAccount.id,
    amount: loyaltyValue,
    assetTypeId: payload.assetTypeId,
    referenceId,
    referenceType: 'invoice',
    branchId: payload.branchId,
    metadata: {
      source: 'dual_scan',
      cashierId: payload.cashierId,
      originalAmount: payload.amount,
      nonce: payload.nonce,
    },
  });

  const newBalance = await getAccountBalance(consumerAccount.id, payload.assetTypeId, payload.tenantId);

  return {
    success: true,
    message: `Recibimos tu visita. Ganaste ${parseFloat(loyaltyValue).toLocaleString()} puntos. Tu saldo: ${parseFloat(newBalance).toLocaleString()} puntos.`,
    valueAssigned: loyaltyValue,
    newBalance,
    branchId: payload.branchId,
  };
}
