/**
 * Background job workers via BullMQ + Redis.
 * REDIS_URL from .env — never hardcoded.
 */

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { processCSV } from './csv-upload.js';
import { runReconciliation } from './reconciliation.js';
import { expireRedemption } from './redemption.js';
import { runRecurrenceEngine } from './recurrence.js';
import prisma from '../db/client.js';

function getRedisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not configured in .env');
  return new IORedis(url, { maxRetriesPerRequest: null });
}

// ============================================================
// CSV PROCESSING QUEUE
// ============================================================

let csvQueue: Queue | null = null;

export function getCsvQueue(): Queue {
  if (!csvQueue) {
    csvQueue = new Queue('csv-processing', { connection: getRedisConnection() });
  }
  return csvQueue;
}

export async function enqueueCsvJob(csvContent: string, tenantId: string, staffId: string): Promise<string> {
  const queue = getCsvQueue();
  const job = await queue.add('process-csv', { csvContent, tenantId, staffId });
  return job.id!;
}

// ============================================================
// RECONCILIATION QUEUE (periodic)
// ============================================================

let reconciliationQueue: Queue | null = null;

export function getReconciliationQueue(): Queue {
  if (!reconciliationQueue) {
    reconciliationQueue = new Queue('reconciliation', { connection: getRedisConnection() });
  }
  return reconciliationQueue;
}

// ============================================================
// REDEMPTION EXPIRY QUEUE
// ============================================================

let expiryQueue: Queue | null = null;

export function getExpiryQueue(): Queue {
  if (!expiryQueue) {
    expiryQueue = new Queue('redemption-expiry', { connection: getRedisConnection() });
  }
  return expiryQueue;
}

export async function enqueueExpiryJob(tokenId: string, delayMs: number): Promise<void> {
  const queue = getExpiryQueue();
  await queue.add('expire-token', { tokenId }, { delay: delayMs });
}

// ============================================================
// START ALL WORKERS
// ============================================================

export function startWorkers() {
  const connection = getRedisConnection();

  // CSV processing worker
  new Worker('csv-processing', async (job) => {
    const { csvContent, tenantId, staffId } = job.data;
    console.log(`[Worker] Processing CSV for tenant ${tenantId}`);
    const result = await processCSV(csvContent, tenantId, staffId);
    console.log(`[Worker] CSV done: ${result.rowsLoaded} loaded, ${result.rowsSkipped} skipped, ${result.rowsErrored} errors`);
    return result;
  }, { connection });

  // Reconciliation worker (runs periodically)
  new Worker('reconciliation', async () => {
    console.log('[Worker] Running reconciliation...');
    const result = await runReconciliation();
    console.log(`[Worker] Reconciliation: ${result.confirmed} confirmed, ${result.reversed} reversed, ${result.stillPending} pending`);
    return result;
  }, { connection });

  // Redemption expiry worker
  new Worker('redemption-expiry', async (job) => {
    const { tokenId } = job.data;
    console.log(`[Worker] Expiring redemption token ${tokenId}`);
    await expireRedemption(tokenId);
  }, { connection });

  // Recurrence engine worker
  new Worker('recurrence', async () => {
    console.log('[Worker] Running recurrence engine...');
    const result = await runRecurrenceEngine();
    console.log(`[Worker] Recurrence: ${result.notified} notified, ${result.bonusesGranted} bonuses, ${result.skipped} skipped`);
    return result;
  }, { connection });

  // Schedule reconciliation to run every 5 minutes
  const reconciliationIntervalMs = 5 * 60 * 1000;
  setInterval(async () => {
    try {
      const queue = getReconciliationQueue();
      await queue.add('reconcile', {});
    } catch (err) {
      console.error('[Worker] Failed to enqueue reconciliation:', err);
    }
  }, reconciliationIntervalMs);

  // Schedule recurrence engine to run once per day
  const recurrenceIntervalMs = 24 * 60 * 60 * 1000;
  const recurrenceQueue = new Queue('recurrence', { connection: getRedisConnection() });
  setInterval(async () => {
    try {
      await recurrenceQueue.add('check-recurrence', {});
    } catch (err) {
      console.error('[Worker] Failed to enqueue recurrence:', err);
    }
  }, recurrenceIntervalMs);
  // Also run once on startup
  recurrenceQueue.add('check-recurrence', {}).catch(() => {});

  console.log('[Workers] All background workers started');
}
