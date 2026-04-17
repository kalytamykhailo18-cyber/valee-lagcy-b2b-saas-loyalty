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
 *
 * First write wins — if a record with the same key already exists (because a
 * concurrent request raced us), we keep the existing result instead of
 * overwriting it. This prevents the second caller of a true duplicate from
 * mutating the first caller's persisted outcome.
 */
export async function storeIdempotencyKey(
  key: string,
  resourceType: string,
  result: any,
  ttlHours?: number
): Promise<void> {
  const defaultTTL = parseInt(process.env.OFFLINE_QUEUE_TTL_HOURS || '24');
  const expiresAt = new Date(Date.now() + (ttlHours ?? defaultTTL) * 60 * 60 * 1000);

  try {
    await prisma.idempotencyKey.create({
      data: { key, resourceType, result, expiresAt },
    });
  } catch (e: any) {
    // P2002 = unique constraint violation → another writer stored first.
    // That's the expected outcome for a true duplicate, swallow it.
    if (e?.code !== 'P2002') throw e;
  }
}
