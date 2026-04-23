import type { FastifyInstance } from 'fastify';
import { authenticateAdmin, issueAdminTokens } from '../../../services/auth.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // ---- AUTH: Admin login ----
  app.post('/api/admin/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };
    if (!email || !password) return reply.status(400).send({ error: 'email and password required' });

    const admin = await authenticateAdmin(email, password);
    if (!admin) return reply.status(401).send({ error: 'Invalid credentials' });

    const tokens = issueAdminTokens({ adminId: admin.id, type: 'admin' });
    return { success: true, ...tokens, admin: { id: admin.id, name: admin.name } };
  });
}
