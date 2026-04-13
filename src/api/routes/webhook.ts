import type { FastifyInstance } from 'fastify';
import { parseMerchantIdentifier, handleIncomingMessage } from '../../services/whatsapp-bot.js';
import { sendWhatsAppMessage, downloadWhatsAppMedia } from '../../services/whatsapp.js';

/**
 * WhatsApp webhook handler — receives all incoming messages from Meta Cloud API.
 *
 * Meta Webhook format (v22.0):
 * {
 *   "object": "whatsapp_business_account",
 *   "entry": [{
 *     "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
 *     "changes": [{
 *       "value": {
 *         "messaging_product": "whatsapp",
 *         "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
 *         "contacts": [{ "profile": { "name": "..." }, "wa_id": "<SENDER_PHONE>" }],
 *         "messages": [{
 *           "from": "<SENDER_PHONE>",
 *           "id": "<MESSAGE_ID>",
 *           "timestamp": "...",
 *           "type": "text" | "image" | ...,
 *           "text": { "body": "..." },
 *           "image": { "id": "<MEDIA_ID>", "mime_type": "...", "sha256": "..." }
 *         }]
 *       },
 *       "field": "messages"
 *     }]
 *   }]
 * }
 */
export default async function webhookRoutes(app: FastifyInstance) {

  // GET endpoint for Meta webhook verification
  app.get('/api/webhook/whatsapp', async (request, reply) => {
    const query = request.query as any;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    const verifyToken = process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('[Webhook] Meta verification successful');
      return reply.status(200).send(challenge);
    }

    return reply.status(403).send({ error: 'Verification failed' });
  });

  // POST endpoint for incoming WhatsApp messages
  app.post('/api/webhook/whatsapp', async (request, reply) => {
    const body = request.body as any;

    // Meta Cloud API webhook structure
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Status updates (delivery receipts, read receipts) — log them to debug delivery issues
    if (value?.statuses) {
      for (const s of value.statuses) {
        const errs = s.errors ? ` errors=${JSON.stringify(s.errors)}` : '';
        console.log(`[Webhook][status] msgid=${s.id} to=${s.recipient_id} status=${s.status} ts=${s.timestamp}${errs}`);
      }
      return reply.status(200).send({ status: 'ok', reason: 'status update logged' });
    }

    const message = value?.messages?.[0];
    if (!message) {
      return reply.status(200).send({ status: 'ignored', reason: 'no message' });
    }

    // Extract WhatsApp profile name from contacts array
    const senderProfileName: string | null = value?.contacts?.[0]?.profile?.name || null;

    console.log('[Webhook] Received:', JSON.stringify({
      from: message.from,
      type: message.type,
      id: message.id,
      profileName: senderProfileName,
    }));

    // Meta sends `from` as phone number in international format without +
    const phoneNumber = (message.from || '').replace(/\D/g, '');
    const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

    if (!phoneNumber || phoneNumber.length < 8) {
      return reply.status(200).send({ status: 'ignored', reason: 'no valid phone' });
    }

    let messageText = '';
    let hasImage = false;
    let mediaId: string | null = null;

    if (message.type === 'text') {
      messageText = message.text?.body || '';
    } else if (message.type === 'image') {
      hasImage = true;
      mediaId = message.image?.id || null;
      messageText = message.image?.caption || '';
    } else if (message.type === 'interactive') {
      // Button clicks, list selections
      messageText = message.interactive?.button_reply?.title
        || message.interactive?.list_reply?.title
        || '';
    }

    console.log('[Webhook] Parsed:', formattedPhone, 'type:', message.type, 'text:', messageText?.slice(0, 50));

    // Parse merchant identifier from the QR pre-filled message
    let tenantId: string | null = null;
    let branchId: string | null = null;

    if (messageText) {
      const merchantInfo = await parseMerchantIdentifier(messageText);
      if (merchantInfo) {
        tenantId = merchantInfo.tenantId;
        branchId = merchantInfo.branchId;
      }
    }

    // If no tenant identified, look up existing account
    if (!tenantId) {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      const existingAccount = await prisma.account.findFirst({
        where: { phoneNumber: formattedPhone, accountType: { in: ['shadow', 'verified'] } },
        orderBy: { createdAt: 'desc' },
      });
      await prisma.$disconnect();

      if (existingAccount) {
        tenantId = existingAccount.tenantId;
      } else {
        await sendWhatsAppMessage(formattedPhone,
          'No pudimos identificar tu comercio. Por favor escanea el codigo QR del comercio para comenzar.');
        return reply.status(200).send({ status: 'no_tenant' });
      }
    }

    // Download image from Meta if present
    let imageBuffer: Buffer | undefined;
    if (hasImage && mediaId) {
      try {
        const buf = await downloadWhatsAppMedia(mediaId);
        if (buf) imageBuffer = buf;
      } catch (err) {
        console.error('[Webhook] Failed to download image:', err);
      }
    }

    // Route to the message handler
    const messageType = hasImage ? 'image' : 'text';
    const responses = await handleIncomingMessage({
      phoneNumber: formattedPhone,
      tenantId,
      messageType,
      messageText: messageType === 'text' ? messageText : undefined,
      imageBuffer,
      senderProfileName,
    });

    // Send all response lines as a single WhatsApp message
    const combinedMessage = responses.join('\n');
    await sendWhatsAppMessage(formattedPhone, combinedMessage);

    return reply.status(200).send({ status: 'ok', responses: responses.length });
  });

  // ============================================================
  // POS WEBHOOK — Generic standard for any POS system to push transactions
  // ============================================================
  // Headers required:
  //   X-Tenant-Id: <tenant uuid>
  //   X-Signature: sha256=<hmac of body using tenant.posWebhookSecret>
  //
  // Body: see ValeePosPayload in pos-webhook.ts
  app.post('/api/webhook/pos', async (request, reply) => {
    const tenantId = request.headers['x-tenant-id'] as string | undefined;
    const signature = request.headers['x-signature'] as string | undefined;

    if (!tenantId) return reply.status(400).send({ error: 'X-Tenant-Id header required' });

    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    await prisma.$disconnect();

    if (!tenant) return reply.status(404).send({ error: 'Unknown tenant' });
    if (!tenant.posWebhookSecret) {
      return reply.status(403).send({ error: 'POS webhook not configured for this tenant' });
    }

    const rawBody = JSON.stringify(request.body);
    const { verifyWebhookSignature, ingestWebhookInvoice } = await import('../../services/pos-webhook.js');

    if (!verifyWebhookSignature(rawBody, signature, tenant.posWebhookSecret)) {
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    const payload = request.body as any;
    if (!payload.invoice_number || payload.amount === undefined) {
      return reply.status(400).send({ error: 'invoice_number and amount required' });
    }

    const result = await ingestWebhookInvoice({
      tenantId,
      source: 'pos_webhook',
      invoiceNumber: String(payload.invoice_number),
      amount: Number(payload.amount),
      customerPhone: payload.customer_phone || null,
      transactionDate: payload.transaction_date ? new Date(payload.transaction_date) : new Date(),
      branchId: payload.branch_id || null,
      items: payload.items,
      rawPayload: payload,
    });

    return reply.status(200).send({ success: true, ...result });
  });

  // ============================================================
  // FUDO WEBHOOK — Specific connector for Fudo POS (LATAM)
  // ============================================================
  // Subscribes to ORDER-CLOSED events. Translates Fudo's payload into Valee's
  // internal format. Each tenant configures its own fudo_webhook_secret in
  // the admin panel and provides this URL to Fudo:
  //   https://valee.app/api/webhook/fudo/<tenant-id>
  app.post('/api/webhook/fudo/:tenantId', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const signature = request.headers['x-fudo-signature'] as string | undefined
      || request.headers['x-signature'] as string | undefined;

    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    await prisma.$disconnect();

    if (!tenant) return reply.status(404).send({ error: 'Unknown tenant' });
    if (!tenant.fudoWebhookSecret) {
      return reply.status(403).send({ error: 'Fudo webhook not configured for this tenant' });
    }

    const rawBody = JSON.stringify(request.body);
    const { verifyWebhookSignature, ingestWebhookInvoice, translateFudoPayload } = await import('../../services/pos-webhook.js');

    if (!verifyWebhookSignature(rawBody, signature, tenant.fudoWebhookSecret)) {
      return reply.status(401).send({ error: 'Invalid Fudo signature' });
    }

    const payload = request.body as any;
    if (!payload.event || !payload.data) {
      return reply.status(400).send({ error: 'Invalid Fudo payload' });
    }

    // Only handle order-closed events
    const isOrderClosed = String(payload.event).toLowerCase().includes('order') &&
                         String(payload.event).toLowerCase().includes('closed');
    if (!isOrderClosed) {
      return reply.status(200).send({ success: true, skipped: true, reason: 'event ignored' });
    }

    const translated = translateFudoPayload(payload);
    if (!translated.invoiceNumber || translated.amount <= 0) {
      return reply.status(400).send({ error: 'Missing invoice number or amount' });
    }

    const result = await ingestWebhookInvoice({
      tenantId,
      source: 'fudo_webhook',
      invoiceNumber: translated.invoiceNumber,
      amount: translated.amount,
      customerPhone: translated.customerPhone,
      transactionDate: translated.transactionDate,
      branchId: null, // Map external branch ID to internal in a future iteration
      items: translated.items,
      rawPayload: payload,
    });

    return reply.status(200).send({ success: true, ...result });
  });
}
