/**
 * E2E: invoice transaction_date does not drift by one day.
 *
 * Genesis QA 2026-04-22: uploading an invoice for 2026-04-21 (via CSV
 * or the manual paste form) stored and rendered as 20/04/2026 for
 * merchants in Venezuela (UTC-4). Root cause: `new Date('2026-04-21')`
 * parses as UTC midnight, and the frontend was formatting without
 * `{ timeZone: 'UTC' }`, so VET shifted it to the previous local day.
 *
 * What this test proves:
 *   1. The backend parser stores 2026-04-21 as an exact UTC instant
 *      so the stored day is still '21' regardless of server TZ.
 *   2. The day-first LATAM format '21/04/2026' lands on the same
 *      calendar day (not flipped to April 4th).
 *   3. The /api/merchant/invoices payload round-trips the stored day
 *      without shift.
 *   4. The settings csv-upload page renders dates with timeZone:UTC.
 *   5. Bogus inputs ('2026-13-40', '31/02/2026') are rejected.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { issueStaffTokens } from '../src/services/auth.js';
import { parseCalendarDate } from '../src/services/csv-upload.js';
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

function utcDay(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function main() {
  console.log('=== Invoice date no-shift E2E ===\n');

  // --- Unit checks on the parser (fast, no DB) ---
  const iso = parseCalendarDate('2026-04-21')!;
  await assert('parseCalendarDate yields UTC midnight of the same day',
    iso.getUTCFullYear() === 2026 && iso.getUTCMonth() === 3 && iso.getUTCDate() === 21 &&
    iso.getUTCHours() === 0 && iso.getUTCMinutes() === 0,
    `iso=${iso.toISOString()}`);

  const latam = parseCalendarDate('21/04/2026')!;
  await assert('parseCalendarDate accepts DD/MM/YYYY on same day',
    latam.getUTCFullYear() === 2026 && latam.getUTCMonth() === 3 && latam.getUTCDate() === 21,
    `latam=${latam.toISOString()}`);

  const slash = parseCalendarDate('2026/04/21')!;
  await assert('parseCalendarDate accepts YYYY/MM/DD on same day',
    slash.getUTCFullYear() === 2026 && slash.getUTCMonth() === 3 && slash.getUTCDate() === 21,
    `slash=${slash.toISOString()}`);

  const bogus1 = parseCalendarDate('2026-13-40');
  const bogus2 = parseCalendarDate('31/02/2026');
  const bogus3 = parseCalendarDate('');
  await assert('parseCalendarDate rejects invalid month/day',
    bogus1 === null && bogus2 === null && bogus3 === null,
    `results=${bogus1},${bogus2},${bogus3}`);

  // --- End-to-end: CSV upload round-trips 2026-04-21 ---
  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Date Shift ${ts}`, `date-shift-${ts}`, `date-shift-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  // Genesis's exact case: one ISO row, one LATAM row.
  const invNumA = `DATECHECK-A-${ts}`;
  const invNumB = `DATECHECK-B-${ts}`;
  const csv = [
    'invoice_number,total,date,phone',
    `${invNumA},30000000,2026-04-21,+584161972695`,
    `${invNumB},100,21/04/2026,+584161972695`,
  ].join('\n');

  const upRes = await http('/api/merchant/csv-upload', ownerToken, {
    method: 'POST', body: JSON.stringify({ csvContent: csv }),
  });
  await assert('CSV upload succeeded',
    upRes.status === 200 && upRes.body.rowsLoaded === 2,
    `status=${upRes.status} loaded=${upRes.body?.rowsLoaded} errored=${upRes.body?.rowsErrored}`);

  // DB check: stored day is the 21st for both rows
  const rowA = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: invNumA }, select: { transactionDate: true },
  });
  const rowB = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: invNumB }, select: { transactionDate: true },
  });
  await assert('row A (ISO format) stored with day=21',
    utcDay(rowA?.transactionDate?.toISOString() || null) === '2026-04-21',
    `got=${rowA?.transactionDate?.toISOString()}`);
  await assert('row B (LATAM format) stored with day=21',
    utcDay(rowB?.transactionDate?.toISOString() || null) === '2026-04-21',
    `got=${rowB?.transactionDate?.toISOString()}`);

  // API round-trip: /api/merchant/invoices returns the same day
  const listRes = await http(`/api/merchant/invoices?search=DATECHECK-`, ownerToken);
  const listA = listRes.body?.invoices?.find((x: any) => x.invoiceNumber === invNumA);
  const listB = listRes.body?.invoices?.find((x: any) => x.invoiceNumber === invNumB);
  await assert('API response for row A is day 21',
    utcDay(listA?.transactionDate) === '2026-04-21',
    `got=${listA?.transactionDate}`);
  await assert('API response for row B is day 21',
    utcDay(listB?.transactionDate) === '2026-04-21',
    `got=${listB?.transactionDate}`);

  // Frontend source: render uses timeZone:UTC to avoid VET shift
  const fs = await import('fs/promises');
  const src = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(merchant)/merchant/csv-upload/page.tsx',
    'utf8',
  );
  await assert('csv-upload page renders transactionDate with timeZone:UTC',
    /transactionDate\)\.toLocaleDateString\(\s*'es-VE'\s*,\s*\{\s*timeZone:\s*'UTC'\s*\}/.test(src),
    'verified');

  // Sanity — confirm a VET-local renderer would drop the day by one.
  // This locks in the behavior we just fixed so nobody unwittingly
  // reverts the timeZone option.
  const droppedInVE = new Date(rowA!.transactionDate!).toLocaleDateString('es-VE', { timeZone: 'America/Caracas' });
  const correctAsUTC = new Date(rowA!.transactionDate!).toLocaleDateString('es-VE', { timeZone: 'UTC' });
  await assert('regression guard: without timeZone=UTC the render flips to April 20',
    droppedInVE.includes('20/4') && correctAsUTC.includes('21/4'),
    `VE=${droppedInVE} UTC=${correctAsUTC}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
