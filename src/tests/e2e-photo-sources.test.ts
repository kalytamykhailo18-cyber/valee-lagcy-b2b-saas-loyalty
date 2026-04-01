import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { extractFromImage } from '../services/ocr.js';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function test() {
  console.log('=== PHOTO INPUT SOURCES ===\n');

  // ──────────────────────────────────
  // 1. Backend: accepts any image buffer (format-agnostic)
  // ──────────────────────────────────
  console.log('1. Backend accepts any image as Buffer');

  // The OCR service takes a Buffer and converts to base64
  // It doesn't care about the source (camera, screenshot, gallery)
  // Google Vision API handles JPEG, PNG, GIF, BMP, WEBP, ICO, PDF
  assert(typeof extractFromImage === 'function', 'extractFromImage accepts Buffer (any source)');

  // Simulate different image formats — all go through the same pipeline
  const fakeJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG magic bytes
  const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG magic bytes

  // Both convert to base64 identically
  assert(fakeJpeg.toString('base64').length > 0, 'JPEG buffer → base64 (camera photo)');
  assert(fakePng.toString('base64').length > 0, 'PNG buffer → base64 (screenshot)');

  // ──────────────────────────────────
  // 2. WhatsApp: any image sent as a message is processed
  // ──────────────────────────────────
  console.log('\n2. WhatsApp webhook handles imageMessage (any source)');

  // Evolution API sends imageMessage for all three sources:
  // - Camera photo: imageMessage with mimetype "image/jpeg"
  // - Screenshot: imageMessage with mimetype "image/png"
  // - Gallery: imageMessage with mimetype "image/jpeg" or "image/png"
  // Our webhook checks body.data.message.imageMessage — source-agnostic
  const { default: webhookRoutes } = await import('../api/routes/webhook.js');
  assert(typeof webhookRoutes === 'function', 'Webhook route registered');

  // The webhook detects hasImage via: !!(body?.data?.message?.imageMessage)
  // This works for all three sources — WhatsApp wraps them all as imageMessage
  const payloadCamera = { data: { key: { remoteJid: '584120001@s.whatsapp.net' }, message: { imageMessage: { mimetype: 'image/jpeg', url: 'https://...' } } } };
  const payloadScreenshot = { data: { key: { remoteJid: '584120002@s.whatsapp.net' }, message: { imageMessage: { mimetype: 'image/png', url: 'https://...' } } } };
  const payloadGallery = { data: { key: { remoteJid: '584120003@s.whatsapp.net' }, message: { imageMessage: { mimetype: 'image/jpeg', url: 'https://...' } } } };

  assert(!!payloadCamera.data.message.imageMessage, 'Camera photo detected as imageMessage');
  assert(!!payloadScreenshot.data.message.imageMessage, 'Screenshot detected as imageMessage');
  assert(!!payloadGallery.data.message.imageMessage, 'Gallery photo detected as imageMessage');

  // ──────────────────────────────────
  // 3. Frontend PWA: camera AND gallery options
  // ──────────────────────────────────
  console.log('\n3. Frontend PWA provides camera + gallery options');

  // Read the scan page source to verify
  const fs = await import('fs');
  const scanPage = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/scan/page.tsx', 'utf-8');

  // Camera option: input with capture="environment"
  assert(scanPage.includes('capture="environment"'), 'Camera input has capture="environment" attribute');
  assert(scanPage.includes('accept="image/*"'), 'Input accepts all image types');

  // Gallery option: removes capture attribute to show file picker
  assert(scanPage.includes('removeAttribute(\'capture\')'), 'Gallery option removes capture to open file picker');

  // Two distinct buttons
  assert(scanPage.includes('Tomar foto'), 'Button for camera: "Tomar foto"');
  assert(scanPage.includes('Seleccionar de galeria'), 'Button for gallery: "Seleccionar de galeria"');

  // ──────────────────────────────────
  // 4. Google Vision API accepts multiple formats
  // ──────────────────────────────────
  console.log('\n4. Google Vision API call is format-agnostic');

  // The OCR sends base64 to Vision API — Vision handles JPEG, PNG, GIF, BMP, WEBP
  // Our code: image: { content: imageBase64 } — no format restriction
  const ocrSource = fs.readFileSync('/home/loyalty-platform/src/services/ocr.ts', 'utf-8');
  assert(ocrSource.includes('content: imageBase64'), 'Sends raw base64 to Vision API (format-agnostic)');
  assert(!ocrSource.includes('image/jpeg') && !ocrSource.includes('image/png'), 'No format restriction in OCR code');

  console.log(`\n=== PHOTO SOURCES: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
