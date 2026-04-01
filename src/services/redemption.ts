import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/client.js';
import { writeDoubleEntry, getAccountBalance } from './ledger.js';
import { getSystemAccount } from './accounts.js';
import { enqueueExpiryJob } from './workers.js';

// ============================================================
// TYPES
// ============================================================

export interface RedemptionTokenPayload {
  tokenId: string;
  consumerAccountId: string;
  productId: string;
  amount: string;
  tenantId: string;
  assetTypeId: string;
  createdAt: string;
  expiresAt: string;
}

// ============================================================
// GENERATE REDEMPTION QR
// ============================================================

export async function initiateRedemption(params: {
  consumerAccountId: string;
  productId: string;
  tenantId: string;
  assetTypeId: string;
}): Promise<{
  success: boolean;
  message: string;
  token?: string;
  tokenId?: string;
  expiresAt?: string;
  amount?: string;
}> {
  const { consumerAccountId, productId, tenantId, assetTypeId } = params;

  // Verify product exists, is active, and has stock
  const product = await prisma.product.findFirst({
    where: { id: productId, tenantId, active: true },
  });

  if (!product) {
    return { success: false, message: 'Product not found or is inactive.' };
  }

  if (product.stock <= 0) {
    return { success: false, message: 'Product is out of stock.' };
  }

  const redemptionCost = product.redemptionCost.toString();

  // Final balance check
  const balance = await getAccountBalance(consumerAccountId, assetTypeId, tenantId);
  if (parseFloat(balance) < parseFloat(redemptionCost)) {
    return { success: false, message: `Insufficient balance. You need ${redemptionCost} but have ${balance}.` };
  }

  // Get holding account
  const holdingAccount = await getSystemAccount(tenantId, 'redemption_holding');
  if (!holdingAccount) throw new Error('redemption_holding account not found');

  // Write PENDING_REDEMPTION double-entry: debit consumer, credit holding
  const ledgerResult = await writeDoubleEntry({
    tenantId,
    eventType: 'REDEMPTION_PENDING',
    debitAccountId: consumerAccountId,
    creditAccountId: holdingAccount.id,
    amount: redemptionCost,
    assetTypeId,
    referenceId: `REDEEM-${uuidv4()}`,
    referenceType: 'redemption_token',
  });

  // Generate token
  const hmacSecret = process.env.HMAC_SECRET;
  if (!hmacSecret) throw new Error('HMAC_SECRET not configured');

  const ttlMinutes = parseInt(process.env.REDEMPTION_TOKEN_TTL_MINUTES || '15');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  const tokenId = uuidv4();

  const payload: RedemptionTokenPayload = {
    tokenId,
    consumerAccountId,
    productId,
    amount: redemptionCost,
    tenantId,
    assetTypeId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const payloadString = JSON.stringify(payload);
  const signature = createHmac('sha256', hmacSecret).update(payloadString).digest('hex');
  const token = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');

  // Store in redemption_tokens table
  await prisma.redemptionToken.create({
    data: {
      id: tokenId,
      tenantId,
      consumerAccountId,
      productId,
      amount: redemptionCost,
      assetTypeId,
      status: 'pending',
      tokenSignature: signature,
      expiresAt,
      ledgerPendingEntryId: ledgerResult.debit.id,
    },
  });

  // Schedule automatic expiry via background worker
  if (process.env.REDIS_URL) {
    await enqueueExpiryJob(tokenId, ttlMinutes * 60 * 1000).catch(err => {
      console.error('[Redemption] Failed to enqueue expiry job:', err);
    });
  }

  return {
    success: true,
    message: 'Redemption QR generated.',
    token,
    tokenId,
    expiresAt: expiresAt.toISOString(),
    amount: redemptionCost,
  };
}

// ============================================================
// PROCESS REDEMPTION (Cashier scans QR)
// ============================================================

export async function processRedemption(params: {
  token: string;
  cashierStaffId: string;
  cashierTenantId: string;
  branchId?: string;
}): Promise<{
  success: boolean;
  message: string;
  productName?: string;
  amount?: string;
}> {
  const hmacSecret = process.env.HMAC_SECRET;
  if (!hmacSecret) throw new Error('HMAC_SECRET not configured');

  // 1. Decode token
  let decoded: { payload: RedemptionTokenPayload; signature: string };
  try {
    decoded = JSON.parse(Buffer.from(params.token, 'base64').toString('utf-8'));
  } catch {
    return { success: false, message: 'Invalid QR code.' };
  }

  const { payload, signature } = decoded;

  // 2. Verify HMAC signature
  const expectedSig = createHmac('sha256', hmacSecret)
    .update(JSON.stringify(payload))
    .digest('hex');

  if (signature !== expectedSig) {
    return { success: false, message: 'Invalid QR — signature verification failed.' };
  }

  // 3. Check TTL
  if (new Date() > new Date(payload.expiresAt)) {
    return { success: false, message: 'QR expired.' };
  }

  // 4. Check token not already used (idempotency)
  const tokenRecord = await prisma.redemptionToken.findUnique({
    where: { id: payload.tokenId },
  });

  if (!tokenRecord) {
    return { success: false, message: 'Token not found.' };
  }

  if (tokenRecord.status === 'used') {
    return { success: false, message: 'This QR has already been used.' };
  }

  if (tokenRecord.status === 'expired') {
    return { success: false, message: 'This QR has expired.' };
  }

  // 5. Verify tenant match
  if (payload.tenantId !== params.cashierTenantId) {
    return { success: false, message: 'Tenant mismatch — this QR belongs to a different merchant.' };
  }

  // 6. Verify pending ledger entry exists
  const pendingEntry = await prisma.ledgerEntry.findFirst({
    where: {
      id: tokenRecord.ledgerPendingEntryId,
      tenantId: payload.tenantId,
      eventType: 'REDEMPTION_PENDING',
    },
  });

  if (!pendingEntry) {
    return { success: false, message: 'Pending redemption record not found.' };
  }

  // 7. Get accounts
  const holdingAccount = await getSystemAccount(payload.tenantId, 'redemption_holding');
  if (!holdingAccount) throw new Error('redemption_holding not found');

  // Get product for name
  const product = await prisma.product.findUnique({ where: { id: payload.productId } });

  // 8. Write REDEMPTION_CONFIRMED double-entry: debit holding, credit...
  // Per the event table: REDEMPTION_CONFIRMED debits holding (value leaves holding)
  // The value is consumed — we debit holding to close the loop
  await writeDoubleEntry({
    tenantId: payload.tenantId,
    eventType: 'REDEMPTION_CONFIRMED',
    debitAccountId: holdingAccount.id,
    creditAccountId: payload.consumerAccountId,
    amount: payload.amount,
    assetTypeId: payload.assetTypeId,
    referenceId: `CONFIRMED-${payload.tokenId}`,
    referenceType: 'redemption_token',
    branchId: params.branchId || null,
    metadata: { cashierId: params.cashierStaffId, productId: payload.productId },
  });

  // 9. Decrement product stock
  if (product && product.stock > 0) {
    await prisma.product.update({
      where: { id: payload.productId },
      data: { stock: { decrement: 1 } },
    });
  }

  // 10. Update token status to used
  await prisma.redemptionToken.update({
    where: { id: payload.tokenId },
    data: {
      status: 'used',
      usedAt: new Date(),
      usedByStaffId: params.cashierStaffId,
      branchId: params.branchId || null,
    },
  });

  // 11. Write audit log
  await prisma.$executeRaw`
    INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type,
      consumer_account_id, amount, outcome, metadata, created_at)
    VALUES (gen_random_uuid(), ${payload.tenantId}::uuid, ${params.cashierStaffId}::uuid,
      'staff', 'cashier', 'QR_SCAN_SUCCESS',
      ${payload.consumerAccountId}::uuid, ${parseFloat(payload.amount)},
      'success', ${JSON.stringify({ tokenId: payload.tokenId, productId: payload.productId })}::jsonb, now())
  `;

  return {
    success: true,
    message: 'Redemption processed successfully!',
    productName: product?.name || 'Unknown',
    amount: payload.amount,
  };
}

// ============================================================
// EXPIRE REDEMPTION (called when TTL runs out)
// ============================================================

export async function expireRedemption(tokenId: string): Promise<void> {
  const tokenRecord = await prisma.redemptionToken.findUnique({
    where: { id: tokenId },
  });

  if (!tokenRecord || tokenRecord.status !== 'pending') return;

  // Check if actually expired
  if (new Date() < tokenRecord.expiresAt) return;

  const holdingAccount = await getSystemAccount(tokenRecord.tenantId, 'redemption_holding');
  if (!holdingAccount) throw new Error('redemption_holding not found');

  // Write REDEMPTION_EXPIRED reversal: debit holding, credit consumer (return value)
  await writeDoubleEntry({
    tenantId: tokenRecord.tenantId,
    eventType: 'REDEMPTION_EXPIRED',
    debitAccountId: holdingAccount.id,
    creditAccountId: tokenRecord.consumerAccountId,
    amount: tokenRecord.amount.toString(),
    assetTypeId: tokenRecord.assetTypeId,
    referenceId: `EXPIRED-${tokenId}`,
    referenceType: 'redemption_token',
  });

  await prisma.redemptionToken.update({
    where: { id: tokenId },
    data: { status: 'expired' },
  });
}
