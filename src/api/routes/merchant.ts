import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './merchant/auth.js';
import { registerCsvRoutes } from './merchant/csv.js';
import { registerProductsRoutes } from './merchant/products.js';
import { registerScanRoutes } from './merchant/scan.js';
import { registerCustomersRoutes } from './merchant/customers.js';
import { registerStaffRoutes } from './merchant/staff.js';
import { registerBranchesRoutes } from './merchant/branches.js';
import { registerSettingsRoutes } from './merchant/settings.js';
import { registerRecurrenceRoutes } from './merchant/recurrence.js';
import { registerDisputesRoutes } from './merchant/disputes.js';
import { registerManualReviewRoutes } from './merchant/manual-review.js';
import { registerAuditRoutes } from './merchant/audit.js';
import { registerAnalyticsRoutes } from './merchant/analytics.js';
import { registerReferralsRoutes } from './merchant/referrals.js';
import { registerWelcomeBonusRoutes } from './merchant/welcome-bonus.js';

/**
 * Merchant route plugin. The file used to hold every handler inline
 * (2,500 lines); it now composes thirteen focused submodules under
 * ./merchant/. The exposed API paths are identical — the split is
 * purely an organization change. Adding a new route: create the
 * register* function in the right submodule and list it here.
 */
export default async function merchantRoutes(app: FastifyInstance) {
  await registerAuthRoutes(app);
  await registerCsvRoutes(app);
  await registerProductsRoutes(app);
  await registerScanRoutes(app);
  await registerCustomersRoutes(app);
  await registerStaffRoutes(app);
  await registerBranchesRoutes(app);
  await registerSettingsRoutes(app);
  await registerRecurrenceRoutes(app);
  await registerDisputesRoutes(app);
  await registerManualReviewRoutes(app);
  await registerAuditRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerReferralsRoutes(app);
  await registerWelcomeBonusRoutes(app);
}
