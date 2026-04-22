/**
 * E2E: CSV invoice_number and phone validation rejects obvious
 * placeholders (Genesis's remaining "No hay validaciones al procesar
 * el CSV" card — Re Do #2).
 *
 * Image 4 on her Notion shows rows like G12345610, o123456789,
 * E123456789, 12345610, 13245, 0123456789, 12323131231 all accepted
 * as Disponible. She wants stricter digit-count validation with
 * foreign-number tolerance, including rejection of obvious placeholder
 * patterns on both invoice_number and phone columns.
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
  console.log('=== CSV invoice + phone digit validation E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`CsvDigit ${ts}`, `cd-${ts}`, `cd-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `cd-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });

  // ── Sequential-digit invoice placeholders: all must be rejected ──
  const seqCsv = [
    'invoice_number,total,date,phone',
    '0123456789,50,2026-04-20,+584141234567',
    '123456789,50,2026-04-20,+584141234567',
    '12345,50,2026-04-20,+584141234567',
    '9876543210,50,2026-04-20,+584141234567',
  ].join('\n');
  const seqResult = await processCSV(seqCsv, tenant.id, owner.id);
  await assert('4 sequential-digit rows all rejected',
    seqResult.rowsLoaded === 0 && seqResult.rowsErrored === 4,
    `loaded=${seqResult.rowsLoaded} errored=${seqResult.rowsErrored}`);
  await assert('rejection reason mentions "sequential"',
    seqResult.errorDetails.some((e: any) =>
      typeof e === 'object' && /sequential/i.test(e.reason)),
    `reasons=${JSON.stringify(seqResult.errorDetails).slice(0, 200)}`);

  // ── Repeated-digit placeholders: rejected ──
  const repCsv = [
    'invoice_number,total,date,phone',
    '1111111,50,2026-04-20,+584141234567',
    '99999999,50,2026-04-20,+584141234567',
  ].join('\n');
  const repResult = await processCSV(repCsv, tenant.id, owner.id);
  await assert('2 repeated-digit rows rejected',
    repResult.rowsLoaded === 0 && repResult.rowsErrored === 2,
    `loaded=${repResult.rowsLoaded} errored=${repResult.rowsErrored}`);

  // ── Too-few-digits invoice: rejected ──
  const shortCsv = [
    'invoice_number,total,date,phone',
    'AB1,50,2026-04-20,+584141234567',
    'X,50,2026-04-20,+584141234567',
  ].join('\n');
  const shortResult = await processCSV(shortCsv, tenant.id, owner.id);
  await assert('too-few-digits rows rejected',
    shortResult.rowsErrored === 2, `errored=${shortResult.rowsErrored}`);

  // ── Placeholder phone (repeated or sequential) rejected ──
  const phoneCsv = [
    'invoice_number,total,date,phone',
    'F-2026-0001,50,2026-04-20,5811111111111',
    'F-2026-0002,50,2026-04-20,0123456789',
  ].join('\n');
  const phoneResult = await processCSV(phoneCsv, tenant.id, owner.id);
  await assert('placeholder phones rejected',
    phoneResult.rowsLoaded === 0 && phoneResult.rowsErrored === 2,
    `loaded=${phoneResult.rowsLoaded} errored=${phoneResult.rowsErrored}`);

  // ── Legitimate rows: accepted ──
  const goodCsv = [
    'invoice_number,total,date,phone',
    'F-2026-0100,125.50,2026-04-20,+584141230011',
    'INV-2026-A8372,200,2026-04-20,+19175551212', // US foreign phone
    'ABC-789512,75,2026-04-20,+34612345678',      // Spain foreign phone
  ].join('\n');
  const goodResult = await processCSV(goodCsv, tenant.id, owner.id);
  await assert('legitimate rows loaded (incl foreign phones)',
    goodResult.rowsLoaded === 3, `loaded=${goodResult.rowsLoaded} errored=${goodResult.rowsErrored} details=${JSON.stringify(goodResult.errorDetails).slice(0, 160)}`);

  // ── Mixed: one good + one bad per row type ──
  const mixedCsv = [
    'invoice_number,total,date,phone',
    'F-2026-0200,150,2026-04-20,+584141230099', // good
    'G12345610,50,2026-04-20,+584141230088',    // passes (8 non-sequential digits)
    '0123456789,50,2026-04-20,+584141230077',   // rejected (sequential)
    '12,50,2026-04-20,+584141230066',           // rejected (too few digits)
  ].join('\n');
  const mixedResult = await processCSV(mixedCsv, tenant.id, owner.id);
  await assert('mixed CSV loads 2 good and errors 2 bad',
    mixedResult.rowsLoaded === 2 && mixedResult.rowsErrored === 2,
    `loaded=${mixedResult.rowsLoaded} errored=${mixedResult.rowsErrored}`);

  // Confirm DB reflects only the good ones
  const persisted = await prisma.invoice.count({
    where: { tenantId: tenant.id, invoiceNumber: { in: ['F-2026-0200', 'G12345610'] } },
  });
  await assert('only the good invoices persisted in DB',
    persisted === 2, `persisted=${persisted}`);

  const junkPresisted = await prisma.invoice.count({
    where: { tenantId: tenant.id, invoiceNumber: { in: ['0123456789', '12', '1111111'] } },
  });
  await assert('junk invoices NOT persisted',
    junkPresisted === 0, `junkPresisted=${junkPresisted}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
