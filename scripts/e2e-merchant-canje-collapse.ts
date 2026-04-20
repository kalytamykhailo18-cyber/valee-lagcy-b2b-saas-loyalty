/**
 * E2E: merchant transactions endpoint collapses REDEMPTION_PENDING +
 * REDEMPTION_CONFIRMED into a single row per token (Genesis M8).
 *
 * Before: image 19 shows "Canje confirmado +125 / All month" and
 * "Canje pendiente -125 / All month / Genesis Abad" as two separate
 * rows for the same redemption. The confirmed row was missing the
 * consumer name because the entry lives on a system account
 * (holding→pool).
 *
 * Now: exactly ONE row per token, labeled REDEMPTION_CONFIRMED with
 * the consumer phone/name preserved (we keep the PENDING row since it
 * has the consumer account_id and just relabel the event_type).
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Merchant transactions — canje PENDING+CONFIRMED collapse E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Merchant Collapse ${ts}`, `mc-${ts}`, `mc-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;
  const holding = (await getSystemAccount(tenant.id, 'redemption_holding'))!;

  const phone = `+19000${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);
  await prisma.account.update({
    where: { id: consumer.id },
    data: { displayName: 'Genesis Abad' },
  });

  // Fund consumer
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '500', assetTypeId: asset.id,
    referenceId: `SEED-${ts}`, referenceType: 'manual_adjustment',
    metadata: { type: 'test_seed' },
  });

  // Simulate a redemption with real UUID tokenId
  const tokenId = randomUUID();

  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_PENDING',
    debitAccountId: consumer.id, creditAccountId: holding.id,
    amount: '125', assetTypeId: asset.id,
    referenceId: `REDEEM-${tokenId}`, referenceType: 'redemption_token',
    metadata: { productId: 'fake', productName: 'All month' },
  });
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'REDEMPTION_CONFIRMED',
    debitAccountId: holding.id, creditAccountId: pool.id,
    amount: '125', assetTypeId: asset.id,
    referenceId: `CONFIRMED-${tokenId}`, referenceType: 'redemption_token',
    metadata: { productId: 'fake', productName: 'All month' },
  });

  // Auth as owner so /api/merchant/transactions is reachable
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `mc-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  const res = await fetch(`${API}/api/merchant/transactions?limit=50`, {
    headers: { 'Authorization': `Bearer ${ownerToken}` },
  });
  const body: any = await res.json();
  await assert('/api/merchant/transactions 200', res.status === 200, `status=${res.status}`);

  const redemptionRows = body.entries.filter((e: any) =>
    ['REDEMPTION_PENDING', 'REDEMPTION_CONFIRMED', 'REDEMPTION_EXPIRED'].includes(e.eventType)
    && String(e.referenceId || '').endsWith(tokenId)
  );
  await assert('exactly ONE redemption row surfaces for this token',
    redemptionRows.length === 1,
    `count=${redemptionRows.length} refs=${redemptionRows.map((r: any) => r.referenceId).join('|')}`);

  const row = redemptionRows[0];
  await assert('surviving row is labeled REDEMPTION_CONFIRMED',
    row?.eventType === 'REDEMPTION_CONFIRMED',
    `eventType=${row?.eventType}`);
  await assert('surviving row still carries the consumer phone',
    row?.accountPhone === phone,
    `accountPhone=${row?.accountPhone}`);
  await assert('surviving row carries the consumer display name',
    row?.accountName === 'Genesis Abad',
    `accountName=${row?.accountName}`);
  await assert('surviving row retains productName metadata',
    row?.productName === 'All month',
    `productName=${row?.productName}`);
  await assert('surviving row shows the DEBIT side (consumer spent points)',
    row?.entryType === 'DEBIT',
    `entryType=${row?.entryType}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
