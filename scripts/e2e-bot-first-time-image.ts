/**
 * E2E for Eric's 2026-04-23 urgent WhatsApp:
 *
 *   "estamos verificando el codigo de referido y al enviar la primera
 *    factura no la quiere leer, envia constantemente ese mensaje de
 *    bienvenida."
 *
 * Root cause: handleIncomingMessage short-circuited on `state === 'first_time'`
 * BEFORE the image handler. Since a fresh referee just got their welcome bonus
 * but no INVOICE_CLAIMED yet, detectConversationState kept returning
 * first_time for ~2h, so every factura photo in that window bounced back
 * with "¡Ganaste X puntos de bienvenida!" instead of being validated.
 *
 * The fix carves out `messageType !== 'image'` from the first_time
 * short-circuit so photos always flow into validateInvoice. This test locks
 * it in.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { grantWelcomeBonus } from '../src/services/welcome-bonus.js';
import { handleIncomingMessage } from '../src/services/whatsapp-bot.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== first_time image routes to validation, not welcome E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`FT Image ${ts}`, `ft-img-${ts}`, `ft-img-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  // Simulate the referee landing via referral: account created + welcome
  // bonus granted. detectConversationState will still return first_time for
  // ~2h because there's no INVOICE_CLAIMED yet.
  const phone = `+19400${String(ts).slice(-7)}`;
  const { account } = await findOrCreateConsumerAccount(tenant.id, phone);
  const grant = await grantWelcomeBonus(account.id, tenant.id, asset.id);
  await assert('welcome bonus granted on account creation',
    grant.granted === true,
    `granted=${grant.granted} amount=${grant.amount}`);

  // ── Step 1: a text message in first_time correctly returns the welcome greeting ──
  const textReply = await handleIncomingMessage({
    phoneNumber: phone,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: 'hola',
  });
  const textJoined = textReply.join('\n');
  await assert('text "hola" in first_time still returns welcome greeting',
    /puntos de bienvenida/i.test(textJoined),
    `reply=${textJoined.slice(0, 80)}`);

  // ── Step 2: an image message in first_time must flow to the invoice
  //    pipeline, NOT re-send the welcome greeting. We pass no imageBuffer
  //    so the handler hits its "no imageBuffer" branch — the signal we
  //    want is that the response does NOT contain "puntos de bienvenida".
  const imageReply = await handleIncomingMessage({
    phoneNumber: phone,
    tenantId: tenant.id,
    messageType: 'image',
    // imageBuffer intentionally omitted
  });
  const imageJoined = imageReply.join('\n');
  await assert('image in first_time does NOT return welcome greeting',
    !/puntos de bienvenida/i.test(imageJoined),
    `reply=${imageJoined.slice(0, 120)}`);
  await assert('image in first_time reaches the invoice-handler branch',
    /no pudimos procesarla|enviala de nuevo|analizando|factura|intentar/i.test(imageJoined),
    `reply=${imageJoined.slice(0, 120)}`);

  // ── Step 3: once the referee has a real INVOICE_CLAIMED their state
  //    flips off first_time, and future text messages should NOT re-greet.
  //    (This protects the intended UX for the happy path too.)
  // Insert a synthetic INVOICE_CLAIMED so detectConversationState stops
  // returning first_time.
  const { getSystemAccount } = await import('../src/services/accounts.js');
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;
  const { writeDoubleEntry } = await import('../src/services/ledger.js');
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id,
    creditAccountId: account.id,
    amount: '10',
    assetTypeId: asset.id,
    referenceId: `TEST-CLAIM-${ts}`,
    referenceType: 'invoice',
    metadata: { test: true },
  });

  const textReply2 = await handleIncomingMessage({
    phoneNumber: phone,
    tenantId: tenant.id,
    messageType: 'text',
    messageText: 'hola',
  });
  const text2Joined = textReply2.join('\n');
  await assert('after first claim, text "hola" no longer lands on first_time greeting',
    !/puntos de bienvenida/i.test(text2Joined),
    `reply=${text2Joined.slice(0, 120)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
