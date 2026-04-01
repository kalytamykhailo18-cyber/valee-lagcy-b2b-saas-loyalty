import dotenv from 'dotenv';
dotenv.config();

import Fastify from 'fastify';
import cors from '@fastify/cors';
import consumerRoutes from './api/routes/consumer.js';
import merchantRoutes from './api/routes/merchant.js';
import adminRoutes from './api/routes/admin.js';

const app = Fastify({ logger: true });

async function start() {
  await app.register(cors, { origin: true, credentials: true });

  await app.register(consumerRoutes);
  await app.register(merchantRoutes);
  await app.register(adminRoutes);

  // Health check
  app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  const port = parseInt(process.env.PORT || '3000');
  const host = process.env.HOST || '0.0.0.0';

  await app.listen({ port, host });
  console.log(`Server running at http://${host}:${port}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
