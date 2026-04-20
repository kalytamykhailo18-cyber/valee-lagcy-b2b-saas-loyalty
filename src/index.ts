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
import rateLimit from '@fastify/rate-limit';
import consumerRoutes from './api/routes/consumer.js';
import merchantRoutes from './api/routes/merchant.js';
import adminRoutes from './api/routes/admin.js';
import webhookRoutes from './api/routes/webhook.js';

// Trust X-Forwarded-For from nginx so req.ip is the real client IP instead
// of 127.0.0.1 (nginx). Without this, every request from the proxy shares
// the same rate-limit bucket and one noisy merchant locks out everyone.
//
// genReqId: prefer an inbound X-Request-Id from nginx / load balancer so the
// same ID chains across hops. Fall back to a random base36 string when the
// client didn't supply one. Short enough to paste into a support ticket;
// long enough that collisions are implausible under real traffic.
const app = Fastify({
  logger: true,
  trustProxy: true,
  genReqId: (req) => {
    const incoming = req.headers['x-request-id'];
    if (typeof incoming === 'string' && /^[\w-]{6,64}$/.test(incoming)) return incoming;
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  },
});

// Surface the request ID on every response so operators (and Sentry) can
// quote it when a user reports a problem. Hook runs on send so it catches
// every path — happy, error, rate-limited, or auth-rejected.
app.addHook('onSend', async (request, reply) => {
  reply.header('X-Request-Id', request.id);
});

// Forward any unhandled Fastify error to Sentry. Safe no-op when DSN absent.
app.setErrorHandler((err: any, request, reply) => {
  // Rate-limit plugin throws an Error whose payload is our errorResponseBuilder
  // output; preserve 429 + retryAfterSeconds rather than collapsing to 500.
  // fastify-rate-limit tags its errors as statusCode=429 on the error object.
  if (err?.statusCode === 429 || typeof err?.retryAfterSeconds === 'number') {
    return reply.status(429).send({
      error: err?.error || err?.message || 'Demasiadas solicitudes.',
      retryAfterSeconds: err?.retryAfterSeconds ?? 60,
    });
  }
  if (process.env.SENTRY_DSN) {
    Sentry.withScope(scope => {
      scope.setTag('request_id', request.id);
      scope.setExtra('url', request.url);
      scope.setExtra('method', request.method);
      scope.setExtra('ip', request.ip);
      Sentry.captureException(err);
    });
  }
  request.log.error({ err, reqId: request.id }, 'unhandled error');
  reply.status(err?.statusCode || 500).send({
    error: err?.message || 'Internal error',
    requestId: request.id,
  });
});

async function start() {
  // Capture the raw request body alongside the parsed JSON. The WhatsApp
  // webhook needs the exact bytes Meta sent to recompute the HMAC — once
  // Fastify's default parser runs, the raw bytes are gone. Storing it on
  // request.rawBody is ~tens of KB extra per request, tolerable.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const str = body as string;
    (req as any).rawBody = str;
    if (!str) { done(null, {}); return; }
    try { done(null, JSON.parse(str)); }
    catch (err) { done(err as Error, undefined); }
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB max

  // Global rate limit as a safety net. The actual tight limits live on the
  // sensitive endpoints (auth, signup) via { config: { rateLimit: ... } }.
  // Skipping the health check keeps uptime probes clean. LOAD_TOTAL env
  // signals the load test is running — disable rate limiting then so 10k
  // submissions at 40 concurrency don't trip it.
  const disableRateLimit = process.env.DISABLE_RATE_LIMIT === 'true';
  if (!disableRateLimit) {
    await app.register(rateLimit, {
      global: true,
      max: parseInt(process.env.RATE_LIMIT_GLOBAL_MAX || '300'),
      timeWindow: process.env.RATE_LIMIT_GLOBAL_WINDOW || '1 minute',
      allowList: (req) => req.url === '/api/health',
      // req.ip already respects X-Forwarded-For because trustProxy:true is
      // set on the Fastify instance; no custom keyGenerator needed.
      errorResponseBuilder: (_req, ctx) => ({
        error: 'Demasiadas solicitudes. Espera un momento antes de intentar de nuevo.',
        retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
      }),
    });
  }

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
