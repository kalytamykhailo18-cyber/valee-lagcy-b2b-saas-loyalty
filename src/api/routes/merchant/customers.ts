import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { upgradeToVerified, phoneTail } from '../../../services/accounts.js';
import { getAccountBalance, getAccountHistory } from '../../../services/ledger.js';
import { requireStaffAuth } from '../../middleware/auth.js';

export async function registerCustomersRoutes(app: FastifyInstance): Promise<void> {
  // ---- CUSTOMER LOOKUP (Cashier + Owner) ----
  // ---- CUSTOMERS LIST (all consumers who have interacted with this merchant) ----
  app.get('/api/merchant/customers', { preHandler: [requireStaffAuth] }, async (request) => {
    const { tenantId } = request.staff!;
    const { limit = '50', offset = '0', search = '' } = request.query as { limit?: string; offset?: string; search?: string };

    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();

    const where: any = {
      tenantId,
      accountType: { in: ['shadow', 'verified'] },
    };
    if (search) {
      where.OR = [
        { phoneNumber: { contains: search } },
        { cedula: { contains: search } },
      ];
    }

    const [accounts, total] = await Promise.all([
      prisma.account.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: lim,
        skip: off,
      }),
      prisma.account.count({ where }),
    ]);

    const customers = await Promise.all(accounts.map(async (acc) => {
      let balance = '0';
      if (assetType) {
        balance = await getAccountBalance(acc.id, assetType.id, tenantId);
      }
      // Invoices can be linked to the account directly (consumer_account_id)
      // OR only carry customer_phone (older CSV rows, before the auto-credit
      // link was added). Match both so older data still shows up.
      const tail = phoneTail(acc.phoneNumber || '');
      const invoiceWhere: any = {
        tenantId,
        OR: [
          { consumerAccountId: acc.id },
          ...(tail.length === 10 ? [{ customerPhone: { endsWith: tail } }] : []),
        ],
      };
      const invoiceCount = await prisma.invoice.count({ where: invoiceWhere });
      const lastInvoice = await prisma.invoice.findFirst({
        where: invoiceWhere,
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, invoiceNumber: true, amount: true, status: true },
      });

      return {
        id: acc.id,
        phoneNumber: acc.phoneNumber,
        accountType: acc.accountType,
        cedula: acc.cedula,
        level: acc.level,
        balance,
        invoiceCount,
        lastInvoice: lastInvoice ? {
          invoiceNumber: lastInvoice.invoiceNumber,
          amount: lastInvoice.amount.toString(),
          status: lastInvoice.status,
          date: lastInvoice.createdAt,
        } : null,
        createdAt: acc.createdAt,
      };
    }));

    return { customers, total, unitLabel: assetType?.unitLabel || 'pts' };
  });

  app.get('/api/merchant/customer-lookup/:phoneNumber', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { phoneNumber } = request.params as { phoneNumber: string };

    const account = await prisma.account.findUnique({
      where: { tenantId_phoneNumber: { tenantId, phoneNumber } },
    });

    if (!account) return reply.status(404).send({ error: 'Customer not found' });

    const assetType = await prisma.assetType.findFirst();
    const balance = assetType ? await getAccountBalance(account.id, assetType.id, tenantId) : '0';
    const history = await getAccountHistory(account.id, tenantId, 20);

    // Audit
    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, consumer_account_id, outcome, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${request.staff!.staffId}::uuid, 'staff',
        ${request.staff!.role}::"AuditActorRole", 'CUSTOMER_LOOKUP', ${account.id}::uuid, 'success', now())
    `;

    // Get invoice submission history — match by linked account OR by phone
    // tail so CSV rows without consumer_account_id still surface.
    const tail = phoneTail(account.phoneNumber || '');
    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId,
        OR: [
          { consumerAccountId: account.id },
          ...(tail.length === 10 ? [{ customerPhone: { endsWith: tail } }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: { branch: { select: { id: true, name: true } } },
      take: 20,
    });

    // Currency display: tenant invoices are stored in Bs but the merchant
    // reads dollars or euros depending on their preferred exchange source.
    // Compute one representative rate per invoice using the transactionDate
    // (or upload date) so the display matches the value at the time of sale.
    const tenantForCurrency = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { preferredExchangeSource: true, referenceCurrency: true },
    });
    const refCurrency = tenantForCurrency?.referenceCurrency || 'usd';
    const currencySymbol = refCurrency === 'eur' ? '€' : '$';
    const exchangeSource = tenantForCurrency?.preferredExchangeSource || null;
    const { getRateAtDate } = await import('../../../services/exchange-rates.js');

    const invoicesOut = await Promise.all(invoices.map(async (i) => {
      let normalizedAmount: string | null = null;
      if (exchangeSource && refCurrency) {
        const date = i.transactionDate || i.createdAt;
        const rate = await getRateAtDate(exchangeSource as any, refCurrency as any, date);
        if (rate && rate.rateBs > 0) {
          normalizedAmount = (Number(i.amount) / rate.rateBs).toFixed(2);
        }
      }
      return {
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        amount: i.amount.toString(),                        // raw Bs
        amountInReference: normalizedAmount,                 // converted (may be null if no rate)
        currencySymbol,                                      // $ or €
        status: i.status,
        transactionDate: i.transactionDate,
        uploadedAt: i.createdAt,
        createdAt: i.createdAt,
        branch: i.branch ? { id: i.branch.id, name: i.branch.name } : null,
      };
    }));

    return {
      account: {
        id: account.id,
        phoneNumber: account.phoneNumber,
        displayName: account.displayName,
        accountType: account.accountType,
        cedula: account.cedula,
        level: account.level,
        createdAt: account.createdAt,
      },
      balance,
      currencySymbol,
      history: history.map(e => ({
        id: e.id,
        eventType: e.eventType,
        entryType: e.entryType,
        amount: e.amount.toString(),
        status: e.status,
        createdAt: e.createdAt,
      })),
      invoices: invoicesOut,
    };
  });

  // ---- IDENTITY UPGRADE (Cashier + Owner) ----
  app.post('/api/merchant/identity-upgrade', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { phoneNumber, cedula: rawCedula, force } = request.body as { phoneNumber: string; cedula: string; force?: boolean };

    if (!phoneNumber || !rawCedula) {
      return reply.status(400).send({ error: 'phoneNumber and cedula are required' });
    }

    // Venezuelan cedula normalization + validation. Accept with or without
    // V/E prefix and with or without separator; reject anything else.
    // Genesis flagged merchants saving garbage values like 'sssss' or
    // '21123456FFFFF' because the endpoint stored whatever came in.
    const cedulaMatch = String(rawCedula)
      .toUpperCase()
      .replace(/\s+/g, '')
      .match(/^([VE])?-?(\d{6,10})$/);
    if (!cedulaMatch) {
      return reply.status(400).send({
        error: 'Cedula invalida. Formato: V-XXXXXXXX o E-XXXXXXXX (6 a 10 digitos)',
      });
    }
    const cedulaPrefix = cedulaMatch[1] || 'V';
    const cedula = `${cedulaPrefix}-${cedulaMatch[2]}`;

    const account = await prisma.account.findUnique({
      where: { tenantId_phoneNumber: { tenantId, phoneNumber } },
    });

    if (!account) return reply.status(404).send({ error: 'Customer not found' });
    if (account.accountType === 'verified') {
      return reply.status(400).send({ error: 'Account is already verified' });
    }

    // Check if cedula is already linked to another phone
    const existing = await prisma.account.findUnique({
      where: { tenantId_cedula: { tenantId, cedula } },
    });

    if (existing && existing.id !== account.id) {
      if (!force) {
        return reply.status(409).send({
          error: 'This cedula is already linked to another phone number',
          existingPhone: existing.phoneNumber,
          requiresConfirmation: true,
        });
      }
      // Force-override: unlink the cedula from the previous account
      await prisma.account.update({
        where: { id: existing.id },
        data: { cedula: null },
      });
      await prisma.$executeRaw`
        INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, consumer_account_id, outcome, metadata, created_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff',
          ${request.staff!.role}::"AuditActorRole", 'IDENTITY_UPGRADE', ${existing.id}::uuid, 'success',
          ${JSON.stringify({ action: 'cedula_unlinked_for_override', cedula, transferredTo: account.id })}::jsonb, now())
      `;
    }

    const upgraded = await upgradeToVerified(account.id, tenantId, cedula);

    await prisma.$executeRaw`
      INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, consumer_account_id, outcome, metadata, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff',
        ${request.staff!.role}::"AuditActorRole", 'IDENTITY_UPGRADE', ${account.id}::uuid, 'success',
        ${JSON.stringify({ cedula, forced: !!force })}::jsonb, now())
    `;

    return { success: true, account: { id: upgraded.id, accountType: upgraded.accountType, cedula: upgraded.cedula } };
  });

  // ---- UPDATE CUSTOMER DATA (displayName, cedula) ----
  app.patch('/api/merchant/customers/:id', { preHandler: [requireStaffAuth] }, async (request, reply) => {
    const { tenantId, staffId } = request.staff!;
    const { id } = request.params as { id: string };
    const { displayName, cedula } = request.body as { displayName?: string | null; cedula?: string | null };

    const account = await prisma.account.findFirst({
      where: { id, tenantId, accountType: { in: ['shadow', 'verified'] } },
    });
    if (!account) return reply.status(404).send({ error: 'Cliente no encontrado' });

    const updates: { displayName?: string | null; cedula?: string | null } = {};

    if (displayName !== undefined) {
      const trimmed = displayName ? displayName.trim() : null;
      updates.displayName = trimmed || null;
    }

    if (cedula !== undefined) {
      if (cedula === null || cedula === '') {
        updates.cedula = null;
      } else {
        // Venezuelan cedula: optional V/E prefix + 6-10 digits. Reject
        // garbage like 'sssss' or '21123456FFFFF' that the old
        // whitespace-strip-only normalization was letting through.
        const m = String(cedula).toUpperCase().replace(/\s+/g, '').match(/^([VE])?-?(\d{6,10})$/);
        if (!m) {
          return reply.status(400).send({
            error: 'Cedula invalida. Formato: V-XXXXXXXX o E-XXXXXXXX (6 a 10 digitos)',
          });
        }
        const normalized = `${m[1] || 'V'}-${m[2]}`;
        // Check cedula isn't already linked to a different account in this tenant
        const conflict = await prisma.account.findFirst({
          where: { tenantId, cedula: normalized, NOT: { id } },
          select: { id: true, phoneNumber: true },
        });
        if (conflict) {
          return reply.status(409).send({
            error: 'Esta cedula ya esta vinculada a otro cliente',
            existingPhone: conflict.phoneNumber,
          });
        }
        updates.cedula = normalized;
      }
    }

    const updated = await prisma.account.update({
      where: { id },
      data: updates,
    });

    try {
      await prisma.$executeRaw`
        INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_role, action_type, consumer_account_id, outcome, metadata, created_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${staffId}::uuid, 'staff',
          ${request.staff!.role}::"AuditActorRole", 'CUSTOMER_LOOKUP', ${id}::uuid, 'success',
          ${JSON.stringify({ action: 'customer_edit', updates })}::jsonb, now())
      `;
    } catch (err) {
      console.error('[Audit] customer edit log failed:', err);
    }

    return {
      success: true,
      account: {
        id: updated.id,
        phoneNumber: updated.phoneNumber,
        displayName: updated.displayName,
        cedula: updated.cedula,
        accountType: updated.accountType,
      },
    };
  });
}
