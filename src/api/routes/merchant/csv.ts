import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { processCSV } from '../../../services/csv-upload.js';
import { enqueueCsvJob } from '../../../services/workers.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../../../services/idempotency.js';

export async function registerCsvRoutes(app: FastifyInstance): Promise<void> {
  // ---- CSV UPLOAD (Owner only) ----
  app.post('/api/merchant/csv-upload', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { csvContent, async: useAsync, requestId } = request.body as { csvContent: string; async?: boolean; requestId?: string };

    if (!csvContent) return reply.status(400).send({ error: 'csvContent is required' });

    // Client-supplied requestId idempotency. Re-submitting the same batch
    // (e.g. owner double-clicks upload, or the client retries after a flaky
    // connection) returns the first result instead of re-running processCSV.
    // Per-row idempotency is already guaranteed by the UNIQUE(tenant_id,
    // invoice_number) constraint — this just avoids redoing the parse.
    if (requestId) {
      const cacheKey = `csv:${tenantId}:${requestId}`;
      const cached = await checkIdempotencyKey(cacheKey);
      if (cached) return cached;
    }

    // CSV uploads are intentionally UNCAPPED. Genesis's QA: merchants
    // need to be able to re-upload bulk invoice batches freely while
    // onboarding or backfilling. We still surface the per-month counter
    // in the settings UI (getUsage runs), but we never block on it.

    // If async=true and Redis is configured, queue the job
    if (useAsync && process.env.REDIS_URL) {
      const jobId = await enqueueCsvJob(csvContent, tenantId, staffId);
      const queuedResult = { success: true, jobId, status: 'queued', message: 'CSV processing queued' };
      if (requestId) {
        await storeIdempotencyKey(`csv:${tenantId}:${requestId}`, 'csv_upload', queuedResult);
      }
      return queuedResult;
    }

    // Otherwise process synchronously
    const result = await processCSV(csvContent, tenantId, staffId);

    if (requestId) {
      await storeIdempotencyKey(`csv:${tenantId}:${requestId}`, 'csv_upload', result);
    }

    // Audit log
    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff', 'owner', 'CSV_UPLOAD', 'success',
        ${JSON.stringify({ batchId: result.batchId, rowsLoaded: result.rowsLoaded, rowsSkipped: result.rowsSkipped, rowsErrored: result.rowsErrored })}::jsonb, now())
    `;

    return result;
  });

  // ---- CSV UPLOAD STATUS (Owner only) ----
  app.get('/api/merchant/csv-upload/:batchId', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { batchId } = request.params as { batchId: string };

    const batch = await prisma.uploadBatch.findFirst({ where: { id: batchId, tenantId } });
    if (!batch) return reply.status(404).send({ error: 'Batch not found' });

    return {
      batchId: batch.id,
      status: batch.status,
      rowsLoaded: batch.rowsLoaded,
      rowsSkipped: batch.rowsSkipped,
      rowsErrored: batch.rowsErrored,
      errorDetails: batch.errorDetails,
      createdAt: batch.createdAt,
      completedAt: batch.completedAt,
    };
  });

  // List invoices (from CSV uploads + claimed/pending). Provides the "did my
  // CSV actually land?" visibility the merchant dashboard was missing.
  app.get('/api/merchant/invoices', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { status, batchId, search, limit = '50', offset = '0' } = request.query as {
      status?: string; batchId?: string; search?: string; limit?: string; offset?: string;
    };
    const where: any = { tenantId };
    if (status) where.status = status;
    if (batchId) where.uploadBatchId = batchId;
    if (search) where.invoiceNumber = { contains: search, mode: 'insensitive' };

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(limit) || 50, 200),
        skip: parseInt(offset) || 0,
      }),
      prisma.invoice.count({ where }),
    ]);

    const statusCounts = await prisma.invoice.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: { _all: true },
    });
    const counts: Record<string, number> = { available: 0, claimed: 0, pending_validation: 0, rejected: 0 };
    for (const row of statusCounts) counts[row.status] = row._count._all;

    // Eric 2026-04-25: surface the $/€ equivalent next to each Bs amount,
    // same pattern the customers panel already uses, so the merchant doesn't
    // have to mentally convert every row.
    const tenantForCurrency = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { preferredExchangeSource: true, referenceCurrency: true },
    });
    const refCurrency = tenantForCurrency?.referenceCurrency || 'usd';
    const currencySymbol = refCurrency === 'eur' ? '€' : refCurrency === 'bs' ? 'Bs' : '$';
    const exchangeSource = tenantForCurrency?.preferredExchangeSource || null;
    const { getRateAtDate } = await import('../../../services/exchange-rates.js');

    const invoicesOut = await Promise.all(invoices.map(async (i) => {
      let amountInReference: string | null = null;
      if (exchangeSource && refCurrency && refCurrency !== 'bs') {
        const date = i.transactionDate || i.createdAt;
        const rate = await getRateAtDate(exchangeSource as any, refCurrency as any, date);
        if (rate && rate.rateBs > 0) {
          amountInReference = (Number(i.amount) / rate.rateBs).toFixed(2);
        }
      }
      return {
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        amount: i.amount.toString(),
        amountInReference,
        currencySymbol,
        transactionDate: i.transactionDate,
        customerPhone: i.customerPhone,
        status: i.status,
        uploadBatchId: i.uploadBatchId,
        createdAt: i.createdAt,
      };
    }));

    return {
      invoices: invoicesOut,
      total,
      counts,
    };
  });
}
