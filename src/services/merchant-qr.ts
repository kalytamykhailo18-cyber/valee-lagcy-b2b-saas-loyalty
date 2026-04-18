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
 * Generate the WhatsApp deep link URL for a merchant.
 * The pre-filled message is user-friendly with the merchant name visible,
 * and includes a hidden slug tag at the end that the bot parses.
 */
export async function generateWhatsAppDeepLink(merchantSlug: string, merchantName?: string): Promise<string> {
  const botPhone = process.env.META_WHATSAPP_DISPLAY_PHONE || process.env.EVOLUTION_INSTANCE_NAME || '0000000000';
  let name = merchantName;
  if (!name) {
    const tenant = await prisma.tenant.findUnique({ where: { slug: merchantSlug }, select: { name: true } });
    name = tenant?.name || merchantSlug;
  }
  // Pre-filled text the customer sees when they scan the QR. Framed as a
  // referral code so the slug looks intentional, not like a technical tag.
  const text = encodeURIComponent(`Hola! Quiero ganar puntos en ${name} ✨ Ref: ${merchantSlug}`);
  return `https://wa.me/${botPhone}?text=${text}`;
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
export async function generateStaffQR(staffId: string): Promise<{
  deepLink: string;
  qrCodeUrl: string | null;
  qrSlug: string;
}> {
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    include: { tenant: { select: { slug: true, name: true } } },
  });
  if (!staff) throw new Error('Staff not found');

  // Short, random, URL-safe slug (8 chars of base36). Uniqueness enforced at DB level.
  // If a slug already exists for this staff we reuse it so the printed QR can be reprinted
  // without invalidating posters already in the wild.
  let qrSlug = staff.qrSlug;
  if (!qrSlug) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = Math.random().toString(36).slice(2, 10);
      const collision = await prisma.staff.findFirst({ where: { qrSlug: candidate }, select: { id: true } });
      if (!collision) { qrSlug = candidate; break; }
    }
    if (!qrSlug) throw new Error('Could not generate unique qr_slug');
  }

  const botPhone = process.env.META_WHATSAPP_DISPLAY_PHONE || process.env.EVOLUTION_INSTANCE_NAME || '0000000000';
  const text = encodeURIComponent(
    `Hola! Quiero ganar puntos en ${staff.tenant.name} con ${staff.name} ✨ Ref: ${staff.tenant.slug} Cjr: ${qrSlug}`
  );
  const deepLink = `https://wa.me/${botPhone}?text=${text}`;

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
  const botPhone = process.env.META_WHATSAPP_DISPLAY_PHONE || process.env.EVOLUTION_INSTANCE_NAME || '0000000000';
  const text = encodeURIComponent(
    `Hola! Me invitaron a ${params.merchantName} en Valee ✨ Ref: ${params.merchantSlug} Ref2U: ${params.referralSlug}`
  );
  const deepLink = `https://wa.me/${botPhone}?text=${text}`;
  const qrBuffer = await generateQRImage(deepLink);
  return { deepLink, qrPngBase64: qrBuffer.toString('base64') };
}

/**
 * Generate QR for a specific branch.
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

  // Branch QR includes both tenant slug and branch ID
  const botPhone = process.env.META_WHATSAPP_DISPLAY_PHONE || process.env.EVOLUTION_INSTANCE_NAME || '0000000000';
  const text = encodeURIComponent(`Hola! Quiero ganar puntos en ${branch.tenant.name} - ${branch.name} ✨ Ref: ${branch.tenant.slug}/${branch.id}`);
  const deepLink = `https://wa.me/${botPhone}?text=${text}`;

  const qrBuffer = await generateQRImage(deepLink);
  let qrCodeUrl = await uploadImage(qrBuffer, `branch-qr/${branch.tenant.slug}/${branch.id}`);
  if (!qrCodeUrl) {
    qrCodeUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;
  }

  await prisma.branch.update({
    where: { id: branchId },
    data: { qrCodeUrl },
  });

  return { deepLink, qrCodeUrl };
}
