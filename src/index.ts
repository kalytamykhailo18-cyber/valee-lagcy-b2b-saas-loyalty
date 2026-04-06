import dotenv from 'dotenv';
dotenv.config();

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import consumerRoutes from './api/routes/consumer.js';
import merchantRoutes from './api/routes/merchant.js';
import adminRoutes from './api/routes/admin.js';
import webhookRoutes from './api/routes/webhook.js';

const app = Fastify({ logger: true });

async function start() {
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB max

  await app.register(consumerRoutes);
  await app.register(merchantRoutes);
  await app.register(adminRoutes);
  await app.register(webhookRoutes);

  // Health check
  app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Start background workers if Redis is configured
  if (process.env.REDIS_URL) {
    const { startWorkers } = await import('./services/workers.js');
    startWorkers();
  }

  const port = parseInt(process.env.PORT || '3000');
  const host = process.env.HOST || '0.0.0.0';

  await app.listen({ port, host });
  console.log(`Server running at http://${host}:${port}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
