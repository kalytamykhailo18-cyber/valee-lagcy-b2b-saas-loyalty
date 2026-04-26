import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { normalizeVenezuelanPhone } from '../../../services/accounts.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';
import { runRecurrenceEngine } from '../../../services/recurrence.js';

export async function registerRecurrenceRoutes(app: FastifyInstance): Promise<void> {
  // ---- RECURRENCE RULES (Owner only) ----
  app.get('/api/merchant/recurrence-rules', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const rules = await prisma.recurrenceRule.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return { rules };
  });

  app.post('/api/merchant/recurrence-rules', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { name, intervalDays, graceDays, messageTemplate, bonusAmount, targetPhones } = request.body as any;

    if (!name || !intervalDays || !messageTemplate) {
      return reply.status(400).send({ error: 'name, intervalDays, and messageTemplate are required' });
    }

    const normalizedPhones = Array.isArray(targetPhones)
      ? targetPhones.map((p: string) => normalizeVenezuelanPhone(String(p))).filter((p: string) => p && p.length >= 10)
      : [];

    const rule = await prisma.recurrenceRule.create({
      data: {
        tenantId, name, intervalDays: parseInt(intervalDays), graceDays: parseInt(graceDays || '1'),
        messageTemplate, bonusAmount: bonusAmount || null,
        targetPhones: normalizedPhones,
      },
    });
    return { rule };
  });

  app.patch('/api/merchant/recurrence-rules/:id/toggle', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };

    const rule = await prisma.recurrenceRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });

    const updated = await prisma.recurrenceRule.update({ where: { id }, data: { active: !rule.active } });
    return { rule: updated };
  });

  app.patch('/api/merchant/recurrence-rules/:id', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };
    const { name, intervalDays, graceDays, messageTemplate, bonusAmount, targetPhones } = request.body as any;

    const rule = await prisma.recurrenceRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });

    const updates: any = {};
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (trimmed.length < 4 || trimmed.length > 80) {
        return reply.status(400).send({ error: 'Nombre debe tener entre 4 y 80 caracteres' });
      }
      updates.name = trimmed;
    }
    if (intervalDays !== undefined) {
      const n = parseInt(intervalDays);
      if (isNaN(n) || n < 1 || n > 365) {
        return reply.status(400).send({ error: 'Intervalo debe estar entre 1 y 365 dias' });
      }
      updates.intervalDays = n;
    }
    if (graceDays !== undefined) {
      const n = parseInt(graceDays);
      if (isNaN(n) || n < 0 || n > 90) {
        return reply.status(400).send({ error: 'Gracia debe estar entre 0 y 90 dias' });
      }
      updates.graceDays = n;
    }
    if (messageTemplate !== undefined) {
      const trimmed = String(messageTemplate).trim();
      if (trimmed.length < 20 || trimmed.length > 500) {
        return reply.status(400).send({ error: 'Mensaje debe tener entre 20 y 500 caracteres' });
      }
      updates.messageTemplate = trimmed;
    }
    if (bonusAmount !== undefined) {
      if (bonusAmount === null || bonusAmount === '') {
        updates.bonusAmount = null;
      } else {
        const n = parseInt(bonusAmount);
        if (isNaN(n) || n < 1) {
          return reply.status(400).send({ error: 'Bono debe ser un numero positivo' });
        }
        updates.bonusAmount = n;
      }
    }
    if (targetPhones !== undefined) {
      if (!Array.isArray(targetPhones)) {
        return reply.status(400).send({ error: 'targetPhones debe ser un array' });
      }
      updates.targetPhones = targetPhones
        .map((p: string) => normalizeVenezuelanPhone(String(p)))
        .filter((p: string) => p && p.length >= 10);
    }

    const updated = await prisma.recurrenceRule.update({ where: { id }, data: updates });
    return { rule: updated };
  });

  app.delete('/api/merchant/recurrence-rules/:id', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };

    const rule = await prisma.recurrenceRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });

    // Hard delete: remove dependent notifications first, then the rule.
    // Notifications are historical records — losing them is acceptable for a
    // user-initiated delete (they're not financial). The audit_log row for
    // CUSTOMER_LOOKUP/etc. lives separately and is preserved.
    await prisma.recurrenceNotification.deleteMany({ where: { ruleId: id } });
    await prisma.recurrenceRule.delete({ where: { id } });
    return { success: true };
  });

  // Preview: list the consumers who would receive a message from this rule right now
  app.get('/api/merchant/recurrence-rules/:id/eligible', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };

    const rule = await prisma.recurrenceRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });

    const thresholdDays = rule.intervalDays + rule.graceDays;
    const cutoffDate = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);

    // Find consumers whose last INVOICE_CLAIMED was before the cutoff
    let lapsed = await prisma.$queryRaw<Array<{
      account_id: string;
      phone_number: string;
      display_name: string | null;
      cedula: string | null;
      last_visit: Date;
    }>>`
      SELECT a.id AS account_id, a.phone_number, a.display_name, a.cedula, sub.last_visit
      FROM accounts a
      INNER JOIN (
        SELECT account_id, MAX(created_at) AS last_visit
        FROM ledger_entries
        WHERE tenant_id = ${tenantId}::uuid
          AND event_type = 'INVOICE_CLAIMED'
          AND entry_type = 'CREDIT'
          AND status != 'reversed'
        GROUP BY account_id
        HAVING MAX(created_at) < ${cutoffDate}
      ) sub ON sub.account_id = a.id
      WHERE a.tenant_id = ${tenantId}::uuid
        AND a.account_type IN ('shadow', 'verified')
        AND a.phone_number IS NOT NULL
      ORDER BY sub.last_visit ASC
    `;

    // If the rule has a targetPhones list, surface EVERY targeted number
    // with its current status — not just the lapsed subset. Eric 2026-04-24
    // complained that a rule with a specific list still showed "total 0 /
    // ningun cliente califica" with no way to see whether the number was in
    // the list at all. Now the preview returns every targeted phone with
    // the reason why it qualifies / doesn't (califica_ahora, en_periodo,
    // sin_historial, o sin_cuenta).
    const targetPhones = rule.targetPhones || [];
    const hasTargetList = targetPhones.length > 0;

    let consumers: Array<{
      accountId: string | null;
      phoneNumber: string;
      displayName: string | null;
      cedula: string | null;
      lastVisit: string | null;
      daysSince: number | null;
      qualifies: boolean;
      status: 'califica_ahora' | 'en_periodo' | 'sin_historial' | 'sin_cuenta';
      daysUntilQualifies: number | null;
      alreadyNotified: boolean;
      notifiedAt: string | null;
    }>;

    if (hasTargetList) {
      // Look up each targeted phone against the accounts table by last-10-digit tail.
      const targetTails = targetPhones.map(p => ({ raw: p, tail: p.replace(/\D/g, '').slice(-10) }));
      const accountsRaw = await prisma.$queryRaw<Array<{
        account_id: string;
        phone_number: string;
        display_name: string | null;
        cedula: string | null;
        last_visit: Date | null;
      }>>`
        SELECT a.id AS account_id, a.phone_number, a.display_name, a.cedula, sub.last_visit
        FROM accounts a
        LEFT JOIN (
          SELECT account_id, MAX(created_at) AS last_visit
          FROM ledger_entries
          WHERE tenant_id = ${tenantId}::uuid
            AND event_type = 'INVOICE_CLAIMED'
            AND entry_type = 'CREDIT'
            AND status != 'reversed'
          GROUP BY account_id
        ) sub ON sub.account_id = a.id
        WHERE a.tenant_id = ${tenantId}::uuid
          AND a.account_type IN ('shadow', 'verified')
          AND a.phone_number IS NOT NULL
      `;
      const byTail = new Map<string, typeof accountsRaw[number]>();
      for (const a of accountsRaw) byTail.set(a.phone_number.replace(/\D/g, '').slice(-10), a);

      consumers = await Promise.all(targetTails.map(async ({ raw, tail }) => {
        const acc = byTail.get(tail) || null;
        if (!acc) {
          return {
            accountId: null,
            phoneNumber: raw,
            displayName: null,
            cedula: null,
            lastVisit: null,
            daysSince: null,
            qualifies: false,
            status: 'sin_cuenta' as const,
            daysUntilQualifies: null,
            alreadyNotified: false,
            notifiedAt: null,
          };
        }
        const lastVisit = acc.last_visit;
        if (!lastVisit) {
          return {
            accountId: acc.account_id,
            phoneNumber: acc.phone_number,
            displayName: acc.display_name,
            cedula: acc.cedula,
            lastVisit: null,
            daysSince: null,
            qualifies: false,
            status: 'sin_historial' as const,
            daysUntilQualifies: null,
            alreadyNotified: false,
            notifiedAt: null,
          };
        }
        const daysSince = Math.floor((Date.now() - lastVisit.getTime()) / (24 * 60 * 60 * 1000));
        const qualifies = lastVisit < cutoffDate;
        const notified = qualifies
          ? await prisma.recurrenceNotification.findUnique({
              where: {
                tenantId_ruleId_consumerAccountId_lastVisitAt: {
                  tenantId,
                  ruleId: rule.id,
                  consumerAccountId: acc.account_id,
                  lastVisitAt: lastVisit,
                },
              },
              select: { id: true, sentAt: true },
            })
          : null;
        return {
          accountId: acc.account_id,
          phoneNumber: acc.phone_number,
          displayName: acc.display_name,
          cedula: acc.cedula,
          lastVisit: lastVisit.toISOString(),
          daysSince,
          qualifies,
          status: qualifies ? ('califica_ahora' as const) : ('en_periodo' as const),
          daysUntilQualifies: qualifies ? 0 : Math.max(0, thresholdDays - daysSince),
          alreadyNotified: !!notified,
          notifiedAt: notified?.sentAt.toISOString() || null,
        };
      }));
    } else {
      // No targetPhones → preview everyone who has lapsed (original behavior).
      consumers = await Promise.all(lapsed.map(async c => {
        const notified = await prisma.recurrenceNotification.findUnique({
          where: {
            tenantId_ruleId_consumerAccountId_lastVisitAt: {
              tenantId,
              ruleId: rule.id,
              consumerAccountId: c.account_id,
              lastVisitAt: c.last_visit,
            },
          },
          select: { id: true, sentAt: true },
        });
        const daysSince = Math.floor(
          (Date.now() - new Date(c.last_visit).getTime()) / (24 * 60 * 60 * 1000)
        );
        return {
          accountId: c.account_id,
          phoneNumber: c.phone_number,
          displayName: c.display_name,
          cedula: c.cedula,
          lastVisit: c.last_visit.toISOString(),
          daysSince,
          qualifies: true,
          status: 'califica_ahora' as const,
          daysUntilQualifies: 0,
          alreadyNotified: !!notified,
          notifiedAt: notified?.sentAt.toISOString() || null,
        };
      }));
    }

    const qualifyingConsumers = consumers.filter(c => c.qualifies);
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      thresholdDays,
      hasTargetList,
      targetedCount: hasTargetList ? targetPhones.length : null,
      total: qualifyingConsumers.length,
      pending: qualifyingConsumers.filter(c => !c.alreadyNotified).length,
      alreadyNotified: qualifyingConsumers.filter(c => c.alreadyNotified).length,
      consumers,
    };
  });

  // Test affordance: run the engine for ONE rule with intervalDays+graceDays
  // interpreted as MINUTES (not days), so the merchant can verify the message
  // arrives end-to-end without waiting a full day. Eric requested 2026-04-25.
  // Production cron run on the worker is unaffected.
  app.post('/api/merchant/recurrence-rules/:id/test-now', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { id } = request.params as { id: string };
    const rule = await prisma.recurrenceRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });
    if (!rule.active) return reply.status(400).send({ error: 'La regla esta inactiva. Activala antes de probar.' });

    const result = await runRecurrenceEngine({ ruleId: rule.id, thresholdUnit: 'minutes' });
    return {
      success: true,
      thresholdMinutes: rule.intervalDays + rule.graceDays,
      ...result,
    };
  });

  app.get('/api/merchant/recurrence-notifications', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { limit = '50', offset = '0' } = request.query as any;

    const notifications = await prisma.recurrenceNotification.findMany({
      where: { tenantId },
      orderBy: { sentAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
      include: { rule: { select: { name: true } }, consumerAccount: { select: { phoneNumber: true } } },
    });
    return { notifications };
  });
}
