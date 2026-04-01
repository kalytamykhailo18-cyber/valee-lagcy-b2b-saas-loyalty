import prisma from '../db/client.js';

/**
 * Check if a request with this idempotency key has already been processed.
 * If yes, returns the stored result. If no, returns null.
 */
export async function checkIdempotencyKey(key: string): Promise<any | null> {
  const existing = await prisma.idempotencyKey.findUnique({ where: { key } });

  if (!existing) return null;

  // Check if expired
  if (new Date() > existing.expiresAt) {
    await prisma.idempotencyKey.delete({ where: { key } });
    return null;
  }

  return existing.result;
}

/**
 * Store the result of a processed request for idempotency.
 */
export async function storeIdempotencyKey(
  key: string,
  resourceType: string,
  result: any,
  ttlHours?: number
): Promise<void> {
  const defaultTTL = parseInt(process.env.OFFLINE_QUEUE_TTL_HOURS || '24');
  const expiresAt = new Date(Date.now() + (ttlHours ?? defaultTTL) * 60 * 60 * 1000);

  await prisma.idempotencyKey.upsert({
    where: { key },
    update: { result, expiresAt },
    create: { key, resourceType, result, expiresAt },
  });
}
