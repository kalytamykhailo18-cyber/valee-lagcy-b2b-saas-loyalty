/**
 * E2E for Genesis's 2026-04-24 "Escaneo de QR personal - PWA" ask:
 *
 *   "Al escanear el QR de un cajero, el link que manda el bot solo va al
 *    PWA del comercio pero no lleva identificado el cajero. Tambien debe
 *    reflejarse en el link y cuando haga click vaya al PWA identificado
 *    con persona, y desde alli tambien tener posibilidad de escanear la
 *    factura."
 *
 * Covers the end-to-end chain:
 *   (1) the bot's greeting link carries &cajero=<slug> when the incoming
 *       QR message had `Cjr:` — getStateGreeting emits it directly.
 *   (2) the new POST /api/consumer/staff-attribution registers a
 *       StaffScanSession keyed on the consumer's phone, same row the
 *       invoice pipeline already reads.
 *   (3) invalid slug formats are rejected 400; unknown slugs return
 *       {recorded: false} instead of 404 so a stale URL doesn't break
 *       the PWA landing.
 *   (4) the recorded session carries the correct staffId so a subsequent
 *       invoice validation picks it up.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { getStateGreeting } from '../src/services/whatsapp-bot.js';
import { generateStaffQR } from '../src/services/merchant-qr.js';
import { issueConsumerTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  let body: any = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== PWA cashier attribution E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`PWA Attr ${ts}`, `pwa-attr-${ts}`, `pwa-attr-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  // Cashier with a qrSlug
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cajero Ana', email: `ana-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
    },
  });
  const staffQr = await generateStaffQR(cashier.id);
  const cashierSlug = staffQr.qrSlug;

  // (1) getStateGreeting emits &cajero=<slug>
  const greetingLines = getStateGreeting(
    'first_time',
    tenant.name,
    '0',
    `+19600${String(ts).slice(-7)}`,
    '100',
    tenant.slug,
    null,
    cashierSlug,
  );
  const linkLine = greetingLines.find(l => l.includes('http'));
  await assert('greeting link includes ?tenant= and &cajero=',
    !!linkLine && linkLine.includes(`tenant=${encodeURIComponent(tenant.slug)}`)
      && linkLine.includes(`cajero=${encodeURIComponent(cashierSlug)}`),
    `link=${linkLine}`);

  // greeting WITHOUT cashierSlug should not contain cajero= (regression guard)
  const greetingPlain = getStateGreeting(
    'first_time', tenant.name, '0', `+19601${String(ts).slice(-7)}`,
    '100', tenant.slug, null, null,
  );
  const plainLink = greetingPlain.find(l => l.includes('http'));
  await assert('greeting without cashierSlug keeps the link clean (no cajero)',
    !!plainLink && !plainLink.includes('cajero='),
    `link=${plainLink}`);

  // (2) Consumer lands on PWA, gets authenticated, POSTs the attribution.
  const phone = `+19602${String(ts).slice(-7)}`;
  const { account } = await findOrCreateConsumerAccount(tenant.id, phone);
  const consumerToken = issueConsumerTokens({
    accountId: account.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;

  const recordRes = await http('/api/consumer/staff-attribution', consumerToken, {
    method: 'POST',
    body: JSON.stringify({ cashierSlug }),
  });
  await assert('attribution POST succeeds and returns staff name',
    recordRes.status === 200 && recordRes.body.recorded === true && recordRes.body.staffName === 'Cajero Ana',
    `status=${recordRes.status} body=${JSON.stringify(recordRes.body)}`);

  // DB verification: StaffScanSession row exists for this phone+tenant+staff
  const session = await prisma.staffScanSession.findFirst({
    where: { tenantId: tenant.id, consumerPhone: phone, staffId: cashier.id },
    orderBy: { scannedAt: 'desc' },
  });
  await assert('StaffScanSession row persisted with correct staffId',
    !!session && session!.staffId === cashier.id,
    `session=${session?.id} staffId=${session?.staffId}`);

  // (3a) Invalid slug format → 400
  const bad = await http('/api/consumer/staff-attribution', consumerToken, {
    method: 'POST', body: JSON.stringify({ cashierSlug: 'not a slug!' }),
  });
  await assert('invalid slug format returns 400',
    bad.status === 400, `status=${bad.status}`);

  // (3b) Unknown but well-formed slug → recorded=false, NOT 404
  const unknown = await http('/api/consumer/staff-attribution', consumerToken, {
    method: 'POST', body: JSON.stringify({ cashierSlug: 'zzzzzzzz' }),
  });
  await assert('unknown slug returns recorded=false (no 404)',
    unknown.status === 200 && unknown.body.recorded === false,
    `status=${unknown.status} body=${JSON.stringify(unknown.body)}`);

  // (4) Cross-tenant isolation: a second tenant with a different cashier of
  //     the SAME slug must not resolve.
  const other = await createTenant(`Other ${ts}`, `other-pwa-${ts}`, `other-pwa-${ts}@e2e.local`);
  await createSystemAccounts(other.id);
  const { account: otherAccount } = await findOrCreateConsumerAccount(other.id, phone);
  const otherToken = issueConsumerTokens({
    accountId: otherAccount.id, tenantId: other.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;
  const cross = await http('/api/consumer/staff-attribution', otherToken, {
    method: 'POST', body: JSON.stringify({ cashierSlug }),
  });
  await assert('same slug under a different tenant does NOT resolve',
    cross.status === 200 && cross.body.recorded === false,
    `body=${JSON.stringify(cross.body)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
