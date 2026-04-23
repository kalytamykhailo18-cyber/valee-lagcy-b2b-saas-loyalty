import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { normalizeVenezuelanPhone } from '../../../services/accounts.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

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

    // If the rule has a targetPhones list, restrict to those (compare last 10 digits)
    if (rule.targetPhones && rule.targetPhones.length > 0) {
      const targetTails = new Set(rule.targetPhones.map(p => p.replace(/\D/g, '').slice(-10)));
      lapsed = lapsed.filter(c => targetTails.has(c.phone_number.replace(/\D/g, '').slice(-10)));
    }

    // Check which ones have already been notified for their current absence event
    const consumers = await Promise.all(lapsed.map(async c => {
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
        alreadyNotified: !!notified,
        notifiedAt: notified?.sentAt.toISOString() || null,
      };
    }));

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      thresholdDays,
      total: consumers.length,
      pending: consumers.filter(c => !c.alreadyNotified).length,
      alreadyNotified: consumers.filter(c => c.alreadyNotified).length,
      consumers,
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
