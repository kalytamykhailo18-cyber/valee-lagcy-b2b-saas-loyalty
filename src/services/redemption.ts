import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/client.js';
import { writeDoubleEntry, getAccountBalance, getAccountBalanceBreakdown } from './ledger.js';
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
  cashAmount?: string | null; // For hybrid redemption: cash portion paid by consumer
}): Promise<{
  success: boolean;
  message: string;
  token?: string;
  tokenId?: string;
  shortCode?: string;
  expiresAt?: string;
  amount?: string;
  cashAmount?: string;
  hybrid?: boolean;
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

  const fullPointsCost = Number(product.redemptionCost);
  const cashPortion = params.cashAmount ? parseFloat(params.cashAmount) : 0;
  const productCashPrice = product.cashPrice ? Number(product.cashPrice) : 0;
  const isHybrid = cashPortion > 0;

  // Calculate how many points are needed after cash contribution
  let pointsToDeduct: number;

  if (isHybrid) {
    if (productCashPrice <= 0) {
      return { success: false, message: 'This product does not accept cash payments. Use points only.' };
    }

    // Cash covers a proportion of the cost, rest is points
    // E.g., product costs 1000 pts OR $5. Consumer pays $2, so they cover 2/5 = 40%.
    // Remaining 60% = 600 pts needed.
    const cashRatio = Math.min(cashPortion / productCashPrice, 1); // cap at 100%
    pointsToDeduct = Math.round(fullPointsCost * (1 - cashRatio));

    if (pointsToDeduct < 0) pointsToDeduct = 0;
  } else {
    pointsToDeduct = fullPointsCost;
  }

  // Final balance check (only for the points portion).
  // Use total balance (confirmed + provisional) for redemptions. Provisional
  // credits from invoice submissions are real value that the consumer earned —
  // restricting to confirmed-only blocks all redemptions when no CSV has been
  // uploaded for reconciliation.
  const totalBalance = parseFloat(await getAccountBalance(consumerAccountId, assetTypeId, tenantId));
  if (totalBalance < pointsToDeduct) {
    return { success: false, message: `Saldo insuficiente. Necesitas ${pointsToDeduct} puntos pero tienes ${Math.round(totalBalance).toLocaleString()}.` };
  }

  // Get holding account
  const holdingAccount = await getSystemAccount(tenantId, 'redemption_holding');
  if (!holdingAccount) throw new Error('redemption_holding account not found');

  const pointsAmount = pointsToDeduct.toFixed(8);
  const referenceId = `REDEEM-${uuidv4()}`;

  // Product info stamped into ledger metadata. Historically we relied on the
  // RedemptionToken row for lookups, but those get purged once expired/used,
  // leaving the ledger pointer dangling. Stamping product name+photo here lets
  // the consumer history keep showing "Cafe Gratis" forever.
  const productMeta = { productId: product.id, productName: product.name, productPhotoUrl: product.photoUrl || null };

  // Write PENDING_REDEMPTION double-entry for the POINTS portion (skip if 0 points — full cash)
  let ledgerResult;
  if (pointsToDeduct > 0) {
    ledgerResult = await writeDoubleEntry({
      tenantId,
      eventType: 'REDEMPTION_PENDING',
      debitAccountId: consumerAccountId,
      creditAccountId: holdingAccount.id,
      amount: pointsAmount,
      assetTypeId,
      referenceId,
      referenceType: 'redemption_token',
      metadata: isHybrid
        ? { ...productMeta, hybrid: true, cashAmount: cashPortion, pointsDeducted: pointsToDeduct, fullPointsCost }
        : productMeta,
    });
  } else {
    // Full cash — create a minimal ledger record with the cash amount as metadata only
    // Use a nominal 0.00000001 amount to satisfy the CHECK constraint
    ledgerResult = await writeDoubleEntry({
      tenantId,
      eventType: 'REDEMPTION_PENDING',
      debitAccountId: consumerAccountId,
      creditAccountId: holdingAccount.id,
      amount: '0.00000001',
      assetTypeId,
      referenceId,
      referenceType: 'redemption_token',
      metadata: { ...productMeta, hybrid: true, fullCash: true, cashAmount: cashPortion, pointsDeducted: 0, fullPointsCost },
    });
  }

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
    amount: pointsAmount,
    tenantId,
    assetTypeId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const payloadString = JSON.stringify(payload);
  const signature = createHmac('sha256', hmacSecret).update(payloadString).digest('hex');
  const token = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');

  // Generate a unique 6-digit short code for manual entry by cashier.
  // Retry up to 5 times if we hit a collision with an active code in the same tenant.
  let shortCode = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = String(Math.floor(100000 + Math.random() * 900000));
    const collision = await prisma.redemptionToken.findFirst({
      where: { tenantId, shortCode: candidate, status: 'pending', expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!collision) { shortCode = candidate; break; }
  }
  if (!shortCode) shortCode = String(Math.floor(100000 + Math.random() * 900000));

  // Store in redemption_tokens table
  await prisma.redemptionToken.create({
    data: {
      id: tokenId,
      tenantId,
      consumerAccountId,
      productId,
      amount: pointsAmount,
      cashAmount: isHybrid ? cashPortion : null,
      assetTypeId,
      status: 'pending',
      tokenSignature: signature,
      shortCode,
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
    message: isHybrid
      ? `Hybrid redemption: ${pointsToDeduct} points + $${cashPortion} cash. QR generated.`
      : 'Redemption QR generated.',
    token,
    tokenId,
    shortCode,
    expiresAt: expiresAt.toISOString(),
    amount: pointsAmount,
    cashAmount: isHybrid ? cashPortion.toString() : undefined,
    hybrid: isHybrid,
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

  const tokenStr = params.token?.trim() || '';

  // If input is a 6-digit short code, look up the token directly from the DB.
  // The DB lookup itself is the authenticity check — the code only exists if we
  // created it during initiateRedemption. No signature verification needed.
  let payload: RedemptionTokenPayload;
  if (/^\d{6}$/.test(tokenStr)) {
    const record = await prisma.redemptionToken.findFirst({
      where: {
        tenantId: params.cashierTenantId,
        shortCode: tokenStr,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
    });
    if (!record) {
      const usedOrExpired = await prisma.redemptionToken.findFirst({
        where: { tenantId: params.cashierTenantId, shortCode: tokenStr },
      });
      if (usedOrExpired?.status === 'used') {
        return { success: false, message: 'Este codigo ya fue canjeado.' };
      }
      if (usedOrExpired?.status === 'expired') {
        return { success: false, message: 'Este codigo ya expiro.' };
      }
      return { success: false, message: 'Codigo de 6 digitos no valido.' };
    }
    payload = {
      tokenId: record.id,
      consumerAccountId: record.consumerAccountId,
      productId: record.productId,
      amount: record.amount.toString(),
      tenantId: record.tenantId,
      assetTypeId: record.assetTypeId,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    };
  } else {
    // 1. Decode token (base64 JSON)
    let decoded: { payload: RedemptionTokenPayload; signature: string };
    try {
      decoded = JSON.parse(Buffer.from(tokenStr, 'base64').toString('utf-8'));
    } catch {
      return { success: false, message: 'Codigo QR invalido.' };
    }

    // 2. Verify HMAC signature
    const expectedSig = createHmac('sha256', hmacSecret)
      .update(JSON.stringify(decoded.payload))
      .digest('hex');

    if (decoded.signature !== expectedSig) {
      return { success: false, message: 'Invalid QR — signature verification failed.' };
    }
    payload = decoded.payload;
  }

  // 3. Check TTL (from token payload)
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

  // Also check DB record's expiresAt (may have been updated by expiry worker)
  if (new Date() > tokenRecord.expiresAt) {
    return { success: false, message: 'QR expired.' };
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

  // 8. Write REDEMPTION_CONFIRMED double-entry: debit holding, credit pool
  // The value is consumed — holding releases to pool (merchant absorbs)
  // Consumer's balance stays reduced — value was spent on the product
  const poolAccount = await getSystemAccount(payload.tenantId, 'issued_value_pool');
  if (!poolAccount) throw new Error('issued_value_pool not found');

  const confirmResult = await writeDoubleEntry({
    tenantId: payload.tenantId,
    eventType: 'REDEMPTION_CONFIRMED',
    debitAccountId: holdingAccount.id,
    creditAccountId: poolAccount.id,
    amount: payload.amount,
    assetTypeId: payload.assetTypeId,
    referenceId: `CONFIRMED-${payload.tokenId}`,
    referenceType: 'redemption_token',
    branchId: params.branchId || null,
    metadata: {
      cashierId: params.cashierStaffId,
      productId: payload.productId,
      productName: product?.name || null,
      productPhotoUrl: product?.photoUrl || null,
    },
  });

  // Record platform revenue (redemption fee) if configured
  const { recordRedemptionFee } = await import('./platform-revenue.js');
  await recordRedemptionFee({
    tenantId: payload.tenantId,
    redemptionValue: payload.amount,
    ledgerEntryId: confirmResult.credit.id,
  });

  // 9. Decrement product stock and auto-deactivate if it hits zero
  if (product && product.stock > 0) {
    const updated = await prisma.product.update({
      where: { id: payload.productId },
      data: { stock: { decrement: 1 } },
    });
    if (updated.stock <= 0 && updated.active) {
      await prisma.product.update({
        where: { id: payload.productId },
        data: { active: false },
      });
    }
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
    message: tokenRecord.cashAmount && Number(tokenRecord.cashAmount) > 0
      ? `Hybrid redemption: ${payload.amount} pts + $${Number(tokenRecord.cashAmount)} cash`
      : 'Redemption processed successfully!',
    productName: product?.name || 'Unknown',
    amount: payload.amount,
    cashAmount: tokenRecord.cashAmount ? Number(tokenRecord.cashAmount).toString() : undefined,
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

  const product = await prisma.product.findUnique({ where: { id: tokenRecord.productId } });

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
    metadata: {
      productId: tokenRecord.productId,
      productName: product?.name || null,
      productPhotoUrl: product?.photoUrl || null,
    },
  });

  await prisma.redemptionToken.update({
    where: { id: tokenId },
    data: { status: 'expired' },
  });
}
