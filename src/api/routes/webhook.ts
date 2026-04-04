import type { FastifyInstance } from 'fastify';
import { parseMerchantIdentifier, handleIncomingMessage } from '../../services/whatsapp-bot.js';
import { sendWhatsAppMessage } from '../../services/whatsapp.js';

/**
 * WhatsApp webhook handler — receives all incoming messages from Evolution API.
 * Parses the sender's phone, determines tenant context, routes to the correct handler.
 */
export default async function webhookRoutes(app: FastifyInstance) {

  app.post('/api/webhook/whatsapp', async (request, reply) => {
    const body = request.body as any;

    // Log the raw payload for debugging
    console.log('[Webhook] Received:', JSON.stringify({
      event: body?.event,
      remoteJid: body?.data?.key?.remoteJid,
      fromMe: body?.data?.key?.fromMe,
      sender: body?.sender,
      hasMessage: !!body?.data?.message,
    }));

    // Skip messages sent by us (fromMe)
    if (body?.data?.key?.fromMe) {
      return reply.status(200).send({ status: 'ignored', reason: 'fromMe' });
    }

    // Evolution API webhook payload structure
    // remoteJid can be: "584144018263@s.whatsapp.net" (traditional) or "179212308746274@lid" (new LID format)
    // For LID format, the real phone is in body.sender or we need to look it up
    let rawJid = body?.data?.key?.remoteJid || '';
    let phoneNumber = '';

    if (rawJid.includes('@s.whatsapp.net')) {
      // Traditional format — extract phone directly
      phoneNumber = rawJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    } else if (rawJid.includes('@lid')) {
      // LID format — try to get the real number from sender field or participant
      const senderField = body?.sender || body?.data?.key?.participant || '';
      if (senderField.includes('@s.whatsapp.net')) {
        phoneNumber = senderField.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      } else {
        // Try to extract from the instance's known contacts
        phoneNumber = senderField.replace(/\D/g, '');
      }
    } else if (rawJid.includes('@g.us')) {
      // Group message — ignore
      return reply.status(200).send({ status: 'ignored', reason: 'group message' });
    }

    const messageText = body?.data?.message?.conversation
      || body?.data?.message?.extendedTextMessage?.text
      || '';
    const hasImage = !!(body?.data?.message?.imageMessage);
    const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

    console.log('[Webhook] Parsed phone:', formattedPhone, 'Message:', messageText?.slice(0, 50));

    if (!phoneNumber || phoneNumber.length < 8) {
      return reply.status(200).send({ status: 'ignored', reason: 'no valid phone number' });
    }

    // Step 3: Parse merchant identifier from the QR pre-filled message
    let tenantId: string | null = null;
    let branchId: string | null = null;

    if (messageText) {
      const merchantInfo = await parseMerchantIdentifier(messageText);
      if (merchantInfo) {
        tenantId = merchantInfo.tenantId;
        branchId = merchantInfo.branchId;
      }
    }

    // If no tenant identified from the message, check if we have a stored session
    // For MVP: the tenant must be identified from the QR message
    if (!tenantId) {
      // Try to find any existing account for this phone to get tenant context
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
        // Cannot determine tenant — ask user to scan QR first
        await sendWhatsAppMessage(formattedPhone,
          'No pudimos identificar tu comercio. Por favor escanea el codigo QR del comercio para comenzar.');
        return reply.status(200).send({ status: 'no_tenant' });
      }
    }

    // If image message, download the image from Evolution API
    let imageBuffer: Buffer | undefined;
    if (hasImage) {
      const mediaUrl = body?.data?.message?.imageMessage?.url
        || body?.data?.message?.imageMessage?.directPath;

      if (mediaUrl) {
        try {
          const evolutionUrl = process.env.EVOLUTION_API_URL;
          const evolutionKey = process.env.EVOLUTION_API_KEY;
          const instanceName = process.env.EVOLUTION_INSTANCE_NAME;

          if (evolutionUrl && evolutionKey && instanceName) {
            // Download media via Evolution API
            const messageId = body?.data?.key?.id;
            const mediaRes = await fetch(
              `${evolutionUrl}/chat/getBase64FromMediaMessage/${instanceName}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': evolutionKey },
                body: JSON.stringify({ message: { key: body.data.key }, convertToMp4: false }),
              }
            );
            if (mediaRes.ok) {
              const mediaData = await mediaRes.json() as any;
              if (mediaData.base64) {
                imageBuffer = Buffer.from(mediaData.base64, 'base64');
              }
            }
          }
        } catch (err) {
          console.error('[Webhook] Failed to download image:', err);
        }
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
    });

    // Send all response messages back via WhatsApp
    for (const msg of responses) {
      await sendWhatsAppMessage(formattedPhone, msg);
    }

    return reply.status(200).send({ status: 'ok', responses: responses.length });
  });
}
