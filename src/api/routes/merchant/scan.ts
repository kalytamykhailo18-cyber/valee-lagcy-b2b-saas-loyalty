import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { processRedemption } from '../../../services/redemption.js';
import { verifyAndResolveLedgerEntry } from '../../../services/qr-token.js';
import { requireStaffAuth } from '../../middleware/auth.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../../../services/idempotency.js';

export async function registerScanRoutes(app: FastifyInstance): Promise<void> {
  // ---- DUAL-SCAN: Cashier initiates a transaction without a fiscal invoice ----
  app.post('/api/merchant/dual-scan/initiate', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { staffId, tenantId } = request.staff!;
    const { amount, branchId } = request.body as { amount: string; branchId?: string };

    if (!amount || typeof amount !== 'string') {
      return reply.status(400).send({ error: 'amount is required (string)' });
    }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return reply.status(400).send({ error: 'amount must be a positive number' });
    }

    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();
    if (!assetType) return reply.status(500).send({ error: 'No asset type configured' });

    // Resolve branch: if cashier has a branchId, use that; otherwise use the provided one
    const cashier = await prisma.staff.findUnique({ where: { id: staffId } });
    const effectiveBranchId = cashier?.branchId || branchId || null;

    const { initiateDualScan } = await import('../../../services/dual-scan.js');
    const result = await initiateDualScan({
      tenantId,
      cashierId: staffId,
      branchId: effectiveBranchId,
      amount,
      assetTypeId: assetType.id,
    });

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    // Audit the cashier action
    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type,
        amount, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'cashier',
        'QR_SCAN_SUCCESS', ${amountNum}, 'success',
        ${JSON.stringify({ kind: 'dual_scan_initiate', branchId: effectiveBranchId })}::jsonb, now())
    `;

    return { success: true, token: result.token, expiresAt: result.expiresAt };
  });

  // ---- DUAL-SCAN: Status poll ----
  // The merchant UI polls this while the QR is displayed so the cashier sees a
  // success animation the instant the customer confirms — instead of staring
  // at the countdown and not knowing if it worked (Eric 2026-04-23). Scoped to
  // tenant via the staff session; the nonce carries no data beyond identifying
  // the specific token, so surfacing "consumed=true + payer phone + amount" is
  // information the merchant already owns via the ledger.
  app.get('/api/merchant/dual-scan/status/:nonce', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { nonce } = request.params as { nonce: string };
    if (!/^[a-f0-9]{8,64}$/i.test(nonce)) {
      return reply.status(400).send({ error: 'Invalid nonce' });
    }
    const referenceId = `DUALSCAN-${nonce}`;
    const entry = await prisma.ledgerEntry.findFirst({
      where: {
        tenantId,
        referenceId,
        entryType: 'CREDIT',
        eventType: 'PRESENCE_VALIDATED',
      },
      select: { id: true, amount: true, createdAt: true, accountId: true },
    });
    if (!entry) return { consumed: false };
    const acc = entry.accountId
      ? await prisma.account.findUnique({
          where: { id: entry.accountId },
          select: { phoneNumber: true, displayName: true },
        })
      : null;
    return {
      consumed: true,
      valueAssigned: entry.amount.toString(),
      consumerPhone: acc?.phoneNumber || null,
      consumerName: acc?.displayName || null,
      confirmedAt: entry.createdAt,
    };
  });

  // ---- CASHIER QR SCANNER ----
  app.post('/api/merchant/scan-redemption', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { staffId, tenantId } = request.staff!;
    const { token, requestId, branchId } = request.body as { token: string; requestId?: string; branchId?: string };

    if (!token) return reply.status(400).send({ error: 'token is required' });

    // Client-supplied requestId idempotency: a client offline-queue resubmit of
    // the SAME scan should return the first result, not re-process. Canonical
    // protection against double-processing is still the RedemptionToken row
    // itself (status='used' on first scan, second scan rejects), but retries
    // that hit us before the token mutates benefit from this cache.
    if (requestId) {
      const cacheKey = `scan:${tenantId}:${requestId}`;
      const cached = await checkIdempotencyKey(cacheKey);
      if (cached) return cached;
    }

    // Validate branchId belongs to this tenant before passing through.
    let scopedBranchId: string | undefined;
    if (branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true } });
      if (branch) scopedBranchId = branch.id;
    }

    const result = await processRedemption({
      token,
      cashierStaffId: staffId,
      cashierTenantId: tenantId,
      branchId: scopedBranchId,
    });

    if (requestId) {
      const cacheKey = `scan:${tenantId}:${requestId}`;
      await storeIdempotencyKey(cacheKey, 'redemption_scan', result);
    }

    if (!result.success) {
      await prisma.$executeRaw`
        INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, failure_reason, created_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff',
          ${request.staff!.role}::"AuditActorRole", 'QR_SCAN_FAILURE', 'failure', ${result.message}, now())
      `;
    }

    return result;
  });

  // ---- VERIFY OUTPUT TOKEN (Merchant confirms a validation event) ----
  app.post('/api/merchant/verify-token', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { token } = request.body as { token: string };

    if (!token) return reply.status(400).send({ error: 'token is required' });

    const result = await verifyAndResolveLedgerEntry(token);

    if (!result.valid) {
      return reply.status(400).send({ valid: false, reason: result.reason });
    }

    // Ensure the token belongs to this merchant's tenant
    if (result.payload!.tenantId !== tenantId) {
      return reply.status(403).send({ valid: false, reason: 'Token belongs to a different merchant' });
    }

    return {
      valid: true,
      ledgerEntry: {
        id: result.ledgerEntry!.id,
        eventType: result.ledgerEntry!.eventType,
        amount: result.ledgerEntry!.amount.toString(),
        referenceId: result.ledgerEntry!.referenceId,
        createdAt: result.ledgerEntry!.createdAt,
        status: result.ledgerEntry!.status,
      },
      payload: result.payload,
    };
  });
}
