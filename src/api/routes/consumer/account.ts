import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { phoneTail } from '../../../services/accounts.js';
import { getAccountBalance, getAccountBalanceBreakdown, getAccountHistory } from '../../../services/ledger.js';
import { requireConsumerAuth } from '../../middleware/auth.js';

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  // ---- BALANCE ----
  app.get('/api/consumer/balance', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;

    // Tenantless (global) tokens cannot resolve a balance. Tell the client
    // explicitly so it can call select-merchant instead of reading `0` and
    // silently showing an empty balance.
    if (!tenantId || !accountId) {
      return reply.status(409).send({
        error: 'No merchant selected',
        requiresMerchantSelection: true,
      });
    }

    // Get the first asset type for this tenant
    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();

    if (!assetType) {
      return { balance: '0', confirmed: '0', provisional: '0', unitLabel: 'points' };
    }

    const breakdown = await getAccountBalanceBreakdown(accountId, assetType.id, tenantId);

    // Reserved = sum of active pending redemption tokens. In the double-entry
    // ledger these are already debited from the consumer's balance (the QR
    // must hold the value so a second scan can't double-spend), so
    // breakdown.total already has them subtracted. The consumer sees this as
    // "points disappeared before I even showed the QR". We expose the
    // reserved amount so the PWA can render the big number as
    // total + reserved with a "N reservados" chip beside it, letting the
    // customer understand where the missing points went (Genesis M4).
    const reservedAgg = await prisma.redemptionToken.aggregate({
      where: {
        tenantId,
        consumerAccountId: accountId,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      _sum: { amount: true },
    });
    const reserved = reservedAgg._sum.amount?.toString() || '0';

    return {
      balance: breakdown.total,           // total displayed (confirmed + provisional)
      confirmed: breakdown.confirmed,
      provisional: breakdown.provisional,
      reserved,                           // pending redemption QRs still held
      unitLabel: assetType.unitLabel,
      assetTypeId: assetType.id,
    };
  });

  // ---- HISTORY ----
  app.get('/api/consumer/history', { preHandler: [requireConsumerAuth] }, async (request) => {
    const { accountId, tenantId } = request.consumer!;
    const { limit = '50', offset = '0' } = request.query as { limit?: string; offset?: string };

    const entries = await getAccountHistory(accountId, tenantId, parseInt(limit), parseInt(offset));

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

    // Enrich redemption-type entries with the product they were canjeado by.
    // The referenceId on a redemption ledger entry is the RedemptionToken id,
    // which carries the product relation. Without this join, the consumer's
    // history shows "Canje pendiente / -700" with no hint of what they bought.
    const redemptionEventTypes = new Set(['REDEMPTION_PENDING', 'REDEMPTION_CONFIRMED', 'REDEMPTION_EXPIRED']);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // referenceId shapes: REDEEM-<uuid>, CONFIRMED-<uuid>, EXPIRED-<uuid>.
    const refToTokenId = (ref: string): string | null => {
      const stripped = ref.replace(/^(REDEEM|CONFIRMED|EXPIRED)-/i, '');
      return UUID_RE.test(stripped) ? stripped : null;
    };

    const tokenIdByRef = new Map<string, string>();
    const pendingLedgerIds: string[] = [];
    for (const e of entries) {
      if (!redemptionEventTypes.has(e.eventType)) continue;
      const tid = refToTokenId(e.referenceId);
      if (tid) tokenIdByRef.set(e.referenceId, tid);
      if (e.eventType === 'REDEMPTION_PENDING') pendingLedgerIds.push(e.id);
    }
    // Bridge old REDEEM-<throwaway> refs whose UUID doesn't match the
    // token (historical bug: redemption.ts used separate uuids for the
    // ledger ref vs the token id). redemption_tokens.ledgerPendingEntryId
    // points back at the PENDING ledger row, so we can rewrite the map
    // entry to use the real token uuid and let the collapse logic group
    // PENDING and its terminal event under the same key.
    if (pendingLedgerIds.length > 0) {
      const bridges = await prisma.redemptionToken.findMany({
        where: { ledgerPendingEntryId: { in: pendingLedgerIds } },
        select: { id: true, ledgerPendingEntryId: true },
      });
      const pendingEntryIdToTokenId = new Map<string, string>();
      for (const b of bridges) pendingEntryIdToTokenId.set(b.ledgerPendingEntryId, b.id);
      for (const e of entries) {
        if (e.eventType !== 'REDEMPTION_PENDING') continue;
        const realTid = pendingEntryIdToTokenId.get(e.id);
        if (realTid) tokenIdByRef.set(e.referenceId, realTid);
      }
    }
    const redemptionTokenIds = Array.from(new Set(tokenIdByRef.values()));

    // Track which tokens already have a CONFIRMED (or EXPIRED) terminal
    // event. Their PENDING entries collapse into a single final-state row
    // (Genesis M6: 'Canje pendiente -10 / Canje confirmado +10' shouldn't
    // render as two stacked rows; it's one product canje).
    //
    // getAccountHistory only returns entries whose account_id = consumer.
    // REDEMPTION_CONFIRMED writes holding→pool (neither touches the
    // consumer) and REDEMPTION_EXPIRED writes holding→consumer (only the
    // CREDIT side touches the consumer). So to know whether a PENDING was
    // resolved we must consult redemption_tokens.status directly — that's
    // the source of truth regardless of which account the ledger leg is on.
    const confirmedTokenIds = new Set<string>();
    const expiredTokenIds = new Set<string>();
    if (redemptionTokenIds.length > 0) {
      const statusRows = await prisma.redemptionToken.findMany({
        where: { id: { in: redemptionTokenIds } },
        select: { id: true, status: true },
      });
      for (const r of statusRows) {
        if (r.status === 'used')    confirmedTokenIds.add(r.id);
        if (r.status === 'expired') expiredTokenIds.add(r.id);
      }
      // Fallback: if no redemption_tokens row (older data or test seeds),
      // scan the ledger tenant-wide for CONFIRMED-/EXPIRED-<tid> refs.
      const terminalRefs = await prisma.ledgerEntry.findMany({
        where: {
          tenantId,
          OR: redemptionTokenIds.flatMap(tid => [
            { referenceId: `CONFIRMED-${tid}` },
            { referenceId: `EXPIRED-${tid}` },
          ]),
        },
        select: { referenceId: true, eventType: true },
      });
      for (const r of terminalRefs) {
        const m = r.referenceId.match(/^(CONFIRMED|EXPIRED)-(.+)$/);
        if (!m) continue;
        if (m[1] === 'CONFIRMED') confirmedTokenIds.add(m[2]);
        if (m[1] === 'EXPIRED')   expiredTokenIds.add(m[2]);
      }
    }

    const tokens = redemptionTokenIds.length > 0
      ? await prisma.redemptionToken.findMany({
          where: { id: { in: redemptionTokenIds } },
          select: { id: true, product: { select: { name: true, photoUrl: true } } },
        })
      : [];
    const productByTokenId = new Map(tokens.map(t => [t.id, t.product]));

    // Build a lookup so the per-row status we send to the client reflects
    // the reconciled state, not the append-only raw ledger status. An
    // INVOICE_CLAIMED row with status='provisional' whose linked invoice
    // has already been matched against the CSV should display as
    // 'confirmed' to the consumer — otherwise the UI shows a yellow
    // 'provisional' chip on a transaction whose points are already
    // spendable (the bug Genesis reported: merchant view said Canjeada,
    // consumer history still said provisional for the same event).
    const pendingInvoiceNumbers = new Set<string>();
    for (const e of entries) {
      if (e.eventType !== 'INVOICE_CLAIMED' || e.status !== 'provisional') continue;
      const ref = e.referenceId || '';
      if (ref.startsWith('PENDING-')) pendingInvoiceNumbers.add(ref.slice('PENDING-'.length));
    }
    const claimedInvoices = pendingInvoiceNumbers.size > 0
      ? await prisma.invoice.findMany({
          where: {
            tenantId,
            invoiceNumber: { in: Array.from(pendingInvoiceNumbers) },
            status: 'claimed',
          },
          select: { invoiceNumber: true },
        })
      : [];
    const claimedInvoiceNumbers = new Set(claimedInvoices.map(i => i.invoiceNumber));

    return {
      entries: entries
        // Collapse PENDING/CONFIRMED/EXPIRED into a single row per token
        // (Genesis M6). Three cases:
        //   confirmed  → show ONE 'Producto Canjeado' DEBIT row (keep the
        //                PENDING row, relabel it to CONFIRMED; drop the
        //                CONFIRMED credit leg that lives on the pool)
        //   expired    → HIDE BOTH legs (net zero — the consumer got their
        //                points back, it's not a real event to list)
        //   in-flight  → keep the PENDING DEBIT as 'Canje pendiente'
        .filter(e => {
          const tid = tokenIdByRef.get(e.referenceId);
          if (!tid) return true;
          // Case: expired / cancelled → hide both sides of the pair.
          if (expiredTokenIds.has(tid) && !confirmedTokenIds.has(tid)) return false;
          // Case: confirmed → drop the system-side credit leg.
          if (e.eventType === 'REDEMPTION_CONFIRMED' && e.entryType === 'CREDIT') return false;
          // Safety: if for some reason a terminal event is missing, still
          // hide the EXPIRED DEBIT (it's always system-side).
          if (e.eventType === 'REDEMPTION_EXPIRED' && e.entryType === 'DEBIT') return false;
          return true;
        })
        .map(e => {
          const tid = tokenIdByRef.get(e.referenceId);
          if (tid && e.eventType === 'REDEMPTION_PENDING' && confirmedTokenIds.has(tid)) {
            return { ...e, eventType: 'REDEMPTION_CONFIRMED' as any };
          }
          return e;
        })
        .map(e => {
        // Prefer metadata stamped at write time (survives token cleanup);
        // fall back to the token join for older entries.
        const meta: any = (e as any).metadata || {};
        const metaProduct = (meta?.productName || meta?.productPhotoUrl)
          ? { name: meta.productName || null, photoUrl: meta.productPhotoUrl || null }
          : null;
        const tid = redemptionEventTypes.has(e.eventType) ? tokenIdByRef.get(e.referenceId) : undefined;
        const product = metaProduct || (tid ? productByTokenId.get(tid) : undefined);

        // Welcome-bonus and referral-bonus credits are both written as
        // ADJUSTMENT_MANUAL under the hood. We emit virtual event types
        // so the consumer UI can label them correctly in the history:
        //   WELCOME-<accountId>  → WELCOME_BONUS  (or meta.type === 'welcome_bonus')
        //   REFERRAL-<referralId> → REFERRAL_BONUS (or meta.type === 'referral_bonus')
        // Eric flagged on 2026-04-23 that referral bonuses were
        // invisible in the PWA because they rendered as the generic
        // ADJUSTMENT_MANUAL.
        const refStr = e.referenceId || '';
        let effectiveEventType: string = e.eventType;
        if (e.eventType === 'ADJUSTMENT_MANUAL') {
          if (refStr.startsWith('WELCOME-') || meta?.type === 'welcome_bonus') {
            effectiveEventType = 'WELCOME_BONUS';
          } else if (refStr.startsWith('REFERRAL-') || meta?.type === 'referral_bonus') {
            effectiveEventType = 'REFERRAL_BONUS';
          }
        }

        // Effective status: if this is a provisional INVOICE_CLAIMED
        // whose invoice has been reconciled via CSV (invoice.status =
        // 'claimed'), report it as 'confirmed' to the client. Keeps the
        // transaction history aligned with the balance readout.
        const ref = e.referenceId || '';
        const isReconciled =
          e.eventType === 'INVOICE_CLAIMED'
          && e.status === 'provisional'
          && ref.startsWith('PENDING-')
          && claimedInvoiceNumbers.has(ref.slice('PENDING-'.length));
        const effectiveStatus = isReconciled ? 'confirmed' : e.status;

        return {
          id: e.id,
          eventType: effectiveEventType,
          entryType: e.entryType,
          amount: e.amount.toString(),
          status: effectiveStatus,
          referenceId: e.referenceId,
          createdAt: e.createdAt,
          merchantName: tenant?.name || null,
          productName: product?.name || null,
          productPhotoUrl: product?.photoUrl || null,
        };
      }),
    };
  });

  // ---- ACCOUNT INFO ----
  app.get('/api/consumer/account', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId } = request.consumer!;

    // Global tokens (issued by tenantless OTP) carry accountId='' and
    // tenantId=''. findUnique with id='' throws P2023/validation. Fail fast
    // with a clean 409 so the client can call select-merchant instead of
    // crashing on 500.
    if (!accountId || !tenantId) {
      return reply.status(409).send({
        error: 'merchant selection required',
        requiresMerchantSelection: true,
      });
    }

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

    // Level thresholds (could be moved to DB/config later)
    const LEVEL_THRESHOLDS = [
      { level: 1, name: 'Bronce', min: 0 },
      { level: 2, name: 'Plata', min: 1000 },
      { level: 3, name: 'Oro', min: 5000 },
      { level: 4, name: 'Platino', min: 15000 },
    ];

    // Get balance and auto-upgrade level if needed
    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();
    let totalEarned = 0;
    if (assetType && accountId) {
      const bal = await getAccountBalance(accountId, assetType.id, tenantId);
      totalEarned = parseFloat(bal);
    }

    // Auto-upgrade: find the highest level the user qualifies for
    let correctLevel = 1;
    for (const t of LEVEL_THRESHOLDS) {
      if (totalEarned >= t.min) correctLevel = t.level;
    }
    if (account && correctLevel > account.level) {
      await prisma.account.update({ where: { id: accountId }, data: { level: correctLevel } });
    }

    const currentLevel = Math.max(account?.level || 1, correctLevel);
    const currentLevelInfo = LEVEL_THRESHOLDS.find(l => l.level === currentLevel) || LEVEL_THRESHOLDS[0];
    const nextLevelInfo = LEVEL_THRESHOLDS.find(l => l.level === currentLevel + 1);

    return {
      id: account?.id,
      phoneNumber: account?.phoneNumber,
      displayName: account?.displayName || null,
      accountType: account?.accountType,
      cedula: account?.cedula,
      level: currentLevel,
      levelName: currentLevelInfo.name,
      nextLevelName: nextLevelInfo?.name || null,
      pointsToNextLevel: nextLevelInfo ? Math.max(0, nextLevelInfo.min - totalEarned) : 0,
      nextLevelMin: nextLevelInfo?.min || null,
      merchantName: tenant?.name,
      merchantSlug: tenant?.slug,
      merchantLogo: tenant?.logoUrl || null,
    };
  });

  // ---- PUBLIC: List of affiliated merchants for the landing page (no auth) ----
  app.get('/api/consumer/affiliated-merchants', async () => {
    const tenants = await prisma.tenant.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      take: 24,
      select: { id: true, name: true, slug: true, qrCodeUrl: true },
    });
    return { merchants: tenants };
  });

  // ---- ALL ACCOUNTS (cross-tenant for the same phone number) ----
  // The authenticated consumer can have accounts in multiple merchants — same phone,
  // different tenants. This endpoint returns all of them with balance + top 3 products
  // per merchant. Used for the multicommerce landing page at valee.app.
  app.get('/api/consumer/all-accounts', { preHandler: [requireConsumerAuth] }, async (request) => {
    const { phoneNumber } = request.consumer!;
    const tail = phoneTail(phoneNumber);

    // Load every account this phone has across tenants so we can (1) always
    // include tenants where the consumer already has a balance even if they
    // have no published products right now, and (2) attach balance / accountId
    // to tenants listed for discovery. Last-10-digit matching handles legacy
    // phone-format variants.
    const allAccounts = await prisma.account.findMany({
      where: tail.length === 10
        ? { phoneNumber: { endsWith: tail }, accountType: { in: ['shadow', 'verified'] } }
        : { phoneNumber, accountType: { in: ['shadow', 'verified'] } },
      include: { tenant: true },
      orderBy: { createdAt: 'desc' },
    });

    // Deduplicate accounts by tenant, keeping the most recent (already ordered desc).
    const accountByTenant = new Map<string, typeof allAccounts[number]>();
    for (const acc of allAccounts) {
      if (!accountByTenant.has(acc.tenantId)) accountByTenant.set(acc.tenantId, acc);
    }

    // Tenants with at least one active in-stock product — these are safe to
    // surface even to users who don't have an account there yet (discovery).
    const tenantsWithProducts = await prisma.tenant.findMany({
      where: {
        status: 'active',
        products: { some: { active: true, stock: { gt: 0 }, archivedAt: null } },
      },
    });

    // Union: tenants-with-products ∪ tenants-where-this-user-has-an-account.
    // The latter bucket catches merchants where the user still has accumulated
    // points even if the merchant has no active products today — hiding those
    // would make balances appear to vanish.
    const tenantsById = new Map<string, { id: string; name: string; slug: string; status: string }>();
    for (const t of tenantsWithProducts) {
      tenantsById.set(t.id, { id: t.id, name: t.name, slug: t.slug, status: t.status });
    }
    for (const acc of allAccounts) {
      if (acc.tenant.status !== 'active') continue;
      if (!tenantsById.has(acc.tenantId)) {
        tenantsById.set(acc.tenantId, { id: acc.tenant.id, name: acc.tenant.name, slug: acc.tenant.slug, status: acc.tenant.status });
      }
    }
    const candidateTenants = Array.from(tenantsById.values());

    const merchantsRaw = await Promise.all(candidateTenants.map(async (tenant) => {
      const acc = accountByTenant.get(tenant.id) || null;

      // Pick the tenant's primary asset type
      const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId: tenant.id } });
      const assetType = assetConfig
        ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
        : await prisma.assetType.findFirst();

      let balance = '0';
      let unitLabel = 'pts';
      let reserved = '0';
      if (assetType) {
        if (acc) {
          balance = await getAccountBalance(acc.id, assetType.id, tenant.id);
          // Reserved = sum of this consumer's active pending redemption tokens
          // at this tenant. See /api/consumer/balance for the rationale — the
          // PWA displays balance+reserved so the customer doesn't think their
          // points vanished the moment they tapped "canjear" (Genesis M4).
          const resAgg = await prisma.redemptionToken.aggregate({
            where: {
              tenantId: tenant.id,
              consumerAccountId: acc.id,
              status: 'pending',
              expiresAt: { gt: new Date() },
            },
            _sum: { amount: true },
          });
          reserved = resAgg._sum.amount?.toString() || '0';
        }
        unitLabel = assetType.unitLabel;
      }

      // Top 3 products by lowest cost (entry-level redemptions are most attractive)
      const topProducts = await prisma.product.findMany({
        where: { tenantId: tenant.id, active: true, stock: { gt: 0 } },
        orderBy: { redemptionCost: 'asc' },
        take: 3,
        select: { id: true, name: true, photoUrl: true, redemptionCost: true, stock: true },
      });

      const fullTenant = await prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { logoUrl: true },
      });

      return {
        accountId: acc?.id || null,
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        tenantLogoUrl: fullTenant?.logoUrl || null,
        accountType: acc?.accountType || null,
        hasAccount: !!acc,
        balance,
        reserved,
        unitLabel,
        topProducts: topProducts.map(p => ({
          id: p.id,
          name: p.name,
          photoUrl: p.photoUrl,
          redemptionCost: p.redemptionCost.toString(),
          stock: p.stock,
        })),
      };
    }));

    // Final filter: show the merchant if EITHER the user has a balance there OR
    // it has at least one active product to redeem. A merchant with zero
    // products AND zero balance is noise.
    const merchants = merchantsRaw.filter(m => Number(m.balance) > 0 || m.topProducts.length > 0);

    // Sort: merchants with a balance first (by balance desc), then merchants
    // the user has an account in but no balance, then the rest alphabetically.
    merchants.sort((a, b) => {
      const ba = Number(a.balance), bb = Number(b.balance);
      if (ba !== bb) return bb - ba;
      if (a.hasAccount !== b.hasAccount) return a.hasAccount ? -1 : 1;
      return a.tenantName.localeCompare(b.tenantName);
    });

    // Compute total balance across merchants (note: only meaningful if all use the same unit)
    const totalBalance = merchants.reduce((sum, m) => sum + Number(m.balance), 0);
    const totalReserved = merchants.reduce((sum, m) => sum + Number(m.reserved || 0), 0);

    // Pick the best display name available across this user's accounts
    // (verified/non-null wins; otherwise the most recent).
    const displayName = allAccounts
      .map(a => a.displayName)
      .find((n): n is string => !!n && n.trim().length > 0) || null;

    return {
      phoneNumber,
      displayName,
      merchantCount: merchants.length,
      totalBalance: totalBalance.toFixed(8),
      totalReserved: totalReserved.toFixed(8),
      merchants,
    };
  });

  // ---- STAFF ATTRIBUTION via PWA ----
  // When a consumer clicks the WhatsApp greeting's "Accede a tu cuenta"
  // link and lands on the PWA with ?cajero=<qrSlug>, we need the same
  // attribution window that the WhatsApp image upload gets. Genesis
  // 2026-04-24: without this, uploading the factura from the PWA loses
  // the cashier the user just scanned. We resolve the slug inside the
  // consumer's current tenant and register a StaffScanSession keyed on
  // their phone — the exact same row validateInvoice already consults.
  app.post('/api/consumer/staff-attribution', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { tenantId, phoneNumber } = request.consumer!;
    if (!tenantId || !phoneNumber) {
      return reply.status(409).send({ error: 'No merchant selected' });
    }
    const { cashierSlug } = (request.body || {}) as { cashierSlug?: string };
    if (!cashierSlug || typeof cashierSlug !== 'string') {
      return reply.status(400).send({ error: 'cashierSlug required' });
    }
    const clean = cashierSlug.trim().toLowerCase();
    if (!/^[a-z0-9]{4,16}$/.test(clean)) {
      return reply.status(400).send({ error: 'Invalid cashierSlug format' });
    }
    const staff = await prisma.staff.findFirst({
      where: { tenantId, qrSlug: clean, active: true },
      select: { id: true, name: true },
    });
    if (!staff) {
      // Unknown or inactive cashier — silently no-op so a shared URL with a
      // stale slug doesn't 404 the PWA, but signal it so the client can
      // skip the optimistic "atendido por" banner.
      return { recorded: false, reason: 'cashier_not_found' };
    }
    await prisma.staffScanSession.create({
      data: { tenantId, staffId: staff.id, consumerPhone: phoneNumber },
    });
    return { recorded: true, staffName: staff.name };
  });
}
