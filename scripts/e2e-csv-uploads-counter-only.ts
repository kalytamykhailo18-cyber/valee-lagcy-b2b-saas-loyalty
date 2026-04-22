/**
 * E2E: CSV uploads are uncapped.
 *
 * Genesis QA: the "30 / month" cap was both surfaced in the plan panel
 * AND enforced by the backend. Merchants hitting the cap got a red
 * banner and could not upload the 31st CSV that month. Eric confirmed
 * that removing the numeric cap from the UI was only half the fix:
 * the backend must also stop blocking, and the bar should stay as a
 * passive activity indicator.
 *
 * What this test proves:
 *   - The POST /api/merchant/csv-upload endpoint accepts the 31st
 *     upload of the month for a tenant on the basic plan (no 402).
 *   - GET /api/merchant/plan-usage still reports csv_uploads.current
 *     (the counter continues to climb for the settings page).
 *   - The settings page source keeps the bar element but hides the
 *     "/limit" suffix for csv_uploads.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== CSV uploads uncapped E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`CSV Uncapped ${ts}`, `csv-uncapped-${ts}`, `csv-uncapped-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  // Explicitly lock the tenant to the basic plan — that's the tier
  // where the old 30-CSV cap fired.
  await prisma.tenant.update({ where: { id: tenant.id }, data: { plan: 'basic' } });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  // Push 31 batches through the endpoint. Each batch has a single row
  // so processCSV is cheap; we just want to exercise the plan-limit
  // guard, which used to trigger at the 31st call.
  const UPLOADS = 31;
  for (let i = 1; i <= UPLOADS; i++) {
    const csv = `invoice_number,amount,transaction_date\nINV-${ts}-${i},10.00,2026-04-22`;
    const res = await http('/api/merchant/csv-upload', ownerToken, {
      method: 'POST',
      body: JSON.stringify({ csvContent: csv }),
    });
    if (res.status !== 200) {
      await assert(`upload #${i} not blocked`,
        false,
        `status=${res.status} body=${JSON.stringify(res.body)}`);
    }
  }
  await assert(`all ${UPLOADS} uploads succeeded (no 402 from plan cap)`,
    true, `count=${UPLOADS}`);

  // Plan-usage still reports the counter (so the settings page can
  // keep displaying it). The value should equal UPLOADS.
  const usageRes = await http('/api/merchant/plan-usage', ownerToken);
  const csvUsage = usageRes.body?.usage?.csv_uploads;
  await assert('plan-usage reports csv_uploads.current = UPLOADS',
    csvUsage && csvUsage.current === UPLOADS,
    `current=${csvUsage?.current} limit=${csvUsage?.limit}`);

  // Frontend source: the bar is rendered and the "/limit" suffix is
  // hidden for csv_uploads. This guards against someone re-hiding the
  // bar (the prior regression Genesis flagged).
  const fs = await import('fs/promises');
  const src = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(merchant)/merchant/settings/page.tsx',
    'utf8',
  );
  await assert('settings page flags csv_uploads as hideLimit',
    /hideLimit\s*=\s*key\s*===\s*'csv_uploads'/.test(src),
    'verified');
  await assert('csv_uploads row drops the / limit suffix',
    /hideLimit\s*\?\s*u\.current\s*:\s*`\$\{u\.current\}\s*\/\s*\$\{u\.limit\}`/.test(src),
    'verified');
  await assert('progress bar is rendered unconditionally (no !isCounterOnly wrapper)',
    !/\{!isCounterOnly\s*&&/.test(src),
    'verified');
  await assert('progress bar element still exists in the file',
    /w-full bg-slate-100 rounded-full h-2 overflow-hidden/.test(src),
    'verified');

  // Backend safety: merchant.ts no longer calls enforceLimit on csv_uploads
  const routeSrc = await fs.readFile(
    '/home/loyalty-platform/src/api/routes/merchant.ts',
    'utf8',
  );
  await assert('merchant.ts does not enforceLimit(csv_uploads) anymore',
    !/enforceLimit\([^)]*'csv_uploads'\)/.test(routeSrc),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
