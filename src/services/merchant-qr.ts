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
 * Format: https://wa.me/{botPhone}?text={merchantSlug}
 */
export function generateWhatsAppDeepLink(merchantSlug: string): string {
  const botPhone = process.env.EVOLUTION_INSTANCE_NAME || '0000000000';
  // wa.me link with pre-filled text containing merchant slug
  const text = encodeURIComponent(`MERCHANT:${merchantSlug}`);
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

  const deepLink = generateWhatsAppDeepLink(tenant.slug);
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
  const botPhone = process.env.EVOLUTION_INSTANCE_NAME || '0000000000';
  const text = encodeURIComponent(`MERCHANT:${branch.tenant.slug}:BRANCH:${branch.id}`);
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
