import { Prisma } from '@prisma/client';
import prisma from './client.js';

/**
 * Execute a callback within a tenant-scoped database context.
 * Uses SET ROLE loyalty_tenant + SET app.current_tenant_id to activate RLS.
 * This makes it structurally impossible to access other tenants' data.
 *
 * NOTE: $executeRawUnsafe is used because SET commands cannot be parameterized.
 * The tenantId is validated as a UUID before being interpolated.
 */
export async function withTenantContext<T>(
  tenantId: string,
  callback: (tx: typeof prisma) => Promise<T>
): Promise<T> {
  // Validate tenantId is a UUID to prevent SQL injection
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(tenantId)) {
    throw new Error('Invalid tenant ID format');
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE loyalty_tenant');
    await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    return callback(tx as unknown as typeof prisma);
  });
}

/**
 * Execute a callback in admin context (no RLS restriction).
 * loyalty_admin is the table owner and bypasses RLS by default.
 */
export async function withAdminContext<T>(
  callback: (tx: typeof prisma) => Promise<T>
): Promise<T> {
  return callback(prisma);
}
