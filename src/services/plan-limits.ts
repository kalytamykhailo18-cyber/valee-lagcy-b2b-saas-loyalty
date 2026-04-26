/**
 * Plan Tier Limits
 *
 * Three tiers (basic / pro / x10) define usage caps that are enforced at the
 * API level. Each limited operation calls `enforceLimit` before performing the
 * action; if the tenant has exceeded the cap for the current month, a 402
 * Payment Required is returned.
 *
 * Limits are counted from the audit_log + ledger_entries (existing tables) so
 * no separate counter table is needed. Counts always reset on the first day of
 * each calendar month.
 */

import prisma from '../db/client.js';
import type { PlanTier } from '@prisma/client';

export type LimitedAction =
  | 'flash_offers'
  | 'whatsapp_messages'
  | 'products_in_catalog'
  | 'staff_members'
  | 'csv_uploads';

interface PlanConfig {
  flash_offers: number;
  whatsapp_messages: number;
  products_in_catalog: number;
  staff_members: number;
  csv_uploads: number;
}

const PLAN_LIMITS: Record<PlanTier, PlanConfig> = {
  basic: {
    flash_offers: 5,
    whatsapp_messages: 200,
    products_in_catalog: 20,
    // Eric 2026-04-25: bumped 3 → 10 so a small comercio with multiple
    // sucursales can fit its cashiers without immediately needing to upgrade.
    staff_members: 10,
    csv_uploads: 30,
  },
  pro: {
    flash_offers: 50,
    whatsapp_messages: 2000,
    products_in_catalog: 200,
    staff_members: 15,
    csv_uploads: 300,
  },
  x10: {
    flash_offers: 1_000_000,
    whatsapp_messages: 1_000_000,
    products_in_catalog: 1_000_000,
    staff_members: 1_000_000,
    csv_uploads: 1_000_000,
  },
};

function startOfMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * Get the current usage count for a given action for a given tenant in the
 * current calendar month.
 */
export async function getUsage(tenantId: string, action: LimitedAction): Promise<number> {
  const since = startOfMonth();

  switch (action) {
    case 'flash_offers': {
      // Flash offers are a planned feature; counter reads from a future flash_offers
      // table or audit_log entry. For now, return 0 — the limit is still enforced as
      // a hard cap once that feature ships and starts emitting events.
      return 0;
    }

    case 'whatsapp_messages': {
      // Count recurrence notifications + manual sends this month
      const r = await prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count FROM recurrence_notifications
        WHERE tenant_id = ${tenantId}::uuid
          AND sent_at >= ${since}
      `;
      return Number(r[0].count);
    }

    case 'products_in_catalog': {
      // Total products (active + inactive); the limit is on catalog size, not new this month
      const r = await prisma.product.count({ where: { tenantId } });
      return r;
    }

    case 'staff_members': {
      // Total active CASHIERS; owners aren't counted toward the plan cap
      // (Eric 2026-04-25). The owner is implicit per tenant; consuming a
      // staff slot for them was inflating usage by 1 on every comercio.
      const r = await prisma.staff.count({ where: { tenantId, active: true, role: { not: 'owner' } } });
      return r;
    }

    case 'csv_uploads': {
      const r = await prisma.uploadBatch.count({
        where: { tenantId, createdAt: { gte: since } },
      });
      return r;
    }
  }
}

/**
 * Returns the limit for a given tenant and action based on their plan.
 */
export async function getLimit(tenantId: string, action: LimitedAction): Promise<number> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return 0;
  return PLAN_LIMITS[tenant.plan][action];
}

/**
 * Check if a tenant is at or over their limit for a given action.
 * Returns { allowed: true } if there's room, { allowed: false, ... } if not.
 */
export async function checkLimit(tenantId: string, action: LimitedAction): Promise<{
  allowed: boolean;
  current: number;
  limit: number;
  plan: PlanTier;
}> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return { allowed: false, current: 0, limit: 0, plan: 'basic' };
  const limit = PLAN_LIMITS[tenant.plan][action];
  const current = await getUsage(tenantId, action);
  return { allowed: current < limit, current, limit, plan: tenant.plan };
}

/**
 * Throws a structured error if the tenant has exceeded their limit. The caller
 * should catch this and return a 402 Payment Required to the client.
 */
export async function enforceLimit(tenantId: string, action: LimitedAction): Promise<void> {
  const check = await checkLimit(tenantId, action);
  if (!check.allowed) {
    // Spanish copy because this error bubbles up to the merchant UI as
    // a toast (Genesis QA item 9). Frontend renders e.error verbatim.
    const actionLabels: Record<string, string> = {
      products_in_catalog: 'productos en tu catalogo',
      hybrid_offers: 'promociones hibridas',
      flash_offers: 'ofertas flash este mes',
      whatsapp_messages: 'mensajes de WhatsApp este mes',
      csv_uploads: 'cargas de CSV este mes',
      staff_members: 'miembros del personal',
    };
    const label = actionLabels[action] || action;
    const err: any = new Error(
      `Ya alcanzaste el maximo de ${label} (${check.current}/${check.limit}) en el plan ${check.plan}. Actualiza el plan para crear mas.`
    );
    err.code = 'PLAN_LIMIT_EXCEEDED';
    err.statusCode = 402;
    err.usage = check;
    throw err;
  }
}

/**
 * Get a complete usage summary for a tenant — used in the merchant dashboard.
 */
export async function getUsageSummary(tenantId: string): Promise<{
  plan: PlanTier;
  usage: Record<LimitedAction, { current: number; limit: number; percent: number }>;
}> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error('tenant not found');

  const actions: LimitedAction[] = ['flash_offers', 'whatsapp_messages', 'products_in_catalog', 'staff_members', 'csv_uploads'];
  const usage: any = {};
  for (const action of actions) {
    const limit = PLAN_LIMITS[tenant.plan][action];
    const current = await getUsage(tenantId, action);
    usage[action] = {
      current,
      limit,
      percent: limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0,
    };
  }
  return { plan: tenant.plan, usage };
}

export { PLAN_LIMITS };
