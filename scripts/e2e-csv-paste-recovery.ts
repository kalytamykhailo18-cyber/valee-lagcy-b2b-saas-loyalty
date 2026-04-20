/**
 * E2E: pasting CSV content with newlines collapsed into spaces (as
 * WhatsApp does) still processes correctly instead of erroring out.
 *
 * Genesis pasted the exact string
 *   invoice_number,total,date INV-001,50.00,2026-04-08 INV-002,100.00,2026-04-08
 * into the 'pegar contenido' textarea and the frontend showed
 * 'Application error: a client-side exception has occurred' because:
 *   a) backend returned a generic 'no data rows' failure
 *   b) frontend rendered the object errorDetails as React children and
 *      threw
 *
 * This test validates the backend-side recovery (auto-split on
 * whitespace when only one line is present). The frontend type + render
 * fix is covered by the page chunk check.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { processCSV } from '../src/services/csv-upload.js';
import bcrypt from 'bcryptjs';

const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== CSV paste-recovery (WhatsApp collapsed newlines) E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`CSV Paste ${ts}`, `csv-paste-${ts}`, `csv-paste-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const staff = await prisma.staff.create({
    data: {
      tenantId: tenant.id,
      name: 'Paste E2E',
      email: `csv-paste-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10),
      role: 'owner',
    },
  });

  const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Exact shape Genesis pasted: newlines replaced by single spaces.
  const collapsed =
    `invoice_number,total,date INV-PASTE-${ts},50.00,${pastDate} INV-PASTE-${ts}-B,100.00,${pastDate}`;

  const r1 = await processCSV(collapsed, tenant.id, staff.id);
  await assert('collapsed-newline paste loads 2 rows',
    r1.rowsLoaded === 2, `loaded=${r1.rowsLoaded} errored=${r1.rowsErrored}`);
  await assert('status reports success (not "failed no data rows")',
    r1.rowsErrored === 0, `errored=${r1.rowsErrored}`);

  // Confirm both invoices landed in the DB
  const inv1 = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: `INV-PASTE-${ts}` },
  });
  await assert('first invoice persisted', !!inv1, `found=${!!inv1}`);
  const inv2 = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, invoiceNumber: `INV-PASTE-${ts}-B` },
  });
  await assert('second invoice persisted', !!inv2, `found=${!!inv2}`);

  // Normal multi-line CSV still works (don't regress the happy path)
  const normal = [
    'invoice_number,total,date',
    `INV-NORM-${ts},25,${pastDate}`,
  ].join('\n');
  const r2 = await processCSV(normal, tenant.id, staff.id);
  await assert('normal multi-line CSV still loads', r2.rowsLoaded === 1,
    `loaded=${r2.rowsLoaded}`);

  // Single line with only the header (no data) still errors
  const headerOnly = 'invoice_number,total,date';
  const r3 = await processCSV(headerOnly, tenant.id, staff.id);
  await assert('header-only CSV fails with "no data rows"',
    r3.status === 'failed', `status=${r3.status}`);

  // Frontend: the chunk must render errorDetails with fila/reason and
  // not as raw objects (the React crash).
  const pageHtml = await (await fetch(`${FRONTEND}/merchant/csv-upload`)).text();
  const chunkUrls = Array.from(pageHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('csv-upload chunk renders "Fila X:" for object errors',
    chunkBodies.some(js => /Fila\s+/.test(js) && js.includes(': '.repeat(1))),
    `scanned=${chunkUrls.length}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
