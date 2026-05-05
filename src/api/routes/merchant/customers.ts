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
      // Eric 2026-05-05 (Notion "Buscador panel clientes"): two bugs
      //   1. nombre no procesaba — falta el clause sobre displayName
      //   2. tipear "0424..." (formato local VE) no encontraba al cliente
      //      porque la DB guarda "+58424..." canonico. Normalizamos a
      //      tail-digits (sin 0 inicial) y buscamos tambien por ese
      //      sufijo, asi "0424", "424", y "+58424" matchean la misma
      //      cuenta.
      const digits = search.replace(/\D/g, '');
      const tail = digits.startsWith('0') ? digits.slice(1) : digits;
      const orClauses: any[] = [
        { phoneNumber: { contains: search } },
        { cedula: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ];
      if (tail && tail.length >= 3 && tail !== search) {
        orClauses.push({ phoneNumber: { contains: tail } });
      }
      where.OR = orClauses;
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
        select: { createdAt: true, invoiceNumber: true, amount: true, status: true, extractedData: true },
      });

      // Eric 2026-05-05 (Notion "Panel Clientes" correccion): when the
      // account has no displayName but the receipt OCR captured a
      // customer_name, surface it as a fallback so PWA-only consumers
      // submitted before the displayName-from-receipt fix still show a
      // name in the list. The merchant flow (verify, edit) keeps writing
      // to acc.displayName, so this is just a soft fallback for legacy
      // rows.
      let effectiveDisplayName: string | null = acc.displayName || null;
      if (!effectiveDisplayName && lastInvoice?.extractedData) {
        const ed: any = lastInvoice.extractedData;
        if (typeof ed.customer_name === 'string' && ed.customer_name.trim()) {
          effectiveDisplayName = ed.customer_name.trim();
        }
      }

      return {
        id: acc.id,
        phoneNumber: acc.phoneNumber,
        // Eric 2026-05-04 (Notion "Panel de clientes Nota 1"): the
        // WhatsApp profile name is captured at first contact. Surface
        // it on the list row so the comercio doesn't only see phones.
        displayName: effectiveDisplayName,
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
      // Eric 2026-05-04: clicking an invoice row should reveal the
      // OCR'd line items (name, quantity, unit_price). Persisted on
      // invoice.orderDetails.items by invoice-validation.ts.
      // Eric 2026-05-05: fall back to extracted_data.order_items when
      // order_details is null (provisional rows submitted before the
      // createPendingValidation fix saved items in only extractedData).
      const orderDetails: any = (i as any).orderDetails || null;
      const extractedData: any = (i as any).extractedData || null;
      let rawItems: any[] | null = null;
      if (orderDetails && Array.isArray(orderDetails.items)) rawItems = orderDetails.items;
      else if (extractedData && Array.isArray(extractedData.order_items)) rawItems = extractedData.order_items;
      const items: Array<{ name: string; quantity: number; unitPrice: number }> | null =
        rawItems && rawItems.length > 0
          ? rawItems.map((it: any) => ({
              name: String(it?.name || ''),
              quantity: Number(it?.quantity ?? 1),
              unitPrice: Number(it?.unit_price ?? it?.unitPrice ?? 0),
            }))
          : null;
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
        items,
      };
    }));

    // Branch enrichment: for each REDEMPTION_PENDING in the history, look
    // up the matching CONFIRMED leg's branch_id (the canonical "where the
    // canje was scanned"). PENDING's own branch_id reflects QR generation
    // context, often null. Eric 2026-04-26: customer panel MOVIMIENTOS
    // wasn't naming the sucursal at all.
    //
    // Also track which tokens have an EXPIRED row in the ledger. The
    // transactions panel collapses expired-only pairs so the merchant
    // doesn't see "REDEMPTION_PENDING -3000 / REDEMPTION_EXPIRED +3000"
    // for a canje the consumer cancelled. Eric 2026-05-04 (Notion
    // "Panel de clientes Nota 2"): the customer-detail panel must
    // behave the same way.
    const pendingTokenIdsInHistory: string[] = [];
    for (const e of history) {
      if (e.eventType !== 'REDEMPTION_PENDING' && e.eventType !== 'REDEMPTION_EXPIRED') continue;
      const m = String(e.referenceId || '').match(/^(REDEEM|EXPIRED)-([0-9a-f-]{36})$/i);
      if (m) pendingTokenIdsInHistory.push(m[2]);
    }
    const branchByTokenId = new Map<string, { id: string | null; name: string | null }>();
    const confirmedTokenIds = new Set<string>();
    const expiredTokenIds = new Set<string>();
    for (const e of history) {
      if (e.eventType !== 'REDEMPTION_EXPIRED') continue;
      const m = String(e.referenceId || '').match(/^EXPIRED-([0-9a-f-]{36})$/i);
      if (m) expiredTokenIds.add(m[1]);
    }
    if (pendingTokenIdsInHistory.length > 0) {
      const confirmedRows = await prisma.$queryRaw<Array<{ token_id: string; branch_id: string | null; branch_name: string | null }>>`
        SELECT
          REPLACE(le.reference_id, 'CONFIRMED-', '') AS token_id,
          le.branch_id,
          b.name AS branch_name
        FROM ledger_entries le
        LEFT JOIN branches b ON b.id = le.branch_id
        WHERE le.tenant_id = ${tenantId}::uuid
          AND le.event_type = 'REDEMPTION_CONFIRMED'
          AND le.entry_type = 'CREDIT'
          AND le.reference_id = ANY(${pendingTokenIdsInHistory.map(id => `CONFIRMED-${id}`)}::text[])
      `;
      for (const row of confirmedRows) {
        branchByTokenId.set(row.token_id, { id: row.branch_id, name: row.branch_name });
        confirmedTokenIds.add(row.token_id);
      }
    }
    // For non-redemption history rows, fall back to the row's own branch.
    // We need to fetch the branch name for non-null branchIds in the history.
    const branchIdsInHistory = Array.from(new Set(
      history.map(e => e.branchId).filter((id): id is string => !!id)
    ));
    const branchNameById = new Map<string, string>();
    if (branchIdsInHistory.length > 0) {
      const branches = await prisma.branch.findMany({
        where: { tenantId, id: { in: branchIdsInHistory } },
        select: { id: true, name: true },
      });
      for (const b of branches) branchNameById.set(b.id, b.name);
    }

    // Eric 2026-05-04 (Notion "Bienvenida / Referidos. Clientes"): the
    // MOVIMIENTOS panel was rendering raw event types (PRESENCE_VALIDATED,
    // REDEMPTION_PENDING) — developer-facing strings the merchant should
    // never see. Mirror the effective-event-type derivation already in
    // analytics.ts and consumer/account.ts:
    //   ADJUSTMENT_MANUAL + WELCOME-…   → WELCOME_BONUS
    //   ADJUSTMENT_MANUAL + REFERRAL-…  → REFERRAL_BONUS
    //   REDEMPTION_PENDING (confirmed)   → REDEMPTION_CONFIRMED
    // and resolve the human context per row (invoice number + $, product
    // name, "Pago en efectivo") so the panel reads like a transaction log.

    // Build invoice lookup for INVOICE_CLAIMED rows in history. The
    // referenceId is one of: <invoiceNumber>, PENDING-<n>, REVIEW-<n>,
    // CSV-<actor>:<n>. Strip the prefix to get the canonical number.
    const invoiceNumberFromRef = (refId: string | null | undefined): string | null => {
      if (!refId) return null;
      return String(refId).replace(/^(REVIEW|PENDING|CSV-[^:]+:)-?/i, '') || null;
    };
    const historyInvoiceNumbers = new Set<string>();
    for (const e of history) {
      if (e.eventType !== 'INVOICE_CLAIMED') continue;
      const meta: any = (e as any).metadata || {};
      const num = meta.invoiceNumber || invoiceNumberFromRef(e.referenceId);
      if (num) historyInvoiceNumbers.add(num);
    }
    const invoicesByNumber = new Map<string, { amount: string; transactionDate: Date | null; createdAt: Date; orderDetails: any; extractedData: any }>();
    if (historyInvoiceNumbers.size > 0) {
      const invs = await prisma.invoice.findMany({
        where: { tenantId, invoiceNumber: { in: Array.from(historyInvoiceNumbers) } },
        select: { invoiceNumber: true, amount: true, transactionDate: true, createdAt: true, orderDetails: true, extractedData: true },
      });
      for (const i of invs) {
        invoicesByNumber.set(i.invoiceNumber, {
          amount: i.amount.toString(),
          transactionDate: i.transactionDate,
          createdAt: i.createdAt,
          orderDetails: i.orderDetails,
          extractedData: i.extractedData,
        });
      }
    }

    // Eric 2026-05-04 (Notion "Productos / Niveles"): backfill product
    // description for legacy redemption rows whose metadata predates the
    // description stamp. One batched lookup keyed off metadata.productId.
    const historyProductIds = new Set<string>();
    for (const e of history) {
      const meta: any = (e as any).metadata || {};
      if (meta.productId && !meta.productDescription) historyProductIds.add(meta.productId);
    }
    const productDescById = new Map<string, string | null>();
    if (historyProductIds.size > 0) {
      const prods = await prisma.product.findMany({
        where: { tenantId, id: { in: Array.from(historyProductIds) } },
        select: { id: true, description: true },
      });
      for (const p of prods) productDescById.set(p.id, p.description);
    }

    // Spanish labels — match the canonical map in merchant/page.tsx and
    // consumer/page.tsx so the customer detail panel speaks the same
    // language as the rest of the merchant UI.
    const labelFor = (effectiveEventType: string, status: string): string => {
      switch (effectiveEventType) {
        case 'INVOICE_CLAIMED': return status === 'provisional' ? 'Factura validada (provisional)' : 'Factura validada';
        case 'WELCOME_BONUS': return 'Puntos de Bienvenida';
        case 'REFERRAL_BONUS': return 'Bono por Referido';
        case 'PRESENCE_VALIDATED': return 'Pago en efectivo';
        case 'REDEMPTION_PENDING': return 'Canje pendiente';
        case 'REDEMPTION_CONFIRMED': return 'Canje confirmado';
        case 'REDEMPTION_EXPIRED': return 'Canje expirado';
        case 'REVERSAL': return 'Reverso';
        case 'ADJUSTMENT_MANUAL': return 'Ajuste manual';
        case 'TRANSFER_P2P': return 'Transferencia';
        default: return effectiveEventType;
      }
    };

    // Filter expired-only redemption pairs (PENDING + EXPIRED with no
    // matching CONFIRMED). Eric 2026-05-04 (Notion "Panel de clientes
    // Nota 2"): a cancelled QR is net-zero noise — both legs hidden,
    // matching the merchant transactions panel collapse rule.
    const filteredHistory = history.filter(e => {
      const refStr = String(e.referenceId || '');
      const m = refStr.match(/^(REDEEM|EXPIRED|CONFIRMED)-([0-9a-f-]{36})$/i);
      if (!m) return true;
      const tid = m[2];
      // Expired-only: hide both legs.
      if (expiredTokenIds.has(tid) && !confirmedTokenIds.has(tid)) return false;
      // Confirmed: drop the system-side CONFIRMED row, keep PENDING (relabeled).
      if (e.eventType === 'REDEMPTION_CONFIRMED' && confirmedTokenIds.has(tid)) return false;
      return true;
    });

    const enrichedHistory = await Promise.all(filteredHistory.map(async (e) => {
      const meta: any = (e as any).metadata || {};
      const refStr = String(e.referenceId || '');

      // Effective event type
      let effectiveEventType: string = e.eventType;
      if (e.eventType === 'ADJUSTMENT_MANUAL') {
        if (refStr.startsWith('WELCOME-') || meta?.type === 'welcome_bonus') {
          effectiveEventType = 'WELCOME_BONUS';
        } else if (refStr.startsWith('REFERRAL-') || meta?.type === 'referral_bonus') {
          effectiveEventType = 'REFERRAL_BONUS';
        }
      }
      // Confirmed pendings collapse to REDEMPTION_CONFIRMED (Genesis M6).
      if (e.eventType === 'REDEMPTION_PENDING') {
        const m = refStr.match(/^REDEEM-([0-9a-f-]{36})$/i);
        const tid = m ? m[1] : null;
        if (tid && confirmedTokenIds.has(tid)) effectiveEventType = 'REDEMPTION_CONFIRMED';
      }

      // Branch
      let branchId: string | null = e.branchId ?? null;
      let branchName: string | null = branchId ? (branchNameById.get(branchId) ?? null) : null;
      if (e.eventType === 'REDEMPTION_PENDING') {
        const m = refStr.match(/^REDEEM-([0-9a-f-]{36})$/i);
        const tid = m ? m[1] : null;
        const confirmed = tid ? branchByTokenId.get(tid) : undefined;
        if (confirmed && confirmed.id) {
          branchId = confirmed.id;
          branchName = confirmed.name;
        }
      }

      // Subtitle: invoice context, product context, or cash marker.
      let subtitle: string | null = null;
      let invoiceNumber: string | null = null;
      let invoiceAmountInReference: string | null = null;
      let productName: string | null = meta.productName || null;
      let productDescription: string | null = meta.productDescription
        || (meta.productId ? (productDescById.get(meta.productId) || null) : null);
      let productPhotoUrl: string | null = meta.productPhotoUrl || null;
      let cashAmountInReference: string | null = null;
      let items: Array<{ name: string; quantity: number; unitPrice: number }> | null = null;

      if (e.eventType === 'INVOICE_CLAIMED') {
        invoiceNumber = meta.invoiceNumber || invoiceNumberFromRef(refStr);
        const inv = invoiceNumber ? invoicesByNumber.get(invoiceNumber) : null;
        if (inv && exchangeSource && refCurrency) {
          const date = inv.transactionDate || inv.createdAt;
          const rate = await getRateAtDate(exchangeSource as any, refCurrency as any, date);
          if (rate && rate.rateBs > 0) {
            invoiceAmountInReference = (Number(inv.amount) / rate.rateBs).toFixed(2);
          }
        }
        // Eric 2026-05-05: order_details is the canonical source but
        // provisional rows submitted before the createPendingValidation
        // fix only have extracted_data.order_items — fall back so the
        // panel still reveals items for those rows.
        let rawItems: any[] | null = null;
        if (inv?.orderDetails && Array.isArray(inv.orderDetails.items)) rawItems = inv.orderDetails.items;
        else if (inv?.extractedData && Array.isArray((inv.extractedData as any).order_items)) rawItems = (inv.extractedData as any).order_items;
        if (rawItems && rawItems.length > 0) {
          items = rawItems.map((it: any) => ({
            name: String(it?.name || ''),
            quantity: Number(it?.quantity ?? 1),
            unitPrice: Number(it?.unit_price ?? it?.unitPrice ?? 0),
          }));
        }
        if (invoiceNumber && invoiceAmountInReference) {
          subtitle = `Factura ${invoiceNumber} · ${currencySymbol}${invoiceAmountInReference}`;
        } else if (invoiceNumber) {
          subtitle = `Factura ${invoiceNumber}`;
        }
      } else if (e.eventType === 'PRESENCE_VALIDATED') {
        // Cash payment via dual-scan stamps source='dual_scan' +
        // originalAmount (the bill total in the tenant's reference
        // currency, already $ or €). No invoice number — items can't be
        // OCR'd from a cash transaction.
        if (meta.source === 'dual_scan' && meta.originalAmount) {
          cashAmountInReference = String(meta.originalAmount);
          subtitle = `Pago en efectivo · ${currencySymbol}${meta.originalAmount}`;
        } else {
          subtitle = 'Pago en efectivo';
        }
      } else if (effectiveEventType === 'REDEMPTION_PENDING' || effectiveEventType === 'REDEMPTION_CONFIRMED' || effectiveEventType === 'REDEMPTION_EXPIRED') {
        // Eric 2026-05-04: include product description so merchants with
        // multiple Pizza/Refresco variants can tell rows apart at a glance
        // ("Pizza familiar — Tamano grande" vs "Pizza familiar — Pequena").
        if (productName) {
          subtitle = productDescription
            ? `${productName} — ${productDescription}`
            : productName;
        }
      } else if (effectiveEventType === 'WELCOME_BONUS') {
        subtitle = 'Bienvenida al programa';
      } else if (effectiveEventType === 'REFERRAL_BONUS') {
        subtitle = 'Por referir a un amigo';
      }

      return {
        id: e.id,
        eventType: effectiveEventType,
        entryType: e.entryType,
        amount: e.amount.toString(),
        status: e.status,
        createdAt: e.createdAt,
        branchId,
        branchName,
        label: labelFor(effectiveEventType, e.status),
        subtitle,
        invoiceNumber,
        invoiceAmountInReference,
        cashAmountInReference,
        productName,
        productDescription,
        productPhotoUrl,
        items,
      };
    }));


    // Eric 2026-05-05 (Notion "Panel Clientes" correccion): if the account
    // has no displayName but a recent invoice has customer_name from OCR,
    // surface it as a soft fallback in the detail header.
    let effectiveDisplayName: string | null = account.displayName || null;
    if (!effectiveDisplayName) {
      const invWithName = invoices.find(i => {
        const ed: any = (i as any).extractedData || null;
        return ed && typeof ed.customer_name === 'string' && ed.customer_name.trim();
      });
      if (invWithName) {
        effectiveDisplayName = String(((invWithName as any).extractedData as any).customer_name).trim();
      }
    }

    return {
      account: {
        id: account.id,
        phoneNumber: account.phoneNumber,
        displayName: effectiveDisplayName,
        accountType: account.accountType,
        cedula: account.cedula,
        level: account.level,
        createdAt: account.createdAt,
      },
      balance,
      currencySymbol,
      history: enrichedHistory,
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
