import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from './_middleware.js';

export async function registerWhatsAppRoutes(app: FastifyInstance): Promise<void> {
  // ---- WHATSAPP TEMPLATES ----
  // List all logical templates the system uses, with example messages.
  // Genesis uses this list to know exactly which templates to register in Meta Manager.
  app.get('/api/admin/whatsapp-templates', { preHandler: [requireAdminAuth] }, async () => {
    const { listTemplates } = await import('../../../services/whatsapp-templates.js');
    return { templates: listTemplates() };
  });

  // Send a test template message to verify Meta has approved it
  app.post('/api/admin/whatsapp-templates/test', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const { templateName, phoneNumber, payload } = request.body as { templateName: string; phoneNumber: string; payload?: any };
    if (!templateName || !phoneNumber) {
      return reply.status(400).send({ error: 'templateName and phoneNumber required' });
    }
    const { sendTemplateMessage } = await import('../../../services/whatsapp-templates.js');
    const ok = await sendTemplateMessage(templateName, phoneNumber, payload || {}, 'auto');
    return { success: ok };
  });
}
