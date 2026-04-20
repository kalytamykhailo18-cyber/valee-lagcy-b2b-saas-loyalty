/**
 * E2E: CSV per-row validation rejects garbage before acredita-ing points.
 *
 * Genesis showed CSVs that included 'total=50000000' (Bs 50M in a single
 * row), phone values with random chars, dates in weird formats, and
 * trivially-short invoice numbers. The processCSV previously only
 * checked for a parseable amount; now each row goes through:
 *   - invoice_number format (alphanumeric + 3-64 chars)
 *   - amount cap (env CSV_AMOUNT_MAX, default 50M)
 *   - date parseability
 *   - phone digit count (10-15 after normalization)
 *
 * H4 already covered future-date and non-positive amount.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { processCSV } from '../src/services/csv-upload.js';
import bcrypt from 'bcryptjs';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== CSV per-row validation E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`CSV Val ${ts}`, `csv-val-${ts}`, `csv-val-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const staff = await prisma.staff.create({
    data: {
      tenantId: tenant.id,
      name: 'CSV Val Owner',
      email: `csv-val-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10),
      role: 'owner',
    },
  });

  const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const csv = [
    'invoice_number,amount,date,phone',
    // Valid baseline
    `INV-V-${ts},100,${pastDate},+584140446569`,
    // Invoice too short
    `XY,50,${pastDate},+584140446569`,
    // Invoice with garbage chars
    `!!;::FOO,50,${pastDate},+584140446569`,
    // Amount exceeds cap
    `INV-BIG-${ts},1000000000,${pastDate},+584140446569`,
    // Unparseable date
    `INV-BADDATE-${ts},50,1222-25-20,+584140446569`,
    // Phone too short
    `INV-BADPHONE-${ts},50,${pastDate},12345`,
    // Another valid row to confirm the loop keeps going
    `INV-V2-${ts},200,${pastDate},+584140446570`,
  ].join('\n');

  const result = await processCSV(csv, tenant.id, staff.id);

  await assert('2 valid rows loaded', result.rowsLoaded === 2,
    `loaded=${result.rowsLoaded}`);
  await assert('5 rows errored', result.rowsErrored === 5,
    `errored=${result.rowsErrored}`);

  const reasons = result.errorDetails?.map(e => e.reason).join(' | ') || '';

  await assert('short invoice_number rejected',
    /Invoice number invalid/i.test(reasons) && /XY/.test(reasons),
    `reasons="${reasons.slice(0, 180)}"`);
  await assert('garbage-char invoice_number rejected',
    /Invoice number invalid/i.test(reasons) && /!!/.test(reasons),
    `reasons="${reasons.slice(0, 180)}"`);
  await assert('amount over cap rejected',
    /exceeds per-row cap/i.test(reasons),
    `reasons="${reasons}"`);
  await assert('unparseable date rejected',
    /Unparseable date/i.test(reasons),
    `reasons="${reasons}"`);
  await assert('short phone rejected',
    /Invalid phone number/i.test(reasons) && /12345/.test(reasons),
    `reasons="${reasons}"`);

  // Bad rows not persisted
  const bad = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: `INV-BIG-${ts}` },
  });
  await assert('over-cap invoice NOT persisted', !bad, `found=${!!bad}`);

  // Good rows persisted
  const good = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: `INV-V-${ts}` },
  });
  await assert('valid invoice IS persisted', !!good, `found=${!!good}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
