import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './consumer/auth.js';
import { registerAccountRoutes } from './consumer/account.js';
import { registerReferralsRoutes } from './consumer/referrals.js';
import { registerInvoicesRoutes } from './consumer/invoices.js';
import { registerCatalogRoutes } from './consumer/catalog.js';
import { registerRedemptionRoutes } from './consumer/redemption.js';
import { registerDisputesRoutes } from './consumer/disputes.js';

/**
 * Consumer route plugin. Previously a single 1,256-line file; now
 * composes seven focused submodules under ./consumer/. API paths
 * are unchanged — purely an organization split.
 */
export default async function consumerRoutes(app: FastifyInstance) {
  await registerAuthRoutes(app);
  await registerAccountRoutes(app);
  await registerReferralsRoutes(app);
  await registerInvoicesRoutes(app);
  await registerCatalogRoutes(app);
  await registerRedemptionRoutes(app);
  await registerDisputesRoutes(app);
}
