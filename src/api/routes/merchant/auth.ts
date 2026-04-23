import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import prisma from '../../../db/client.js';
import { authenticateStaff, issueStaffTokens, verifyStaffToken } from '../../../services/auth.js';
import { createSystemAccounts } from '../../../services/accounts.js';
import { generateMerchantQR } from '../../../services/merchant-qr.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // ---- PUBLIC SIGNUP (no auth required) ----
  app.post('/api/merchant/signup', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const {
      businessName, slug: slugInput, ownerName, ownerEmail, password,
      address, contactPhone, rif, description,
    } = request.body as {
      businessName?: string;
      slug?: string;
      ownerName?: string;
      ownerEmail?: string;
      password?: string;
      address?: string;
      contactPhone?: string;
      rif?: string;
      description?: string;
    };

    // Validation
    if (!businessName || businessName.trim().length < 2) {
      return reply.status(400).send({ error: 'El nombre del comercio es obligatorio (minimo 2 caracteres)' });
    }

    // Auto-derive slug from the business name when the client doesn't send one.
    // The slug is still the public URL identifier (valee.app/?merchant=<slug>),
    // but we no longer make the user pick it during signup — they can rename
    // it later from Configuracion.
    function deriveSlug(name: string): string {
      return name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 50)
        .replace(/^-+|-+$/g, '');
    }
    let slug = (slugInput || '').trim().toLowerCase() || deriveSlug(businessName);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(slug)) {
      // Fall back to a sanitized derivation if the provided one failed validation
      slug = deriveSlug(businessName);
    }
    if (!slug || slug.length < 2) {
      return reply.status(400).send({ error: 'No pude generar un identificador valido a partir del nombre. Usa al menos 2 letras o numeros.' });
    }
    // Ensure uniqueness by appending a short random suffix on collision.
    let attempts = 0;
    while (await prisma.tenant.findUnique({ where: { slug } })) {
      if (attempts++ > 5) break;
      const suffix = Math.random().toString(36).slice(2, 6);
      slug = `${deriveSlug(businessName).slice(0, 45)}-${suffix}`;
    }
    if (!ownerName || ownerName.trim().length < 2) {
      return reply.status(400).send({ error: 'Nombre del propietario obligatorio' });
    }
    if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      return reply.status(400).send({ error: 'Email invalido' });
    }
    if (!password || password.length < 8) {
      return reply.status(400).send({ error: 'La contrasena debe tener al menos 8 caracteres' });
    }

    // Normalize and validate optional RIF
    let normalizedRif: string | null = null;
    if (rif && rif.trim()) {
      const m = rif.trim().toUpperCase().replace(/\s+/g, '').match(/^([JVEGP])-?(\d{7,9})-?(\d)$/);
      if (!m) return reply.status(400).send({ error: 'RIF invalido. Formato: J-XXXXXXXX-X' });
      normalizedRif = `${m[1]}-${m[2]}-${m[3]}`;
    }

    // Validate optional contact phone (10-15 digits)
    if (contactPhone && contactPhone.trim()) {
      const digits = contactPhone.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) {
        return reply.status(400).send({ error: 'Telefono invalido. Debe tener entre 10 y 15 digitos.' });
      }
    }

    // Slug uniqueness already handled by the auto-suffix loop above. If after
    // all retries we still have a collision, refuse — extremely unlikely.
    const existingSlug = await prisma.tenant.findUnique({ where: { slug } });
    if (existingSlug) {
      return reply.status(409).send({ error: 'No pude reservar un identificador unico para el comercio. Intenta de nuevo.' });
    }

    // Check RIF not already registered
    if (normalizedRif) {
      const existingRif = await prisma.tenant.findFirst({ where: { rif: normalizedRif } });
      if (existingRif) {
        return reply.status(409).send({ error: 'Ese RIF ya esta registrado en la plataforma.' });
      }
    }

    // Check email not used by another staff
    const existingStaff = await prisma.staff.findFirst({ where: { email: ownerEmail } });
    if (existingStaff) {
      return reply.status(409).send({ error: 'Ese email ya tiene una cuenta. Inicia sesion en lugar de registrarte.' });
    }

    // Create tenant
    const tenant = await prisma.tenant.create({
      data: {
        name: businessName.trim(),
        slug,
        ownerEmail,
        rif: normalizedRif,
        address: address?.trim() || null,
        contactPhone: contactPhone?.trim() || null,
        contactEmail: ownerEmail,
        description: description?.trim() || null,
      },
    });

    // System accounts (issued_value_pool, redemption_holding)
    await createSystemAccounts(tenant.id);

    // Default asset config (use first asset type, conversion 1:1)
    const defaultAsset = await prisma.assetType.findFirst();
    if (defaultAsset) {
      await prisma.tenantAssetConfig.create({
        data: { tenantId: tenant.id, assetTypeId: defaultAsset.id, conversionRate: 1 },
      });
    }

    // Owner staff account
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.staff.create({
      data: { tenantId: tenant.id, name: ownerName.trim(), email: ownerEmail, passwordHash, role: 'owner' },
    });

    // Generate merchant QR (best effort, don't fail signup if Cloudinary down)
    try {
      await generateMerchantQR(tenant.id);
    } catch (err) {
      console.error('[Signup] QR generation failed (non-fatal):', err);
    }

    // Auto-login: issue staff tokens so the new owner lands authenticated
    const newStaff = await prisma.staff.findFirst({ where: { tenantId: tenant.id, role: 'owner' } });
    if (!newStaff) return reply.status(500).send({ error: 'Error inesperado tras crear cuenta' });
    const tokens = issueStaffTokens({ staffId: newStaff.id, tenantId: tenant.id, role: 'owner', type: 'staff' });

    return {
      success: true,
      ...tokens,
      staff: { id: newStaff.id, name: newStaff.name, role: newStaff.role },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    };
  });

  // ---- AUTH: Staff login ----
  app.post('/api/merchant/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { email, password, tenantSlug } = request.body as { email: string; password: string; tenantSlug?: string };

    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password required' });
    }

    // Resolve tenant: explicit slug wins; otherwise try to infer it from the
    // email. The slug only becomes mandatory when the same email exists as
    // staff in more than one tenant (rare in practice — typically a consultant
    // working for several stores).
    let tenant = null as Awaited<ReturnType<typeof prisma.tenant.findUnique>>;
    if (tenantSlug) {
      tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
      if (!tenant) return reply.status(404).send({ error: 'Merchant not found' });
    } else {
      const matches = await prisma.staff.findMany({
        where: { email, active: true },
        include: { tenant: true },
      });
      if (matches.length === 0) return reply.status(401).send({ error: 'Invalid credentials' });
      if (matches.length > 1) {
        return reply.status(409).send({
          error: 'Este email esta vinculado a varios comercios. Indica el codigo del comercio.',
          requiresTenantSlug: true,
          tenantOptions: matches.map(m => ({ slug: m.tenant.slug, name: m.tenant.name })),
        });
      }
      tenant = matches[0].tenant;
    }

    // If the tenant is suspended we want the UI to show a clear message
    // instead of a generic "invalid credentials" — otherwise the owner tries
    // his password three times and ends up rate-limited. We only surface the
    // suspension state after verifying the password, so a stranger probing
    // emails can't distinguish "wrong password" from "active/suspended".
    if (tenant.status !== 'active') {
      const staff = await prisma.staff.findFirst({
        where: { tenantId: tenant.id, email, active: true },
      });
      if (staff && await bcrypt.compare(password, staff.passwordHash)) {
        return reply.status(403).send({
          error: `Tu cuenta del comercio ${tenant.name} esta suspendida. Comunicate con Valee (soporte@valee.app) para reactivarla.`,
          tenantSuspended: true,
          tenantName: tenant.name,
        });
      }
      // Wrong password + suspended tenant: keep the generic message so an
      // attacker can't enumerate tenants.
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const staff = await authenticateStaff(email, password, tenant.id);
    if (!staff) return reply.status(401).send({ error: 'Invalid credentials' });

    const tokens = issueStaffTokens({
      staffId: staff.id,
      tenantId: tenant.id,
      role: staff.role as 'owner' | 'cashier',
      type: 'staff',
    });

    return { success: true, ...tokens, staff: { id: staff.id, name: staff.name, role: staff.role } };
  });

  // ---- AUTH: Refresh staff token ----
  app.post('/api/merchant/auth/refresh', async (request, reply) => {
    const refreshToken = (request.body as any)?.refreshToken;
    if (!refreshToken) return reply.status(400).send({ error: 'refreshToken required' });

    try {
      const payload = verifyStaffToken(refreshToken);
      const tokens = issueStaffTokens({
        staffId: payload.staffId,
        tenantId: payload.tenantId,
        role: payload.role,
        type: 'staff',
      });
      return { success: true, ...tokens };
    } catch {
      return reply.status(401).send({ error: 'Invalid refresh token' });
    }
  });

  // ---- AUTH: Logout (Staff) ----
  // Mirrors the consumer logout: bumps tokens_invalidated_at so any JWT
  // issued before this moment is rejected at auth-check time, regardless
  // of whether it still has valid signature/TTL.
  app.post('/api/merchant/auth/logout', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = verifyStaffToken(authHeader.slice(7));
        await prisma.staff.update({
          where: { id: payload.staffId },
          data: { tokensInvalidatedAt: new Date() },
        });
      } catch {
        // Caller's token was already invalid; still return success so the
        // client can reliably call logout from any state.
      }
    }
    return { success: true };
  });

  // ---- PASSWORD RESET (Genesis M5) ----
  // Request phase: owner enters email → we look up the staff row, generate
  // a single-use token (we store only the SHA-256 hash, never the token
  // itself), and email a link. The endpoint always returns success to
  // avoid leaking whether an email is registered.
  app.post('/api/merchant/auth/password-reset/request', async (request, reply) => {
    const { email } = request.body as { email?: string };
    if (!email || typeof email !== 'string') {
      return reply.status(400).send({ error: 'email required' });
    }
    const staff = await prisma.staff.findFirst({
      where: { email: email.trim().toLowerCase(), active: true },
    });
    const ttlMinutes = parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || '30');
    let devResetUrl: string | undefined;
    if (staff) {
      const { randomBytes, createHash } = await import('crypto');
      const raw = randomBytes(32).toString('hex');
      const hash = createHash('sha256').update(raw).digest('hex');
      await prisma.passwordResetToken.create({
        data: {
          staffId: staff.id,
          tokenHash: hash,
          expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
        },
      });
      const base = process.env.FRONTEND_BASE_URL || 'https://valee.app';
      const resetUrl = `${base}/merchant/reset-password?token=${raw}`;
      const { sendPasswordResetLink } = await import('../../../services/email.js');
      const sent = await sendPasswordResetLink(staff.email, resetUrl, ttlMinutes);
      // If Resend isn't wired yet (DNS not verified), surface the link in
      // the API response so the flow is usable end-to-end for testing and
      // for Eric to manually forward to the owner while DNS propagates.
      if (!sent && process.env.NODE_ENV !== 'production') {
        devResetUrl = resetUrl;
      }
    }
    const body: any = { success: true };
    if (devResetUrl) body.devResetUrl = devResetUrl;
    return body;
  });

  // Confirm phase: owner clicks the link → frontend posts the raw token +
  // new password. We hash the token and match, enforce TTL + single-use,
  // then rotate the password and invalidate any live staff sessions.
  app.post('/api/merchant/auth/password-reset/confirm', async (request, reply) => {
    const { token, newPassword } = request.body as { token?: string; newPassword?: string };
    if (!token || !newPassword) {
      return reply.status(400).send({ error: 'token and newPassword required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return reply.status(400).send({ error: 'La contrasena debe tener al menos 8 caracteres' });
    }
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(token).digest('hex');
    const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hash } });
    if (!row) return reply.status(400).send({ error: 'Token invalido' });
    if (row.usedAt) return reply.status(400).send({ error: 'Token ya fue usado' });
    if (row.expiresAt < new Date()) return reply.status(400).send({ error: 'Token expirado' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await prisma.$transaction([
      prisma.staff.update({
        where: { id: row.staffId },
        // Rotate the password and kill any outstanding JWTs so a lost
        // device can't keep hitting the API with the old session.
        data: { passwordHash: newHash, tokensInvalidatedAt: new Date() },
      }),
      prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
    ]);
    return { success: true };
  });
}
