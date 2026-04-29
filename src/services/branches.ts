import prisma from '../db/client.js';
import type { Branch } from '@prisma/client';

export async function createBranch(params: {
  tenantId: string;
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}): Promise<Branch> {
  // The first sucursal under a tenant inherits the onboarding QR
  // (tenant.qrCodeUrl). Eric 2026-04-26: a level-1 owner who picks "Tengo
  // sucursales" in onboarding expects "Kromi Valencia" (the first sede they
  // declared) to already carry the QR they printed at signup — not to show
  // "Generar QR" as if it were a brand new sede with no code. Pre-existing
  // tenants with no first-branch inheritance are reconciled lazily by
  // syncPrimaryBranchQr() below when listBranches is read.
  const existingCount = await prisma.branch.count({ where: { tenantId: params.tenantId } });
  let qrCodeUrl: string | null = null;
  if (existingCount === 0) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.tenantId },
      select: { qrCodeUrl: true },
    });
    qrCodeUrl = tenant?.qrCodeUrl || null;
  }
  return prisma.branch.create({
    data: { ...params, qrCodeUrl: qrCodeUrl ?? undefined },
  });
}

/**
 * Reconcile the primary (oldest) branch's QR with the tenant QR. The two
 * concepts are conceptually one — "QR del comercio" === QR of the first
 * sucursal — so we keep them in sync. Idempotent and cheap (one read + at
 * most one write).
 */
export async function syncPrimaryBranchQr(tenantId: string): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { qrCodeUrl: true },
  });
  if (!tenant?.qrCodeUrl) return;
  const primary = await prisma.branch.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, qrCodeUrl: true },
  });
  if (!primary) return;
  if (primary.qrCodeUrl !== tenant.qrCodeUrl) {
    await prisma.branch.update({
      where: { id: primary.id },
      data: { qrCodeUrl: tenant.qrCodeUrl },
    });
  }
}

export async function listBranches(tenantId: string): Promise<Branch[]> {
  // Lazy reconcile: tenants whose first sucursal was created before the
  // onboarding-inheritance fix end up with a separately-generated branch QR
  // that diverges from the "QR del comercio". Sync once on read so the next
  // render shows the expected single QR.
  await syncPrimaryBranchQr(tenantId);
  return prisma.branch.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
}

export async function toggleBranch(branchId: string, tenantId: string): Promise<Branch> {
  const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId } });
  if (!branch) throw new Error('Branch not found');
  return prisma.branch.update({ where: { id: branchId }, data: { active: !branch.active } });
}

/**
 * Verify a cashier is assigned to the branch where the redemption is happening.
 * Returns true if the cashier has access (assigned to that branch or no branch restriction).
 */
export async function cashierHasBranchAccess(staffId: string, branchId: string | null): Promise<boolean> {
  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) return false;
  // If cashier has no branch assignment, they can access all branches
  if (!staff.branchId) return true;
  // If no specific branch for the redemption, allow
  if (!branchId) return true;
  // Otherwise, must match
  return staff.branchId === branchId;
}
