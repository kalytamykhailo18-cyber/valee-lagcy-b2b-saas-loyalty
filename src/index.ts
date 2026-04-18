import dotenv from 'dotenv';
dotenv.config();

// Sentry must be initialized BEFORE any route/service imports so error handlers
// pick it up. No-op when SENTRY_DSN is unset — install the SDK now, set the DSN
// in .env once the Sentry account exists.
import * as Sentry from '@sentry/node';
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    release: process.env.SENTRY_RELEASE,
  });
}

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import consumerRoutes from './api/routes/consumer.js';
import merchantRoutes from './api/routes/merchant.js';
import adminRoutes from './api/routes/admin.js';
import webhookRoutes from './api/routes/webhook.js';

const app = Fastify({ logger: true });

// Forward any unhandled Fastify error to Sentry. Safe no-op when DSN absent.
app.setErrorHandler((err: any, request, reply) => {
  if (process.env.SENTRY_DSN) {
    Sentry.withScope(scope => {
      scope.setExtra('url', request.url);
      scope.setExtra('method', request.method);
      scope.setExtra('ip', request.ip);
      Sentry.captureException(err);
    });
  }
  request.log.error(err);
  reply.status(err?.statusCode || 500).send({ error: err?.message || 'Internal error' });
});

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
