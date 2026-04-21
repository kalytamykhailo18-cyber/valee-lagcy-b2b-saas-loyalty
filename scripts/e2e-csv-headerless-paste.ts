/**
 * E2E: CSV paste without a header line still works (Genesis H5 Re Do).
 *
 * Genesis pasted '12345, 50, 2026-04-20, 584161972695' (one data row,
 * no header) and got 'CSV has no data rows'. Merchants pasting raw
 * bank statements or WhatsApp-forwarded receipts rarely include the
 * header line.
 *
 * The parser now assumes the canonical column order
 * (invoice_number, total, date, phone) when the first row has no
 * recognized column name. Verifies:
 *   - Single header-less row: loads.
 *   - Multiple header-less rows: all load.
 *   - Header-present paste: still works (no double-prepend).
 *   - Malformed row still gets reported in errors.
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
  console.log('=== CSV headerless-paste recovery E2E (Genesis H5 Re Do) ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`HLCSV ${ts}`, `hlc-${ts}`, `hlc-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `hlc-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });

  // Case 1: single header-less row (Genesis's exact paste)
  const inv1 = `INV-HL1-${ts}`;
  const r1 = await processCSV(
    `${inv1}, 50, 2026-04-20, 584161972695`,
    tenant.id, owner.id,
  );
  await assert('single headerless row: completed',
    r1.status === 'completed', `status=${r1.status} errs=${JSON.stringify(r1.errorDetails).slice(0, 120)}`);
  await assert('single headerless row: 1 loaded',
    r1.rowsLoaded === 1, `loaded=${r1.rowsLoaded}`);
  const row1 = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: inv1 },
  });
  await assert('single headerless row: invoice persisted with correct amount',
    Number(row1?.amount) === 50, `amount=${row1?.amount}`);

  // Case 2: multiple header-less rows
  const inv2a = `INV-HL2a-${ts}`;
  const inv2b = `INV-HL2b-${ts}`;
  const r2 = await processCSV(
    [
      `${inv2a},120,2026-04-20,584161972691`,
      `${inv2b},330,2026-04-20,584161972692`,
    ].join('\n'),
    tenant.id, owner.id,
  );
  await assert('multi headerless rows: 2 loaded',
    r2.rowsLoaded === 2, `loaded=${r2.rowsLoaded}`);

  // Case 3: header present still works
  const inv3 = `INV-HL3-${ts}`;
  const r3 = await processCSV(
    [
      'invoice_number,total,date,phone',
      `${inv3},999,2026-04-20,584161972693`,
    ].join('\n'),
    tenant.id, owner.id,
  );
  await assert('with header: 1 loaded (no double-prepend)',
    r3.rowsLoaded === 1, `loaded=${r3.rowsLoaded}`);
  const row3 = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: inv3 },
  });
  await assert('with header: amount preserved (999, not header)',
    Number(row3?.amount) === 999, `amount=${row3?.amount}`);

  // Case 4: headerless with bad amount → error reported
  const r4 = await processCSV(
    `INV-HL4-${ts},not-a-number,2026-04-20,584161972694`,
    tenant.id, owner.id,
  );
  await assert('headerless bad amount: row reported as errored',
    r4.rowsErrored >= 1, `errored=${r4.rowsErrored}`);

  // Case 5: headerless 2-column (invoice + amount only)
  const inv5 = `INV-HL5-${ts}`;
  const r5 = await processCSV(
    `${inv5},77`,
    tenant.id, owner.id,
  );
  await assert('2-column headerless: 1 loaded',
    r5.rowsLoaded === 1, `loaded=${r5.rowsLoaded} status=${r5.status}`);
  const row5 = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: inv5 },
  });
  await assert('2-column headerless: amount is 77',
    Number(row5?.amount) === 77, `amount=${row5?.amount}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
