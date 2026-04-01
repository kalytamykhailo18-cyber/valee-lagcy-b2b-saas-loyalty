import prisma from '../db/client.js';
import type { Branch } from '@prisma/client';

export async function createBranch(params: {
  tenantId: string;
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}): Promise<Branch> {
  return prisma.branch.create({ data: params });
}

export async function listBranches(tenantId: string): Promise<Branch[]> {
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
