/**
 * Customer Recurrence Engine.
 * Detects consumers who haven't returned within their expected interval
 * and automatically re-engages them via WhatsApp with optional bonus points.
 *
 * Uses: RECONCILIATION_WINDOW_HOURS from .env for default scheduling.
 * Merchant configures rules via recurrence_rules table.
 */

import prisma from '../db/client.js';
import { writeDoubleEntry } from './ledger.js';
import { getSystemAccount } from './accounts.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { sendTemplateMessage } from './whatsapp-templates.js';

export interface RecurrenceResult {
  notified: number;
  bonusesGranted: number;
  skipped: number;
}

/**
 * Run the recurrence engine for all active tenants and rules.
 */
export async function runRecurrenceEngine(): Promise<RecurrenceResult> {
  const rules = await prisma.recurrenceRule.findMany({
    where: { active: true },
    include: { tenant: true },
  });

  let notified = 0;
  let bonusesGranted = 0;
  let skipped = 0;

  for (const rule of rules) {
    if (rule.tenant.status !== 'active') continue;

    const thresholdDays = rule.intervalDays + rule.graceDays;
    const cutoffDate = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);

    // Find consumers whose last INVOICE_CLAIMED was before the cutoff
    let lapsedConsumers = await prisma.$queryRaw<Array<{
      account_id: string;
      phone_number: string;
      last_visit: Date;
    }>>`
      SELECT a.id AS account_id, a.phone_number, sub.last_visit
      FROM accounts a
      INNER JOIN (
        SELECT account_id, MAX(created_at) AS last_visit
        FROM ledger_entries
        WHERE tenant_id = ${rule.tenantId}::uuid
          AND event_type = 'INVOICE_CLAIMED'
          AND entry_type = 'CREDIT'
          AND status != 'reversed'
        GROUP BY account_id
        HAVING MAX(created_at) < ${cutoffDate}
      ) sub ON sub.account_id = a.id
      WHERE a.tenant_id = ${rule.tenantId}::uuid
        AND a.account_type IN ('shadow', 'verified')
        AND a.phone_number IS NOT NULL
    `;

    // If the rule has a targetPhones list (group), restrict to those numbers only
    if (rule.targetPhones && rule.targetPhones.length > 0) {
      const targetTails = new Set(rule.targetPhones.map(p => p.replace(/\D/g, '').slice(-10)));
      lapsedConsumers = lapsedConsumers.filter(c =>
        targetTails.has(c.phone_number.replace(/\D/g, '').slice(-10))
      );
    }

    for (const consumer of lapsedConsumers) {
      const daysSince = Math.floor(
        (Date.now() - new Date(consumer.last_visit).getTime()) / (24 * 60 * 60 * 1000)
      );

      // Check if already notified for this absence event
      const alreadySent = await prisma.recurrenceNotification.findUnique({
        where: {
          tenantId_ruleId_consumerAccountId_lastVisitAt: {
            tenantId: rule.tenantId,
            ruleId: rule.id,
            consumerAccountId: consumer.account_id,
            lastVisitAt: consumer.last_visit,
          },
        },
      });

      if (alreadySent) {
        skipped++;
        continue;
      }

      // Build message from template (used as fallback text)
      const message = rule.messageTemplate
        .replace('{name}', consumer.phone_number)
        .replace('{days}', daysSince.toString())
        .replace('{bonus}', rule.bonusAmount ? Number(rule.bonusAmount).toString() : '');

      // Recurrence messages are PROACTIVE — typically outside the 24h customer service window.
      // Try the Meta-approved template first, fall back to plain text if it fails.
      const sent = await sendTemplateMessage('recurrence_reminder', consumer.phone_number, {
        name: consumer.phone_number,
        daysSince,
        bonus: rule.bonusAmount ? Number(rule.bonusAmount) : 0,
      }, 'auto');

      // If both template and fallback failed, fall back to the merchant's custom message
      if (!sent) {
        await sendWhatsAppMessage(consumer.phone_number, message);
      }

      // Grant bonus if configured
      let ledgerEntryId: string | null = null;
      let bonusGrantedFlag = false;

      if (rule.bonusAmount && Number(rule.bonusAmount) > 0) {
        const poolAccount = await getSystemAccount(rule.tenantId, 'issued_value_pool');
        if (poolAccount) {
          // Get the first asset type for this tenant
          const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId: rule.tenantId } });
          const assetType = assetConfig
            ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
            : await prisma.assetType.findFirst();

          if (assetType) {
            const ledgerResult = await writeDoubleEntry({
              tenantId: rule.tenantId,
              eventType: 'ADJUSTMENT_MANUAL',
              debitAccountId: poolAccount.id,
              creditAccountId: consumer.account_id,
              amount: Number(rule.bonusAmount).toFixed(8),
              assetTypeId: assetType.id,
              referenceId: `RECURRENCE-${rule.id}-${consumer.account_id}-${consumer.last_visit.toISOString().slice(0, 10)}`,
              referenceType: 'manual_adjustment',
              metadata: { type: 'recurrence_bonus', ruleId: rule.id, daysSinceVisit: daysSince },
            });
            ledgerEntryId = ledgerResult.credit.id;
            bonusGrantedFlag = true;
            bonusesGranted++;
          }
        }
      }

      // Record the notification
      await prisma.recurrenceNotification.create({
        data: {
          tenantId: rule.tenantId,
          ruleId: rule.id,
          consumerAccountId: consumer.account_id,
          lastVisitAt: consumer.last_visit,
          daysSinceVisit: daysSince,
          messageSent: message,
          bonusGranted: bonusGrantedFlag,
          ledgerEntryId,
        },
      });

      notified++;
    }
  }

  return { notified, bonusesGranted, skipped };
}
