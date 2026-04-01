import prisma from '../db/client.js';
import type { Tenant } from '@prisma/client';

export async function createTenant(
  name: string,
  slug: string,
  ownerEmail: string
): Promise<Tenant> {
  return prisma.tenant.create({
    data: { name, slug, ownerEmail },
  });
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  return prisma.tenant.findUnique({ where: { id } });
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  return prisma.tenant.findUnique({ where: { slug } });
}

export async function listTenants(): Promise<Tenant[]> {
  return prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function deactivateTenant(id: string): Promise<Tenant> {
  return prisma.tenant.update({
    where: { id },
    data: { status: 'inactive' },
  });
}
