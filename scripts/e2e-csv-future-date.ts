/**
 * E2E: CSV upload rejects rows with transaction_date in the future and
 * rows with non-positive amounts. Genesis flagged a CSV that included
 * date=2026-05-12 (a month in the future) and it got accepted — a
 * merchant could pre-load 'future' facturas to farm points.
 *
 * Also covers the adjacent validation (amount > 0) because the CSV
 * already ran isNaN but accepted amount=0 as legal.
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
  console.log('=== CSV future-date + non-positive amount validation E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`CSV Future ${ts}`, `csv-future-${ts}`, `csv-future-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const staff = await prisma.staff.create({
    data: {
      tenantId: tenant.id,
      name: 'CSV E2E Owner',
      email: `csv-future-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10),
      role: 'owner',
    },
  });

  const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const tomorrowGrace = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10); // within 24h grace

  const csv = [
    'invoice_number,amount,date',
    `F-VALID-${ts},50,${pastDate}`,
    `F-FUTURE-${ts},100,${futureDate}`,
    `F-ZERO-${ts},0,${pastDate}`,
    `F-NEGATIVE-${ts},-25,${pastDate}`,
    `F-GRACE-${ts},75,${tomorrowGrace}`,
  ].join('\n');

  const result = await processCSV(csv, tenant.id, staff.id);

  await assert('valid row loaded', result.rowsLoaded === 2,
    `loaded=${result.rowsLoaded} (expected 2: past + grace window)`);
  await assert('errored count = 3 (future + zero + negative)',
    result.rowsErrored === 3, `errored=${result.rowsErrored}`);

  const errorReasons = result.errorDetails?.map(e => e.reason).join(' | ') || '';
  await assert('future-date row flagged with clear reason',
    /future/i.test(errorReasons), `reasons="${errorReasons}"`);
  await assert('zero-amount row flagged',
    /positive|amount must be/i.test(errorReasons), `reasons="${errorReasons}"`);
  await assert('negative-amount row flagged',
    errorReasons.includes('-25') || /positive/i.test(errorReasons),
    `reasons="${errorReasons}"`);

  const insertedFuture = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: `F-FUTURE-${ts}` },
  });
  await assert('future invoice NOT persisted in DB', !insertedFuture,
    `found=${!!insertedFuture}`);

  const insertedValid = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: `F-VALID-${ts}` },
  });
  await assert('valid invoice IS persisted in DB', !!insertedValid,
    `found=${!!insertedValid}`);

  const insertedGrace = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: `F-GRACE-${ts}` },
  });
  await assert('within-grace-window invoice persists', !!insertedGrace,
    `found=${!!insertedGrace}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
