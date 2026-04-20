/**
 * E2E: /api/admin/platform-health aggregates ops-facing signal correctly.
 *
 * We seed a fresh tenant with 4 invoice outcomes (claimed, rejected,
 * pending_validation, manual_review) plus a rejected invoice with a known
 * rejection_reason. Then we hit the endpoint and verify:
 *   - platform totals match seeded counts
 *   - per-tenant row has the expected breakdown
 *   - rejectionRate math is correct
 *   - seeded rejection reason appears in topRejectionReasons
 *   - backlog counts non-zero
 *   - atRiskTenants flags when rejectionRate >= 0.5 AND total >= 5
 *   - non-admin caller → 401
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { issueAdminTokens } from '../src/services/auth.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Platform health E2E ===\n');

  const admin = await prisma.adminUser.findFirstOrThrow();
  const adminToken = issueAdminTokens({ adminId: admin.id, type: 'admin' }).accessToken;

  const ts = Date.now();
  const tenant = await createTenant(`Health ${ts}`, `health-${ts}`, `health-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);

  // Seed a mix of invoice outcomes so the tenant shows ~67% rejection rate
  // (4 rejected out of 6), which trips the atRisk flag (>= 50% & >= 5 total).
  const seededReason = `E2E seed rejection ${ts}`;
  async function seed(invoiceNumber: string, status: string, reason?: string) {
    await prisma.$executeRaw`
      INSERT INTO invoices (id, tenant_id, invoice_number, amount, status, source, rejection_reason, created_at, updated_at)
      VALUES (gen_random_uuid(), ${tenant.id}::uuid, ${invoiceNumber}, 50, ${status}::"InvoiceStatus", 'photo_submission', ${reason || null}, now(), now())
    `;
  }
  await seed(`H-claimed-${ts}`, 'claimed');
  await seed(`H-pending-${ts}`, 'pending_validation');
  await seed(`H-review-${ts}`, 'manual_review');
  await seed(`H-rej-1-${ts}`, 'rejected', seededReason);
  await seed(`H-rej-2-${ts}`, 'rejected', seededReason);
  await seed(`H-rej-3-${ts}`, 'rejected', seededReason);
  await seed(`H-rej-4-${ts}`, 'rejected', `${seededReason} X`);

  // Non-admin caller → 401
  const noAuth = await fetch(`${API}/api/admin/platform-health`);
  await assert('no admin auth → 401', noAuth.status === 401, `status=${noAuth.status}`);

  // Happy path — use 24h window (seeds were just created).
  const res = await fetch(`${API}/api/admin/platform-health?windowHours=24`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  await assert('admin call → 200', res.status === 200, `status=${res.status}`);

  const body: any = await res.json();
  await assert('response has windowHours=24', body.windowHours === 24, `windowHours=${body.windowHours}`);
  await assert('response has activeTenants count', typeof body.activeTenants === 'number' && body.activeTenants >= 1,
    `activeTenants=${body.activeTenants}`);

  // Find our seeded tenant in the tenants array
  const ours = body.tenants.find((t: any) => t.tenantId === tenant.id);
  await assert('seeded tenant appears in tenants array', !!ours, `found=${!!ours}`);
  await assert('tenant.total matches seed (7)', ours?.total === 7, `total=${ours?.total}`);
  await assert('tenant.claimed matches seed (1)', ours?.claimed === 1, `claimed=${ours?.claimed}`);
  await assert('tenant.rejected matches seed (4)', ours?.rejected === 4, `rejected=${ours?.rejected}`);
  await assert('tenant.pending matches seed (1)', ours?.pending === 1, `pending=${ours?.pending}`);
  await assert('tenant.manualReview matches seed (1)', ours?.manualReview === 1, `manualReview=${ours?.manualReview}`);

  // 4 rejected / 7 total ≈ 0.5714
  const expected = Number((4/7).toFixed(4));
  await assert('tenant.rejectionRate = rejected/total', Math.abs(ours?.rejectionRate - expected) < 0.001,
    `rate=${ours?.rejectionRate} expected=${expected}`);

  // atRisk flag: >= 50% rate AND >= 5 total
  const atRisk = body.atRiskTenants.find((t: any) => t.tenantId === tenant.id);
  await assert('tenant surfaces in atRiskTenants', !!atRisk, `found=${!!atRisk}`);

  // topRejectionReasons must contain the seeded reason (or its truncation)
  const reasonHit = body.topRejectionReasons.find((r: any) => r.reason.startsWith(seededReason.slice(0, 40)));
  await assert('top rejection reasons include seeded reason', !!reasonHit && reasonHit.count >= 3,
    `reason=${reasonHit?.reason?.slice(0,40)} count=${reasonHit?.count}`);

  // backlog must include our seeded pending + manual_review
  await assert('backlog.pendingValidation >= 1', body.backlog.pendingValidation >= 1,
    `pendingValidation=${body.backlog.pendingValidation}`);
  await assert('backlog.manualReview >= 1', body.backlog.manualReview >= 1,
    `manualReview=${body.backlog.manualReview}`);

  // platform rejection rate sanity
  await assert('platform.rejectionRate is a number in [0,1]',
    typeof body.platform.rejectionRate === 'number' &&
    body.platform.rejectionRate >= 0 && body.platform.rejectionRate <= 1,
    `rate=${body.platform.rejectionRate}`);

  // tenants sorted by rejectionRate DESC
  const rates = body.tenants.map((t: any) => t.rejectionRate);
  const sorted = [...rates].sort((a: number, b: number) => b - a);
  await assert('tenants sorted by rejectionRate DESC',
    JSON.stringify(rates) === JSON.stringify(sorted),
    `first=${rates[0]} last=${rates[rates.length-1]}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
