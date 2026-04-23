import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './admin/auth.js';
import { registerTenantsRoutes } from './admin/tenants.js';
import { registerLedgerRoutes } from './admin/ledger.js';
import { registerAccountsRoutes } from './admin/accounts.js';
import { registerHealthRoutes } from './admin/health.js';
import { registerManualReviewRoutes } from './admin/manual-review.js';
import { registerWhatsAppRoutes } from './admin/whatsapp.js';
import { registerAuditRoutes } from './admin/audit.js';

/**
 * Admin route plugin. Previously a single 981-line file; now composes
 * eight focused submodules under ./admin/. The admin auth middleware
 * lives in ./admin/_middleware.ts and is imported by every submodule
 * that registers protected routes. Exposed API paths are unchanged.
 */
export default async function adminRoutes(app: FastifyInstance) {
  await registerAuthRoutes(app);
  await registerTenantsRoutes(app);
  await registerLedgerRoutes(app);
  await registerAccountsRoutes(app);
  await registerHealthRoutes(app);
  await registerManualReviewRoutes(app);
  await registerWhatsAppRoutes(app);
  await registerAuditRoutes(app);
}
