/**
 * E2E for Genesis's 2026-04-24 report:
 *
 *   "El QR de Pago en efectivo sigue en formato viejo (muchos pixeles) y
 *    no lo lockean las camaras."
 *
 * Root cause: initiateDualScan returned a base64-encoded JSON HMAC token
 * (~500 chars). The PWA embeds it in the QR value as
 *   https://valee.app/scan?dual=<token>
 * → total QR payload ~550 chars → QR version ~14 with tiny modules.
 *
 * Fix: persist the session in dual_scan_sessions keyed on a 16-char
 * nonce; the QR now carries only the nonce. Legacy HMAC path still
 * accepted for 60s of transition.
 *
 * Checks:
 *   (1) initiateDualScan returns a short nonce (<=32 chars), not a
 *       multi-hundred-char HMAC token.
 *   (2) A DualScanSession row exists with status=pending.
 *   (3) Consumer confirming with the nonce succeeds and creates a
 *       PRESENCE_VALIDATED ledger entry keyed on DUALSCAN-<nonce>.
 *   (4) The session row transitions to status=used; re-confirm rejects.
 *   (5) Legacy base64 HMAC token still confirms (backward compat).
 *   (6) Bad nonce (unknown 16-char) rejected cleanly.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { initiateDualScan, confirmDualScan } from '../src/services/dual-scan.js';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

function legacyHmacToken(payload: any): string {
  const json = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', process.env.HMAC_SECRET!).update(json).digest('hex');
  return Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
}

async function main() {
  console.log('=== Dual-scan short QR E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`DS ${ts}`, `ds-${ts}`, `ds-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cajera', email: `cashier-ds-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
    },
  });

  // (1) initiate returns a short nonce
  const init = await initiateDualScan({
    tenantId: tenant.id,
    cashierId: cashier.id,
    branchId: null,
    amount: '10',
    assetTypeId: asset.id,
  });
  await assert('initiateDualScan succeeds',
    init.success === true && typeof init.token === 'string',
    `success=${init.success} token.length=${init.token?.length}`);
  await assert('token is a short nonce (<=32 chars) — old format was 400+',
    (init.token?.length ?? 0) <= 32,
    `len=${init.token?.length}`);

  // (2) Session row persisted
  const session = await prisma.dualScanSession.findUnique({ where: { nonce: init.token! }});
  await assert('dual_scan_sessions row exists with status=pending',
    !!session && session!.status === 'pending',
    `status=${session?.status}`);

  // (3) Consumer confirms with the nonce → PRESENCE_VALIDATED row appears
  const phone = `+19730${String(ts).slice(-7)}`;
  const confirmRes = await confirmDualScan({ token: init.token!, consumerPhone: phone });
  await assert('consumer confirm with short nonce succeeds',
    confirmRes.success === true, `msg=${confirmRes.message}`);
  const ledger = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, referenceId: `DUALSCAN-${init.token}` },
  });
  await assert('PRESENCE_VALIDATED ledger row keyed on DUALSCAN-<nonce> exists',
    !!ledger, `ledger=${!!ledger}`);

  // (4) Session marked used; re-confirm rejects
  const sessionAfter = await prisma.dualScanSession.findUnique({ where: { nonce: init.token! }});
  await assert('session row transitioned to status=used',
    sessionAfter?.status === 'used', `status=${sessionAfter?.status}`);
  const reConfirm = await confirmDualScan({ token: init.token!, consumerPhone: phone });
  await assert('re-confirm with same nonce rejects',
    reConfirm.success === false, `msg=${reConfirm.message}`);

  // (5) Legacy base64 HMAC token still confirms
  const legacyNonce = crypto.randomBytes(8).toString('hex');
  const legacyToken = legacyHmacToken({
    tenantId: tenant.id,
    branchId: null,
    cashierId: cashier.id,
    amount: '5',
    assetTypeId: asset.id,
    expiresAt: Date.now() + 60_000,
    nonce: legacyNonce,
  });
  await assert('legacy HMAC token shape is long (sanity)',
    legacyToken.length > 200, `len=${legacyToken.length}`);

  const phone2 = `+19731${String(ts).slice(-7)}`;
  const legacyConfirm = await confirmDualScan({ token: legacyToken, consumerPhone: phone2 });
  await assert('legacy HMAC token still confirms (backward compat)',
    legacyConfirm.success === true, `msg=${legacyConfirm.message}`);

  // (6) Unknown nonce rejected
  const bogus = 'deadbeefcafebabe';
  const bad = await confirmDualScan({ token: bogus, consumerPhone: phone });
  await assert('unknown nonce is rejected',
    bad.success === false, `msg=${bad.message}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
