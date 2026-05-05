import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from './_middleware.js';
import { getAuthChannelMeta, setAuthChannel, type AuthChannel } from '../../../services/system-settings.js';
import { isTwilioConfigured } from '../../../services/twilio-verify.js';

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
}
