import type { FastifyInstance } from 'fastify';
import prisma from '../../../db/client.js';
import { validateInvoice } from '../../../services/invoice-validation.js';
import { requireConsumerAuth } from '../../middleware/auth.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../../../services/idempotency.js';
import { uploadImage } from '../../../services/cloudinary.js';

export async function registerInvoicesRoutes(app: FastifyInstance): Promise<void> {
  // ---- INVOICE VALIDATION (from PWA) ----
  // Accepts multipart/form-data with an image file, or JSON with pre-extracted data.
  app.post('/api/consumer/validate-invoice', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const { accountId, tenantId, phoneNumber } = request.consumer!;
    void accountId; // reserved — used elsewhere; kept in destructure for symmetry

    const contentType = request.headers['content-type'] || '';

    // --- Multipart upload path (image file from PWA camera/gallery) ---
    if (contentType.includes('multipart/form-data')) {
      let imageBuffer: Buffer | null = null;
      let latitude: string | null = null;
      let longitude: string | null = null;
      let deviceId: string | null = null;
      let assetTypeId: string | null = null;
      let branchId: string | null = null;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'invoice') {
          imageBuffer = await part.toBuffer();
        } else if (part.type === 'field') {
          const val = part.value as string;
          if (part.fieldname === 'latitude') latitude = val || null;
          else if (part.fieldname === 'longitude') longitude = val || null;
          else if (part.fieldname === 'deviceId') deviceId = val || null;
          else if (part.fieldname === 'assetTypeId') assetTypeId = val || null;
          else if (part.fieldname === 'branchId') branchId = val || null;
        }
      }

      if (!imageBuffer) {
        return reply.status(400).send({ error: 'An invoice image file is required (field name: "invoice")' });
      }
      if (!assetTypeId) {
        return reply.status(400).send({ error: 'assetTypeId is required' });
      }

      // Validate branchId belongs to this tenant — ignore spoofed values instead
      // of trusting raw user input.
      if (branchId) {
        const b = await prisma.branch.findFirst({ where: { id: branchId, tenantId, active: true }, select: { id: true } });
        if (!b) branchId = null;
      }

      // Fallback: if the client didn't send a branchId but the user scanned a
      // merchant QR recently, use that branch.
      if (!branchId && phoneNumber) {
        const WINDOW_MIN = parseInt(process.env.MERCHANT_SCAN_WINDOW_MIN || '240');
        const cutoff = new Date(Date.now() - WINDOW_MIN * 60 * 1000);
        const recent = await prisma.merchantScanSession.findFirst({
          where: { tenantId, consumerPhone: phoneNumber, scannedAt: { gte: cutoff }, branchId: { not: null } },
          orderBy: { scannedAt: 'desc' },
          select: { branchId: true },
        });
        if (recent?.branchId) branchId = recent.branchId;
      }

      const result = await validateInvoice({
        tenantId,
        senderPhone: phoneNumber,
        assetTypeId,
        imageBuffer,
        latitude,
        longitude,
        deviceId,
        branchId,
      });

      // Store idempotency after successful validation (per-user)
      if (result.success && result.invoiceNumber) {
        const idempotencyKey = `invoice:${tenantId}:${phoneNumber}:${result.invoiceNumber}`;
        await storeIdempotencyKey(idempotencyKey, 'invoice_validation', result);
      }

      return result;
    }

    // --- JSON path (pre-extracted data, used by tests or WhatsApp pipeline) ---
    const { extractedData, latitude, longitude, deviceId, assetTypeId, ocrRawText, branchId: bodyBranchId } = request.body as any;

    if (!extractedData || !assetTypeId) {
      return reply.status(400).send({ error: 'extractedData and assetTypeId are required' });
    }

    let jsonBranchId: string | null = bodyBranchId || null;
    if (jsonBranchId) {
      const b = await prisma.branch.findFirst({ where: { id: jsonBranchId, tenantId, active: true }, select: { id: true } });
      if (!b) jsonBranchId = null;
    }
    if (!jsonBranchId && phoneNumber) {
      const WINDOW_MIN = parseInt(process.env.MERCHANT_SCAN_WINDOW_MIN || '240');
      const cutoff = new Date(Date.now() - WINDOW_MIN * 60 * 1000);
      const recent = await prisma.merchantScanSession.findFirst({
        where: { tenantId, consumerPhone: phoneNumber, scannedAt: { gte: cutoff }, branchId: { not: null } },
        orderBy: { scannedAt: 'desc' },
        select: { branchId: true },
      });
      if (recent?.branchId) jsonBranchId = recent.branchId;
    }

    // Idempotency check: per-user. The key includes the phone number so that
    // a second user submitting the same invoice number gets the full
    // validation flow (and the correct rejection message), not the first
    // user's cached success. Same-user double-submissions still hit the
    // cache and return the original result without creating duplicate entries.
    if (extractedData?.invoice_number) {
      const idempotencyKey = `invoice:${tenantId}:${phoneNumber}:${extractedData.invoice_number}`;
      const cached = await checkIdempotencyKey(idempotencyKey);
      if (cached) {
        return cached;
      }
    }

    const result = await validateInvoice({
      tenantId,
      senderPhone: phoneNumber,
      assetTypeId,
      extractedData,
      ocrRawText,
      latitude,
      longitude,
      deviceId,
      branchId: jsonBranchId,
    });

    // Store idempotency after successful validation (per-user)
    if (result.success && (result.invoiceNumber || extractedData?.invoice_number)) {
      const invoiceNum = result.invoiceNumber || extractedData.invoice_number;
      const idempotencyKey = `invoice:${tenantId}:${phoneNumber}:${invoiceNum}`;
      await storeIdempotencyKey(idempotencyKey, 'invoice_validation', result);
    }

    return result;
  });

  // ---- UPLOAD IMAGE (for dispute screenshots) ----
  app.post('/api/consumer/upload-image', { preHandler: [requireConsumerAuth] }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return reply.status(400).send({ error: 'Invalid file type. Allowed: JPEG, PNG, WebP' });
    }

    const buffer = await file.toBuffer();
    const url = await uploadImage(buffer, 'loyalty-platform/disputes');

    if (!url) {
      return reply.status(500).send({ error: 'Image upload failed' });
    }

    return { success: true, url };
  });
}
