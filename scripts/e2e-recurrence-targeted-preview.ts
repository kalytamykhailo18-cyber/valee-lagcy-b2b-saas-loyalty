/**
 * E2E for Eric's 2026-04-24 Recurrencia card ("ver numeros"):
 *
 * When a recurrence rule has a specific targetPhones list, the preview
 * needs to surface EVERY number in the list with its current status, not
 * just the ones that happen to qualify right now. Otherwise the merchant
 * sees "Total 0 / Ningun cliente califica" and can't tell whether their
 * number was loaded correctly, whether the client just visited, etc.
 *
 * Covers:
 *   - a phone that has no account at all → status="sin_cuenta"
 *   - a phone that registered but never invoiced → "sin_historial"
 *   - a phone visited recently (within interval) → "en_periodo" + daysUntilQualifies
 *   - a phone lapsed past the threshold → "califica_ahora" + pending chip
 *   - summary counters (total/pending/alreadyNotified) count only qualifiers
 *   - hasTargetList=true so the UI branch chooses the targeted view
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  let body: any = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== Recurrence preview shows status of every targeted number E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Rec ${ts}`, `rec-${ts}`, `rec-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `o-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const token = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  // ── Four phones covering four scenarios ──
  const phoneNoAccount    = `+19500${String(ts).slice(-7)}`; // no Account row
  const phoneNoHistory    = `+19501${String(ts).slice(-7)}`; // Account exists, zero invoices
  const phoneRecent       = `+19502${String(ts).slice(-7)}`; // visited 5 days ago
  const phoneLapsed       = `+19503${String(ts).slice(-7)}`; // visited 30 days ago

  const accNoHistory = await findOrCreateConsumerAccount(tenant.id, phoneNoHistory);
  const accRecent    = await findOrCreateConsumerAccount(tenant.id, phoneRecent);
  const accLapsed    = await findOrCreateConsumerAccount(tenant.id, phoneLapsed);

  // Seed invoice claims at the desired ages.
  async function seed(accountId: string, daysAgo: number) {
    await writeDoubleEntry({
      tenantId: tenant.id,
      eventType: 'INVOICE_CLAIMED',
      debitAccountId: pool.id, creditAccountId: accountId,
      amount: '10', assetTypeId: asset.id,
      referenceId: `SEED-${accountId}-${ts}`,
      referenceType: 'invoice',
      metadata: { test: true },
    });
    // Rewind the created_at via raw SQL — the immutability trigger only
    // blocks UPDATE/DELETE on existing rows; we never rewrite amount/account/etc.
    // For the test we ONLY need the timestamp, so we use a dedicated path that
    // writes created_at explicitly. The trigger blocks UPDATE, so we must
    // recreate instead. Simpler: bypass the trigger by writing both rows
    // fresh with a back-dated raw insert.
  }

  // Use raw inserts so we can stamp a custom created_at (writeDoubleEntry
  // uses NOW() internally). We skip the hash chain here — it's only the
  // preview endpoint we're testing.
  async function rawClaim(accountId: string, daysAgo: number, tag: string) {
    const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const refId = `SEED-${tag}-${ts}`;
    // Credit (consumer side)
    await prisma.$executeRaw`
      INSERT INTO ledger_entries (id, tenant_id, event_type, entry_type, account_id, amount,
        asset_type_id, reference_id, reference_type, status, created_at, hash, prev_hash)
      VALUES (gen_random_uuid(), ${tenant.id}::uuid, 'INVOICE_CLAIMED', 'CREDIT',
        ${accountId}::uuid, 10, ${asset.id}::uuid, ${refId}, 'invoice', 'confirmed',
        ${when}, md5(random()::text), NULL)
    `;
    // Debit (pool side) — doesn't matter for the preview query but keep the pair
    await prisma.$executeRaw`
      INSERT INTO ledger_entries (id, tenant_id, event_type, entry_type, account_id, amount,
        asset_type_id, reference_id, reference_type, status, created_at, hash, prev_hash)
      VALUES (gen_random_uuid(), ${tenant.id}::uuid, 'INVOICE_CLAIMED', 'DEBIT',
        ${pool.id}::uuid, 10, ${asset.id}::uuid, ${refId}, 'invoice', 'confirmed',
        ${when}, md5(random()::text), NULL)
    `;
    void seed;
  }

  await rawClaim(accRecent.account.id, 5, 'recent');
  await rawClaim(accLapsed.account.id, 30, 'lapsed');

  // ── Create the rule: interval 15, grace 0, targetPhones = the four numbers ──
  const { RecurrenceRule } = await import('@prisma/client');
  void RecurrenceRule;
  const rule = await prisma.recurrenceRule.create({
    data: {
      tenantId: tenant.id,
      name: 'Test rule',
      intervalDays: 15,
      graceDays: 0,
      messageTemplate: 'Hola {name}! Te extrañamos hace {days} dias.',
      active: true,
      targetPhones: [phoneNoAccount, phoneNoHistory, phoneRecent, phoneLapsed],
    },
  });

  const res = await http(`/api/merchant/recurrence-rules/${rule.id}/eligible`, token);
  await assert('endpoint returns 200',
    res.status === 200, `status=${res.status}`);
  await assert('hasTargetList=true when the rule has a group',
    res.body.hasTargetList === true && res.body.targetedCount === 4,
    `hasTargetList=${res.body.hasTargetList} targetedCount=${res.body.targetedCount}`);
  await assert('consumers array contains all 4 targeted numbers',
    Array.isArray(res.body.consumers) && res.body.consumers.length === 4,
    `length=${res.body.consumers?.length}`);

  const byPhone: Record<string, any> = {};
  for (const c of res.body.consumers) {
    byPhone[c.phoneNumber.replace(/\D/g, '').slice(-10)] = c;
  }

  function tail(p: string) { return p.replace(/\D/g, '').slice(-10); }

  const noAccount = byPhone[tail(phoneNoAccount)];
  await assert('phone with no account → status=sin_cuenta',
    noAccount?.status === 'sin_cuenta' && noAccount?.accountId === null && noAccount?.qualifies === false,
    `status=${noAccount?.status} accountId=${noAccount?.accountId}`);

  const noHistory = byPhone[tail(phoneNoHistory)];
  await assert('phone registered without invoices → status=sin_historial',
    noHistory?.status === 'sin_historial' && noHistory?.qualifies === false && noHistory?.lastVisit === null,
    `status=${noHistory?.status} qualifies=${noHistory?.qualifies} lastVisit=${noHistory?.lastVisit}`);

  const recent = byPhone[tail(phoneRecent)];
  await assert('phone visited 5d ago → status=en_periodo with daysUntilQualifies ~10',
    recent?.status === 'en_periodo' && recent?.qualifies === false
      && recent?.daysSince === 5 && recent?.daysUntilQualifies === 10,
    `status=${recent?.status} daysSince=${recent?.daysSince} daysUntilQualifies=${recent?.daysUntilQualifies}`);

  const lapsed = byPhone[tail(phoneLapsed)];
  await assert('phone visited 30d ago → status=califica_ahora',
    lapsed?.status === 'califica_ahora' && lapsed?.qualifies === true
      && lapsed?.daysSince === 30 && lapsed?.alreadyNotified === false,
    `status=${lapsed?.status} qualifies=${lapsed?.qualifies} daysSince=${lapsed?.daysSince}`);

  // ── Summary counters reflect ONLY the qualifiers ──
  await assert('total/pending count only qualifying numbers (1 of 4)',
    res.body.total === 1 && res.body.pending === 1 && res.body.alreadyNotified === 0,
    `total=${res.body.total} pending=${res.body.pending} alreadyNotified=${res.body.alreadyNotified}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
