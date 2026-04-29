/**
 * Static Merchant QR Code generation.
 * Creates a WhatsApp deep link with the merchant slug as a pre-filled message.
 * The QR contains nothing sensitive — just a reference to the merchant.
 * It is static and never changes for that merchant.
 *
 * Cloudinary upload uses CLOUDINARY_* from .env.
 * WhatsApp phone number uses EVOLUTION_INSTANCE_NAME from .env.
 */

import prisma from '../db/client.js';
import { uploadImage } from './cloudinary.js';
import QRCode from 'qrcode';

/**
 * Generate the deep link URL encoded into a merchant QR.
 *
 * Eric 2026-04-26: switched from a wa.me/<phone>?text=... link to a direct
 * PWA URL. The native iOS/Android camera was hijacking every scan and
 * proposing "open in WhatsApp", which forced testers (and consumers without
 * the bot configured) through a path they couldn't complete. The PWA
 * `/consumer/<slug>` route already establishes the tenant context and walks
 * the consumer through phone-OTP login, so it's the better landing page —
 * and the camera opens it in the browser without prompting for WhatsApp.
 */
function getPwaBase(): string {
  return (process.env.FRONTEND_BASE_URL || 'https://valee.app').replace(/\/$/, '');
}

export async function generateWhatsAppDeepLink(merchantSlug: string, _merchantName?: string): Promise<string> {
  return `${getPwaBase()}/consumer/${merchantSlug}`;
}

/**
 * Generate a QR code image (PNG buffer) from a URL.
 */
export async function generateQRImage(url: string): Promise<Buffer> {
  const buffer = await QRCode.toBuffer(url, {
    type: 'png',
    width: 512,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  return buffer;
}

/**
 * Generate and store the static merchant QR code.
 * - Creates WhatsApp deep link with merchant slug
 * - Generates QR image
 * - Uploads to Cloudinary (if configured)
 * - Stores URL in tenants.qr_code_url
 */
export async function generateMerchantQR(tenantId: string): Promise<{
  deepLink: string;
  qrCodeUrl: string | null;
}> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error('Tenant not found');

  const deepLink = await generateWhatsAppDeepLink(tenant.slug, tenant.name);
  const qrBuffer = await generateQRImage(deepLink);

  // Upload to Cloudinary if configured
  let qrCodeUrl: string | null = null;
  qrCodeUrl = await uploadImage(qrBuffer, `merchant-qr/${tenant.slug}`);

  // If Cloudinary not configured, store as data URI
  if (!qrCodeUrl) {
    qrCodeUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;
  }

  // Store in tenant record
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { qrCodeUrl },
  });

  return { deepLink, qrCodeUrl };
}

/**
 * Generate / refresh the personal attribution QR for a staff member.
 * The QR encodes a WhatsApp deep link carrying both the merchant slug AND a
 * `Cjr:<slug>` marker. When a consumer scans it, the webhook parser attaches
 * the staff's ID to the conversation so any invoice submitted in that session
 * is credited to that staff for performance tracking.
 */
export async function generateStaffQR(staffId: string, options: { rotate?: boolean } = {}): Promise<{
  deepLink: string;
  qrCodeUrl: string | null;
  qrSlug: string;
}> {
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    include: { tenant: { select: { slug: true, name: true } } },
  });
  if (!staff) throw new Error('Staff not found');

  // Short, random, URL-safe slug (8 chars of base36). Uniqueness enforced
  // at DB level.
  //
  // First generation reuses any existing slug so reprinting an intact QR
  // is idempotent. An explicit rotate=true (Genesis 2026-04-24: the
  // "Regenerar QR" button) forces a fresh slug so the old printed QR is
  // invalidated — exactly the semantics an owner needs when a cashier
  // leaves or the poster was compromised.
  let qrSlug = options.rotate ? null : staff.qrSlug;
  if (!qrSlug) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = Math.random().toString(36).slice(2, 10);
      if (candidate === staff.qrSlug) continue; // cosmetic: never regen to the same string
      const collision = await prisma.staff.findFirst({ where: { qrSlug: candidate }, select: { id: true } });
      if (!collision) { qrSlug = candidate; break; }
    }
    if (!qrSlug) throw new Error('Could not generate unique qr_slug');
  }

  // Eric 2026-04-26: PWA-direct URL with cjr= so the consumer lands in
  // /consumer/<slug>?cjr=<qrSlug> and the cashier-attribution context can
  // be picked up there (replacing the old wa.me/<phone>?text=... that the
  // native camera kept trying to open in WhatsApp).
  const deepLink = `${getPwaBase()}/consumer/${staff.tenant.slug}?cjr=${qrSlug}`;

  const qrBuffer = await generateQRImage(deepLink);
  let qrCodeUrl = await uploadImage(qrBuffer, `staff-qr/${staff.tenant.slug}/${qrSlug}`);
  if (!qrCodeUrl) {
    qrCodeUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;
  }

  await prisma.staff.update({
    where: { id: staffId },
    data: { qrSlug, qrCodeUrl, qrGeneratedAt: new Date() },
  });

  return { deepLink, qrCodeUrl, qrSlug };
}

/**
 * Generate a consumer's referral QR for a specific merchant. Encodes a
 * WhatsApp deep link with both the merchant slug AND a `Ref2U:<slug>` marker.
 * A NEW consumer who scans and interacts will register as a pending referral.
 */
export async function generateReferralQR(params: {
  merchantSlug: string;
  merchantName: string;
  referralSlug: string;
}): Promise<{ deepLink: string; qrPngBase64: string }> {
  // Eric 2026-04-26: PWA-direct (see generateWhatsAppDeepLink rationale).
  const deepLink = `${getPwaBase()}/consumer/${params.merchantSlug}?ref2u=${params.referralSlug}`;
  const qrBuffer = await generateQRImage(deepLink);
  return { deepLink, qrPngBase64: qrBuffer.toString('base64') };
}

/**
 * Generate QR for a specific branch.
 *
 * If the branch is the PRIMARY (oldest) sucursal of the tenant, regenerating
 * here also rotates the tenant-level QR ("QR del comercio") so the two stay
 * in sync. Eric 2026-04-26: regenerating from the first sucursal must update
 * the QR shown on Cajeros y QR personales as well — they are the same QR.
 */
export async function generateBranchQR(branchId: string): Promise<{
  deepLink: string;
  qrCodeUrl: string | null;
}> {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    include: { tenant: true },
  });
  if (!branch) throw new Error('Branch not found');

  const primary = await prisma.branch.findFirst({
    where: { tenantId: branch.tenantId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const isPrimary = primary?.id === branchId;

  // Eric 2026-04-26: PWA-direct URLs. Primary sucursal uses the slug-only
  // path so the QR matches "QR del comercio" exactly. Non-primary sucursales
  // append ?branch=<branchId> so the consumer page can preselect the sede.
  let deepLink: string;
  let cloudinaryFolder: string;
  if (isPrimary) {
    deepLink = `${getPwaBase()}/consumer/${branch.tenant.slug}`;
    cloudinaryFolder = `merchant-qr/${branch.tenant.slug}`;
  } else {
    deepLink = `${getPwaBase()}/consumer/${branch.tenant.slug}?branch=${branch.id}`;
    cloudinaryFolder = `branch-qr/${branch.tenant.slug}/${branch.id}`;
  }

  const qrBuffer = await generateQRImage(deepLink);
  let qrCodeUrl = await uploadImage(qrBuffer, cloudinaryFolder);
  if (!qrCodeUrl) {
    qrCodeUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;
  }

  await prisma.branch.update({
    where: { id: branchId },
    data: { qrCodeUrl },
  });

  // Mirror to tenant.qrCodeUrl when this is the primary sucursal — the
  // "QR del comercio" tile in Cajeros y QR personales reads from there.
  if (isPrimary) {
    await prisma.tenant.update({
      where: { id: branch.tenantId },
      data: { qrCodeUrl },
    });
  }

  return { deepLink, qrCodeUrl };
}
