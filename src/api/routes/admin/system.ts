import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from './_middleware.js';
import { getAuthChannelMeta, setAuthChannel, type AuthChannel } from '../../../services/system-settings.js';
import { isTwilioConfigured, startTwilioSmsVerification } from '../../../services/twilio-verify.js';
import { normalizeVenezuelanPhone } from '../../../services/accounts.js';

/**
 * Admin-only global config endpoints. First use case (Eric 2026-05-04):
 * auth_channel switch between WhatsApp and Twilio Verify SMS for the
 * consumer OTP login.
 */
export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/auth-channel', { preHandler: [requireAdminAuth] }, async () => {
    const meta = await getAuthChannelMeta();
    return {
      channel: meta.channel,
      updatedAt: meta.updatedAt,
      updatedBy: meta.updatedBy,
      smsAvailable: isTwilioConfigured(),
    };
  });

  app.put('/api/admin/auth-channel', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { channel } = request.body as { channel: AuthChannel };
    if (channel !== 'sms' && channel !== 'whatsapp') {
      return reply.status(400).send({ error: 'channel must be "sms" or "whatsapp"' });
    }
    if (channel === 'sms' && !isTwilioConfigured()) {
      return reply.status(400).send({ error: 'Twilio Verify is not configured. Set TWILIO_* env vars.' });
    }
    const adminId = (request as any).admin?.adminId || null;
    await setAuthChannel(channel, adminId);
    return { success: true, channel };
  });

  // Eric 2026-05-06: dry-run a Twilio Verify SMS without flipping the
  // production toggle. Lets the admin confirm the SMS lands at the
  // recipient's phone before pointing real OTPs to it. Limited to admin
  // role; doesn't touch the auth_channel setting at all.
  app.post('/api/admin/test-sms-otp', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { phoneNumber: rawPhone } = request.body as { phoneNumber: string };
    if (!rawPhone || typeof rawPhone !== 'string') {
      return reply.status(400).send({ error: 'phoneNumber is required' });
    }
    if (!isTwilioConfigured()) {
      return reply.status(400).send({ error: 'Twilio Verify is not configured. Set TWILIO_* env vars.' });
    }
    const phoneNumber = normalizeVenezuelanPhone(rawPhone);
    const sent = await startTwilioSmsVerification(phoneNumber);
    if (!sent) {
      return reply.status(502).send({
        error: 'Twilio rejected or failed to send. Revisar logs del backend para detalles.',
        phoneNumber,
      });
    }
    return { success: true, phoneNumber, message: 'SMS test enviado. Revisa el telefono.' };
  });
}
