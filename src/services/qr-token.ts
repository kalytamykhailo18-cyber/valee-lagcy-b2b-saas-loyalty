import { createHmac } from 'crypto';
import prisma from '../db/client.js';

export interface QRTokenPayload {
  ledgerEntryId: string;
  consumerAccountId: string;
  valueAssigned: string;
  tenantId: string;
  timestamp: string;
}

export interface QRToken {
  payload: QRTokenPayload;
  signature: string;
  token: string;
}

export function generateOutputToken(
  ledgerEntryId: string,
  consumerAccountId: string,
  valueAssigned: string,
  tenantId: string
): QRToken {
  const hmacSecret = process.env.HMAC_SECRET;
  if (!hmacSecret) throw new Error('HMAC_SECRET is not configured');

  const payload: QRTokenPayload = {
    ledgerEntryId, consumerAccountId, valueAssigned, tenantId,
    timestamp: new Date().toISOString(),
  };

  const payloadString = JSON.stringify(payload);
  const signature = createHmac('sha256', hmacSecret).update(payloadString).digest('hex');
  const token = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');

  return { payload, signature, token };
}

export function verifyOutputToken(token: string): {
  valid: boolean;
  payload?: QRTokenPayload;
  reason?: string;
} {
  const hmacSecret = process.env.HMAC_SECRET;
  if (!hmacSecret) throw new Error('HMAC_SECRET is not configured');

  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    const { payload, signature } = decoded;

    if (!payload || !signature) return { valid: false, reason: 'Invalid token structure' };

    const payloadString = JSON.stringify(payload);
    const expectedSignature = createHmac('sha256', hmacSecret).update(payloadString).digest('hex');

    if (signature !== expectedSignature) return { valid: false, reason: 'Invalid signature — token may have been tampered with' };

    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'Malformed token' };
  }
}

export async function verifyAndResolveLedgerEntry(token: string) {
  const verification = verifyOutputToken(token);
  if (!verification.valid || !verification.payload) return { valid: false, reason: verification.reason };

  const { ledgerEntryId, tenantId } = verification.payload;

  const entry = await prisma.ledgerEntry.findFirst({
    where: { id: ledgerEntryId, tenantId },
  });

  if (!entry) return { valid: false, reason: 'Ledger entry not found' };

  return { valid: true, payload: verification.payload, ledgerEntry: entry };
}
