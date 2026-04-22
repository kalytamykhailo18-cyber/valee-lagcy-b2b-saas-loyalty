/**
 * E2E: redemption branch is auto-derived from the cashier's assignment.
 *
 * Eric's requirement: if Pedro Perez works at Sucursal de la Viña and
 * scans a canje QR, the REDEMPTION_CONFIRMED ledger row should get
 * branchId=laViña automatically — even if the client that called the
 * endpoint didn't pass a branchId. That closes the traceability loop:
 * the PENDING already carries the originating branch, and now the
 * CONFIRMED carries the redeeming branch via staff assignment.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { initiateRedemption, processRedemption } from '../src/services/redemption.js';
import bcrypt from 'bcryptjs';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Redemption branch traceability E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Trace ${ts}`, `trace-${ts}`, `trace-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;

  const branchA = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal A', active: true },
  });
  const branchB = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal B', active: true },
  });

  // Pedro works at branch B
  const pedro = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Pedro Perez', email: `pedro-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
      branchId: branchB.id,
    },
  });

  const phone = `+58414${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '100', assetTypeId: asset.id,
    referenceId: `SEED-${ts}`, referenceType: 'manual_adjustment',
    metadata: { type: 'seed' },
  });

  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id, name: `Prize ${ts}`, redemptionCost: 20,
      assetTypeId: asset.id, stock: 3, active: true, minLevel: 1,
    },
  });

  // Customer generates redemption from branch A (phone, mesa QR, whatever)
  const red = await initiateRedemption({
    consumerAccountId: consumer.id,
    productId: product.id,
    tenantId: tenant.id,
    assetTypeId: asset.id,
    branchId: branchA.id,
  });
  await assert('redemption initiated at branch A',
    red.success === true, `msg=${red.message}`);

  // Pedro scans from his terminal WITHOUT passing branchId explicitly
  const scan = await processRedemption({
    token: red.token!,
    cashierStaffId: pedro.id,
    cashierTenantId: tenant.id,
    // no branchId — should auto-derive from pedro.branchId
  });
  await assert('scan succeeded', scan.success === true, `msg=${scan.message}`);

  // Verify the CONFIRMED ledger entry carries branch B (Pedro's branch)
  const confirmed = await prisma.ledgerEntry.findFirst({
    where: {
      tenantId: tenant.id,
      eventType: 'REDEMPTION_CONFIRMED',
      referenceId: `CONFIRMED-${red.tokenId}`,
    },
    select: { branchId: true },
  });
  await assert('CONFIRMED ledger row auto-stamped with cashier\'s branch (B)',
    confirmed?.branchId === branchB.id,
    `got=${confirmed?.branchId} expected=${branchB.id}`);

  // And the PENDING side still carries branch A (the origin)
  const pending = await prisma.ledgerEntry.findFirst({
    where: {
      tenantId: tenant.id,
      eventType: 'REDEMPTION_PENDING',
      referenceId: `REDEEM-${red.tokenId}`,
      entryType: 'DEBIT',
    },
    select: { branchId: true },
  });
  await assert('PENDING row keeps its origin branch (A)',
    pending?.branchId === branchA.id,
    `got=${pending?.branchId} expected=${branchA.id}`);

  // redemption_tokens.branchId also carries Pedro's branch (not null)
  const tokRow = await prisma.redemptionToken.findUnique({
    where: { id: red.tokenId! },
    select: { branchId: true },
  });
  await assert('redemption_tokens.branchId auto-filled from cashier',
    tokRow?.branchId === branchB.id,
    `got=${tokRow?.branchId}`);

  // Explicit branchId from the caller still wins when passed
  const red2 = await initiateRedemption({
    consumerAccountId: consumer.id,
    productId: product.id,
    tenantId: tenant.id,
    assetTypeId: asset.id,
    branchId: branchA.id,
  });
  const scan2 = await processRedemption({
    token: red2.token!,
    cashierStaffId: pedro.id,
    cashierTenantId: tenant.id,
    branchId: branchA.id, // Pedro is assigned to B, but terminal declares A
  });
  await assert('scan with explicit branchId succeeds',
    scan2.success === true, `msg=${scan2.message}`);
  const confirmed2 = await prisma.ledgerEntry.findFirst({
    where: {
      tenantId: tenant.id,
      eventType: 'REDEMPTION_CONFIRMED',
      referenceId: `CONFIRMED-${red2.tokenId}`,
    },
    select: { branchId: true },
  });
  await assert('explicit branchId overrides cashier default',
    confirmed2?.branchId === branchA.id,
    `got=${confirmed2?.branchId} expected=${branchA.id}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
