/**
 * E2E for Genesis's 2026-04-24 report:
 *
 *   "Al momento de escanear ciertos QR de cajeros de tiendas diferentes,
 *    algunos pasan y otros no."
 *
 * Root cause: handleIncomingMessage checked for merchant QR rescans with
 * /merchant:[a-z0-9\-]+/i only. The current QR format is
 * "Valee Ref: <slug> Cjr: <qr>" — no "MERCHANT:" tag — so RETURNING
 * users who rescanned a QR fell through to detectSupportIntent and got
 * "No entendi tu mensaje". First-time users worked because they hit an
 * earlier first_time branch that fires regardless of text content.
 *
 * Checks:
 *   (1) A returning user sending the new Ref: format gets a state-based
 *       greeting (not the support fallback menu).
 *   (2) A returning user sending a Ref: + Cjr: QR message also lands on
 *       the greeting.
 *   (3) Even when the Cjr: slug is STALE (no matching staff row, which is
 *       what Genesis actually tripped on), the greeting still fires — the
 *       cashier slug is just dropped from the link.
 *   (4) The legacy MERCHANT:<slug> format still works (no regression).
 *   (5) A plain unrelated text from a returning user still reaches the
 *       support-intent fallback (we only relaxed the QR path).
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { handleIncomingMessage } from '../src/services/whatsapp-bot.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { getSystemAccount } from '../src/services/accounts.js';

function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

function isSupportFallback(lines: string[]) {
  const joined = lines.join(' ').toLowerCase();
  return joined.includes('no entend') || joined.includes('opciones disponibles');
}

function isGreeting(lines: string[]) {
  const joined = lines.join(' ').toLowerCase();
  // State-based greetings always include some form of the merchant name or
  // a balance hint; the support fallback does not.
  return joined.includes('saldo')
      || joined.includes('puntos')
      || joined.includes('bienvenida')
      || joined.includes('ganaste')
      || joined.includes('recompensa');
}

async function main() {
  console.log('=== Returning-user QR rescan E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Rescan ${ts}`, `rescan-${ts}`, `rescan-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusAmount: 100 }});

  // Consumer with history so the state resolves to returning_with_history,
  // not first_time (first_time has its own earlier branch that always
  // returns the greeting and would hide the bug).
  const phone = `+19614${String(ts).slice(-7)}`;
  const { account } = await findOrCreateConsumerAccount(tenant.id, phone);
  await prisma.account.update({ where: { id: account.id }, data: { welcomeBonusGranted: true }});

  // Seed some history: write a provisional invoice-claim credit so the
  // state detector sees a confirmed history row.
  const pool = await getSystemAccount(tenant.id, 'issued_value_pool');
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool!.id,
    creditAccountId: account.id,
    amount: '500.00000000',
    assetTypeId: asset.id,
    referenceId: `SEED-${ts}`,
    referenceType: 'invoice',
  });

  // Also register a staff member so we can test both the valid-cjr and
  // stale-cjr branches.
  const staff = await prisma.staff.create({
    data: {
      tenantId: tenant.id,
      name: 'Cajera Test',
      email: `staff-${ts}@e2e.local`,
      passwordHash: 'x',
      role: 'cashier',
      qrSlug: 'validcjr',
      active: true,
    },
  });

  // (1) Bare "Valee Ref: <slug>" from a returning user → greeting, NOT fallback
  const r1 = await handleIncomingMessage({
    phoneNumber: phone,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: `Valee Ref: ${tenant.slug}`,
  });
  await assert('returning user Ref:-only message yields greeting (no support fallback)',
    !isSupportFallback(r1) && isGreeting(r1),
    `lines=${JSON.stringify(r1).slice(0, 160)}`);

  // (2) "Valee Ref: <slug> Cjr: <validSlug>" → greeting
  const r2 = await handleIncomingMessage({
    phoneNumber: phone,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: `Valee Ref: ${tenant.slug} Cjr: ${staff.qrSlug}`,
  });
  await assert('returning user Ref:+Cjr:(valid) message yields greeting',
    !isSupportFallback(r2) && isGreeting(r2),
    `lines=${JSON.stringify(r2).slice(0, 160)}`);

  // (3) Stale Cjr: slug (no staff row) — Genesis's exact case — still greets
  const r3 = await handleIncomingMessage({
    phoneNumber: phone,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: `Valee Ref: ${tenant.slug} Cjr: zzzzstale`,
  });
  await assert('stale Cjr: slug still yields greeting (Genesis repro)',
    !isSupportFallback(r3) && isGreeting(r3),
    `lines=${JSON.stringify(r3).slice(0, 160)}`);

  // (4) Legacy MERCHANT:<slug> format still works
  const r4 = await handleIncomingMessage({
    phoneNumber: phone,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: `Hola, [MERCHANT:${tenant.slug}]`,
  });
  await assert('legacy MERCHANT:<slug> format still yields greeting',
    !isSupportFallback(r4) && isGreeting(r4),
    `lines=${JSON.stringify(r4).slice(0, 160)}`);

  // (5) Plain unrelated text from a returning user still hits support-intent path
  //     (we don't want to regress the fallback — support intents must still work).
  const r5 = await handleIncomingMessage({
    phoneNumber: phone,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: 'asdfghjkl qwerty',
  });
  await assert('plain unrelated text still reaches support-intent fallback',
    isSupportFallback(r5),
    `lines=${JSON.stringify(r5).slice(0, 160)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
