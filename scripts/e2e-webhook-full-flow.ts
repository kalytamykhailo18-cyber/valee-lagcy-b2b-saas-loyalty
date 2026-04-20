/**
 * E2E: Meta webhook full flow with real HMAC signatures.
 *
 * Proves the entire inbound pipeline works under the signature
 * verification: the request passes preHandler, the webhook parses the
 * payload, the expected side effects land in the DB (merchant scan
 * session, consumer account, staff scan session, pending referral,
 * welcome bonus), and the outbound WhatsApp reply flow is exercised
 * (best-effort — Meta rejects fake phones, which is fine).
 *
 * Covers three realistic inbound scenarios:
 *   A. Merchant QR scan: "Hola, quiero ganar puntos en X Ref: <slug>"
 *   B. Referral scan:    same format + Ref2U: <referrer_slug>
 *   C. Staff QR scan:    same format + Cjr: <staff_slug>
 *
 * Image-based invoice submission is out of scope here (it requires
 * downloading media from Meta, which needs a real access token). The
 * signed-request verification for images is already covered by
 * e2e-webhook-signature.ts; this script exercises the handler beyond
 * the signature check.
 */

import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';
const SECRET = process.env.META_APP_SECRET;
if (!SECRET) { console.error('META_APP_SECRET missing'); process.exit(1); }

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

function signed(payloadObj: unknown): { body: string; sig: string } {
  const body = JSON.stringify(payloadObj);
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET!).update(body).digest('hex');
  return { body, sig };
}

async function sendTextMessage(phone: string, text: string, profileName = 'E2E Tester') {
  const msgId = `wamid.E2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'E2E',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '584000000000', phone_number_id: 'E2E_PHONE_ID' },
          contacts: [{ profile: { name: profileName }, wa_id: phone.replace(/\D/g, '') }],
          messages: [{
            from: phone.replace(/\D/g, ''),
            id: msgId,
            timestamp: Math.floor(Date.now() / 1000).toString(),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
  const { body, sig } = signed(payload);
  const res = await fetch(`${API}/api/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body,
  });
  return { status: res.status, msgId };
}

async function main() {
  console.log('=== Meta webhook full-flow E2E ===\n');

  const ts = Date.now();

  // Fresh tenant so we don't collide with existing scan sessions/accounts.
  const tenant = await createTenant(`Webhook M3 ${ts}`, `webhook-full-${ts}`, `webhook-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  const asset = await prisma.assetType.findFirstOrThrow();
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  // Welcome bonus > 0 so scenario A exercises the grantWelcomeBonus path.
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { welcomeBonusAmount: 25 },
  });

  // ── Scenario A: merchant QR scan ──
  const phoneA = `+19500${String(ts).slice(-7)}1`;
  const textA = `Hola, quiero ganar puntos en ${tenant.name}. Ref: ${tenant.slug}`;

  const resA = await sendTextMessage(phoneA, textA);
  await assert('A: signed merchant-QR message accepted', resA.status === 200, `status=${resA.status}`);

  const sessionA = await prisma.merchantScanSession.findFirst({
    where: { tenantId: tenant.id, consumerPhone: phoneA },
    orderBy: { scannedAt: 'desc' },
  });
  await assert('A: merchant_scan_session row created', !!sessionA, `id=${sessionA?.id?.slice(0,8)}`);

  const accountA = await prisma.account.findFirst({
    where: { tenantId: tenant.id, phoneNumber: phoneA },
  });
  await assert('A: shadow consumer account created', !!accountA, `id=${accountA?.id?.slice(0,8)}`);
  await assert('A: account got welcome bonus', accountA?.welcomeBonusGranted === true,
    `welcomeBonusGranted=${accountA?.welcomeBonusGranted}`);

  // ── Scenario B: referral scan ──
  // Set up a referrer: create their account + assign a referralSlug.
  const referrerPhone = `+19500${String(ts).slice(-7)}R`;
  const { account: referrer } = await findOrCreateConsumerAccount(tenant.id, referrerPhone);
  // Ensure referralSlug exists on the referrer
  const { ensureReferralSlug } = await import('../src/services/referrals.js');
  const refSlug = await ensureReferralSlug(referrer.id);

  const phoneB = `+19500${String(ts).slice(-7)}2`;
  const textB = `Hola, vengo por invitacion. Ref: ${tenant.slug} Ref2U: ${refSlug}`;

  const resB = await sendTextMessage(phoneB, textB);
  await assert('B: signed referral message accepted', resB.status === 200, `status=${resB.status}`);

  const accountB = await prisma.account.findFirst({
    where: { tenantId: tenant.id, phoneNumber: phoneB },
  });
  await assert('B: referee account created', !!accountB, `id=${accountB?.id?.slice(0,8)}`);

  const referral = await prisma.referral.findFirst({
    where: { tenantId: tenant.id, refereeAccountId: accountB?.id },
  });
  await assert('B: pending referral row recorded', referral?.status === 'pending',
    `status=${referral?.status}`);
  await assert('B: referral links to the right referrer', referral?.referrerAccountId === referrer.id,
    `referrer=${referral?.referrerAccountId?.slice(0,8)}`);

  // Referee got their welcome bonus too (the fix we shipped earlier).
  await assert('B: referee got welcome bonus', accountB?.welcomeBonusGranted === true,
    `welcomeBonusGranted=${accountB?.welcomeBonusGranted}`);

  // ── Scenario C: staff QR scan ──
  // Create a staff member with a qrSlug.
  const bcrypt = await import('bcryptjs');
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id,
      email: `cashier-${ts}@e2e.local`,
      name: 'E2E Cashier',
      passwordHash: await bcrypt.default.hash('cashier-pass', 10),
      role: 'cashier',
      active: true,
      qrSlug: `c${String(ts).slice(-10)}`,
      qrCodeUrl: 'https://e2e.local/cashier-qr.png',
    },
  });

  const phoneC = `+19500${String(ts).slice(-7)}3`;
  const textC = `Hola, ${tenant.name}. Ref: ${tenant.slug} Cjr: ${cashier.qrSlug}`;

  const resC = await sendTextMessage(phoneC, textC);
  await assert('C: signed staff-QR message accepted', resC.status === 200, `status=${resC.status}`);

  const staffSession = await prisma.staffScanSession.findFirst({
    where: { tenantId: tenant.id, consumerPhone: phoneC, staffId: cashier.id },
    orderBy: { scannedAt: 'desc' },
  });
  await assert('C: staff_scan_session row created', !!staffSession,
    `staffId=${staffSession?.staffId?.slice(0,8)}`);

  // ── Negative: same-shape payload with tampered body should 401 ──
  const msgId = `wamid.E2E-tampered-${ts}`;
  const goodPayload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'E2E', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      contacts: [{ profile: { name: 'T' }, wa_id: '1' }],
      messages: [{ from: '1', id: msgId, timestamp: '1', type: 'text', text: { body: 'hi' } }],
    } }] }],
  };
  const { sig: goodSig } = signed(goodPayload);
  const tamperedBody = JSON.stringify({ ...goodPayload, extra: 'gotcha' });
  const resD = await fetch(`${API}/api/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': goodSig },
    body: tamperedBody,
  });
  await assert('D: tampered body with good-shape signature → 401', resD.status === 401,
    `status=${resD.status}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
