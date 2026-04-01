import prisma from '../db/client.js';
import { writeDoubleEntry } from './ledger.js';
import { getSystemAccount } from './accounts.js';
import type { Dispute } from '@prisma/client';

export async function createDispute(params: {
  tenantId: string;
  consumerAccountId: string;
  description: string;
  screenshotUrl?: string;
}): Promise<Dispute> {
  return prisma.dispute.create({
    data: {
      tenantId: params.tenantId,
      consumerAccountId: params.consumerAccountId,
      description: params.description,
      screenshotUrl: params.screenshotUrl,
      status: 'open',
    },
  });
}

export async function listDisputes(tenantId: string, status?: string): Promise<Dispute[]> {
  const where: any = { tenantId };
  if (status) where.status = status;
  return prisma.dispute.findMany({ where, orderBy: { createdAt: 'desc' } });
}

export async function resolveDispute(params: {
  disputeId: string;
  action: 'approve' | 'reject' | 'escalate';
  reason: string;
  resolverId: string;
  resolverType: 'staff' | 'admin';
  adjustmentAmount?: string;
  assetTypeId?: string;
}): Promise<{ success: boolean; message: string }> {
  const dispute = await prisma.dispute.findUnique({ where: { id: params.disputeId } });
  if (!dispute) return { success: false, message: 'Dispute not found' };
  if (dispute.status !== 'open' && dispute.status !== 'escalated') {
    return { success: false, message: 'Dispute is already resolved' };
  }

  if (params.action === 'escalate') {
    await prisma.dispute.update({
      where: { id: params.disputeId },
      data: { status: 'escalated' },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type,
        consumer_account_id, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${dispute.tenantId}::uuid, ${params.resolverId}::uuid,
        ${params.resolverType}::"AuditActorType",
        ${params.resolverType === 'admin' ? 'admin' : 'owner'}::"AuditActorRole",
        'DISPUTE_ESCALATED',
        ${dispute.consumerAccountId}::uuid, 'success',
        ${JSON.stringify({ disputeId: params.disputeId, reason: params.reason })}::jsonb, now())
    `;

    return { success: true, message: 'Dispute escalated to admin' };
  }

  if (params.action === 'approve' && params.adjustmentAmount && params.assetTypeId) {
    const poolAccount = await getSystemAccount(dispute.tenantId, 'issued_value_pool');
    if (!poolAccount) return { success: false, message: 'System pool account not found' };

    const ledgerResult = await writeDoubleEntry({
      tenantId: dispute.tenantId,
      eventType: 'ADJUSTMENT_MANUAL',
      debitAccountId: poolAccount.id,
      creditAccountId: dispute.consumerAccountId,
      amount: params.adjustmentAmount,
      assetTypeId: params.assetTypeId,
      referenceId: `DISPUTE-${params.disputeId}`,
      referenceType: 'manual_adjustment',
      metadata: { disputeId: params.disputeId, reason: params.reason, resolvedBy: params.resolverId },
    });

    await prisma.dispute.update({
      where: { id: params.disputeId },
      data: {
        status: 'approved',
        resolverId: params.resolverId,
        resolverType: params.resolverType,
        resolutionReason: params.reason,
        ledgerAdjustmentEntryId: ledgerResult.credit.id,
        resolvedAt: new Date(),
      },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type,
        consumer_account_id, amount, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${dispute.tenantId}::uuid, ${params.resolverId}::uuid,
        ${params.resolverType}::"AuditActorType",
        ${params.resolverType === 'admin' ? 'admin' : 'owner'}::"AuditActorRole",
        'DISPUTE_APPROVED',
        ${dispute.consumerAccountId}::uuid, ${parseFloat(params.adjustmentAmount)},
        'success',
        ${JSON.stringify({ disputeId: params.disputeId, reason: params.reason })}::jsonb, now())
    `;

    return { success: true, message: 'Dispute approved — adjustment credited' };
  }

  if (params.action === 'reject') {
    await prisma.dispute.update({
      where: { id: params.disputeId },
      data: {
        status: 'rejected',
        resolverId: params.resolverId,
        resolverType: params.resolverType,
        resolutionReason: params.reason,
        resolvedAt: new Date(),
      },
    });

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type,
        consumer_account_id, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${dispute.tenantId}::uuid, ${params.resolverId}::uuid,
        ${params.resolverType}::"AuditActorType",
        ${params.resolverType === 'admin' ? 'admin' : 'owner'}::"AuditActorRole",
        'DISPUTE_REJECTED',
        ${dispute.consumerAccountId}::uuid, 'success',
        ${JSON.stringify({ disputeId: params.disputeId, reason: params.reason })}::jsonb, now())
    `;

    return { success: true, message: 'Dispute rejected' };
  }

  return { success: false, message: 'Invalid action' };
}
