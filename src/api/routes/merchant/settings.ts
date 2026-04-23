import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { uploadImage } from '../../../services/cloudinary.js';
import { requireStaffAuth, requireOwnerRole } from '../../middleware/auth.js';

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ---- IMAGE UPLOAD (Owner only) ----
  app.post('/api/merchant/upload-image', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return reply.status(400).send({ error: 'Invalid file type. Allowed: JPEG, PNG, WebP, GIF' });
    }

    const buffer = await file.toBuffer();
    const url = await uploadImage(buffer, 'loyalty-platform/products');

    if (!url) {
      return reply.status(500).send({ error: 'Image upload failed. Check Cloudinary configuration.' });
    }

    return { success: true, url };
  });

  // ---- TENANT SETTINGS (Owner only) ----
  app.get('/api/merchant/settings', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();
    // Product count is surfaced so the onboarding wizard can tell whether
    // step 3 (add first product) is still pending without a separate request.
    const productCount = await prisma.product.count({ where: { tenantId } });
    const slug = tenant?.slug || '';
    return {
      welcomeBonusAmount: tenant?.welcomeBonusAmount ?? 50,
      referralBonusAmount: tenant?.referralBonusAmount ?? 100,
      rif: tenant?.rif || null,
      crossBranchRedemption: tenant?.crossBranchRedemption ?? true,
      slug,
      name: tenant?.name || '',
      logoUrl: tenant?.logoUrl || null,
      qrCodeUrl: tenant?.qrCodeUrl || null,
      address: tenant?.address || null,
      contactPhone: tenant?.contactPhone || null,
      contactEmail: tenant?.contactEmail || null,
      website: tenant?.website || null,
      description: tenant?.description || null,
      instagramHandle: tenant?.instagramHandle || null,
      preferredExchangeSource: tenant?.preferredExchangeSource || null,
      referenceCurrency: tenant?.referenceCurrency || 'usd',
      trustLevel: tenant?.trustLevel || 'level_2_standard',
      assetTypeId: assetType?.id || null,
      assetTypeName: assetType?.name || null,
      unitLabel: assetType?.unitLabel || 'pts',
      productCount,
    };
  });

  app.put('/api/merchant/settings', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const {
      welcomeBonusAmount, referralBonusAmount, rif, preferredExchangeSource, referenceCurrency, trustLevel, logoUrl,
      name, address, contactPhone, contactEmail, website, description, instagramHandle, crossBranchRedemption,
    } = request.body as {
      welcomeBonusAmount?: number;
      referralBonusAmount?: number;
      rif?: string;
      preferredExchangeSource?: string | null;
      referenceCurrency?: string;
      trustLevel?: string;
      logoUrl?: string | null;
      name?: string;
      address?: string | null;
      contactPhone?: string | null;
      contactEmail?: string | null;
      website?: string | null;
      description?: string | null;
      instagramHandle?: string | null;
      crossBranchRedemption?: boolean;
    };

    const validSources = ['bcv', 'binance_p2p', 'bybit_p2p', 'promedio', 'euro_bcv'];
    const validCurrencies = ['usd', 'eur', 'bs'];
    const validTrustLevels = ['level_1_strict', 'level_2_standard', 'level_3_presence'];

    const data: any = {};
    if (welcomeBonusAmount !== undefined) {
      if (typeof welcomeBonusAmount !== 'number' || welcomeBonusAmount < 0) {
        return reply.status(400).send({ error: 'welcomeBonusAmount must be a non-negative number' });
      }
      data.welcomeBonusAmount = welcomeBonusAmount;
    }
    if (referralBonusAmount !== undefined) {
      if (typeof referralBonusAmount !== 'number' || referralBonusAmount < 0) {
        return reply.status(400).send({ error: 'referralBonusAmount must be a non-negative number' });
      }
      data.referralBonusAmount = referralBonusAmount;
    }
    if (rif !== undefined) {
      // RIF is required once a tenant has it, and must be set on every PUT
      // that touches the rif key (Genesis M1 Re Do: the form was saving with
      // an empty RIF because an empty string silently flipped the DB column
      // back to NULL). Explicitly reject empty/blank input — the owner must
      // either leave the key out or send a valid value.
      if (!rif || (typeof rif === 'string' && !rif.trim())) {
        return reply.status(400).send({
          error: 'El RIF es obligatorio. No se puede guardar vacio.',
        });
      }
      // Normalize and validate: [JVEGP]-XXXXXXXX-X (7-9 digits body + 1 check digit)
      const normalized = String(rif).trim().toUpperCase().replace(/\s+/g, '');
      const match = normalized.match(/^([JVEGP])-?(\d{7,9})-?(\d)$/);
      if (!match) {
        return reply.status(400).send({
          error: 'RIF invalido. Formato: J-XXXXXXXX-X (prefijo J, V, E, G o P; 7-9 digitos; 1 digito verificador)',
        });
      }
      data.rif = `${match[1]}-${match[2]}-${match[3]}`;
    }
    if (preferredExchangeSource !== undefined) {
      if (preferredExchangeSource !== null && !validSources.includes(preferredExchangeSource)) {
        return reply.status(400).send({ error: `preferredExchangeSource must be one of: ${validSources.join(', ')} or null` });
      }
      data.preferredExchangeSource = preferredExchangeSource;

      // Each source only has rates for a specific currency. If the merchant
      // changes the source, auto-align reference_currency so we never end up
      // asking for (euro_bcv, usd) — a combination that has no exchange rate
      // and would silently fall back to treating Bs as if it were the ref
      // currency, giving absurd point totals.
      const sourceToCurrency: Record<string, string> = {
        bcv: 'usd',
        promedio: 'usd',
        euro_bcv: 'eur',
      };
      const aligned = sourceToCurrency[preferredExchangeSource as string];
      if (aligned) data.referenceCurrency = aligned;
    }
    if (referenceCurrency !== undefined && data.referenceCurrency === undefined) {
      if (!validCurrencies.includes(referenceCurrency)) {
        return reply.status(400).send({ error: `referenceCurrency must be one of: ${validCurrencies.join(', ')}` });
      }
      data.referenceCurrency = referenceCurrency;
    }
    if (trustLevel !== undefined) {
      if (!validTrustLevels.includes(trustLevel)) {
        return reply.status(400).send({ error: `trustLevel must be one of: ${validTrustLevels.join(', ')}` });
      }
      data.trustLevel = trustLevel;
    }
    if (logoUrl !== undefined) {
      data.logoUrl = logoUrl || null;
    }
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (trimmed.length < 2 || trimmed.length > 255) {
        return reply.status(400).send({ error: 'Nombre debe tener entre 2 y 255 caracteres' });
      }
      data.name = trimmed;
    }
    if (address !== undefined) {
      const v = address ? String(address).trim() : null;
      if (v && v.length > 500) return reply.status(400).send({ error: 'Direccion no puede exceder 500 caracteres' });
      data.address = v || null;
    }
    if (contactPhone !== undefined) {
      const v = contactPhone ? String(contactPhone).trim() : null;
      if (v && v.length > 30) return reply.status(400).send({ error: 'Telefono no puede exceder 30 caracteres' });
      data.contactPhone = v || null;
    }
    if (contactEmail !== undefined) {
      const v = contactEmail ? String(contactEmail).trim() : null;
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        return reply.status(400).send({ error: 'Email invalido' });
      }
      data.contactEmail = v || null;
    }
    if (website !== undefined) {
      const v = website ? String(website).trim() : null;
      data.website = v || null;
    }
    if (description !== undefined) {
      const v = description ? String(description).trim() : null;
      if (v && v.length > 1000) return reply.status(400).send({ error: 'Descripcion no puede exceder 1000 caracteres' });
      data.description = v || null;
    }
    if (instagramHandle !== undefined) {
      const v = instagramHandle ? String(instagramHandle).trim().replace(/^@/, '') : null;
      if (v && v.length > 100) return reply.status(400).send({ error: 'Instagram no puede exceder 100 caracteres' });
      data.instagramHandle = v || null;
    }
    if (crossBranchRedemption !== undefined) {
      if (typeof crossBranchRedemption !== 'boolean') {
        return reply.status(400).send({ error: 'crossBranchRedemption must be a boolean' });
      }
      data.crossBranchRedemption = crossBranchRedemption;
    }

    const updated = await prisma.tenant.update({ where: { id: tenantId }, data });
    return {
      welcomeBonusAmount: updated.welcomeBonusAmount,
      rif: updated.rif,
      name: updated.name,
      logoUrl: updated.logoUrl,
      address: updated.address,
      contactPhone: updated.contactPhone,
      contactEmail: updated.contactEmail,
      website: updated.website,
      description: updated.description,
      instagramHandle: updated.instagramHandle,
      preferredExchangeSource: updated.preferredExchangeSource,
      referenceCurrency: updated.referenceCurrency,
      trustLevel: updated.trustLevel,
    };
  });

  // ---- ATTRIBUTION ROI ----
  app.get('/api/merchant/attribution-roi', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { from, to } = request.query as { from?: string; to?: string };
    const { getAttributionRoi } = await import('../../../services/attribution.js');
    return getAttributionRoi({
      tenantId,
      fromDate: from ? new Date(from) : undefined,
      toDate: to ? new Date(to) : undefined,
    });
  });

  // ---- PLAN USAGE ----
  app.get('/api/merchant/plan-usage', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const { getUsageSummary } = await import('../../../services/plan-limits.js');
    return getUsageSummary(tenantId);
  });

  // Read-only: current exchange rates available in the system
  app.get('/api/merchant/exchange-rates', { preHandler: [requireStaffAuth] }, async () => {
    const rates = await prisma.$queryRaw<any[]>`
      SELECT DISTINCT ON (source, currency)
        source, currency, rate_bs as "rateBs", reported_at as "reportedAt", fetched_at as "fetchedAt"
      FROM exchange_rates
      ORDER BY source, currency, fetched_at DESC
    `;
    return { rates: rates.map(r => ({ ...r, rateBs: Number(r.rateBs) })) };
  });

  // ---- CONVERSION MULTIPLIER (Owner only) ----
  app.get('/api/merchant/multiplier', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request) => {
    const { tenantId } = request.staff!;
    const config = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = config
      ? await prisma.assetType.findUnique({ where: { id: config.assetTypeId } })
      : await prisma.assetType.findFirst();

    // Include the current Bs→reference exchange rate so the merchant UI can
    // preview how many points a given Bs amount will produce before committing
    // (e.g. the dual-scan "transaccion sin factura" widget).
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { preferredExchangeSource: true, referenceCurrency: true },
    });
    let exchangeRateBs: number | null = null;
    if (tenant?.preferredExchangeSource && tenant.referenceCurrency) {
      const { getCurrentRate } = await import('../../../services/exchange-rates.js');
      const rate = await getCurrentRate(tenant.preferredExchangeSource, tenant.referenceCurrency);
      if (rate) exchangeRateBs = rate.rateBs;
    }

    return {
      currentRate: config?.conversionRate?.toString() || assetType?.defaultConversionRate?.toString() || '1',
      defaultRate: assetType?.defaultConversionRate?.toString() || '1',
      assetTypeId: assetType?.id || null,
      preferredExchangeSource: tenant?.preferredExchangeSource || null,
      referenceCurrency: tenant?.referenceCurrency || null,
      exchangeRateBs,
    };
  });

  app.put('/api/merchant/multiplier', { preHandler: [requireStaffAuth, requireOwnerRole] }, async (request, reply) => {
    const { tenantId } = request.staff!;
    const { multiplier, assetTypeId } = request.body as { multiplier: string; assetTypeId: string };

    if (!multiplier || !assetTypeId) {
      return reply.status(400).send({ error: 'multiplier and assetTypeId are required' });
    }

    const rate = parseFloat(multiplier);
    if (isNaN(rate) || rate <= 0) {
      return reply.status(400).send({ error: 'multiplier must be a positive number' });
    }

    const config = await prisma.tenantAssetConfig.upsert({
      where: { tenantId_assetTypeId: { tenantId, assetTypeId } },
      update: { conversionRate: rate.toFixed(8) },
      create: { tenantId, assetTypeId, conversionRate: rate.toFixed(8) },
    });

    return { success: true, newRate: config.conversionRate.toString() };
  });
}
