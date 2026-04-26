/**
 * E2E: the new shorter QR payload still carries the markers the webhook
 * parses (Ref:/Cjr:/Ref2U:). Also asserts the encoded URL length dropped
 * substantially so the QR version drops from ~10 to ~3-4.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import {
  generateWhatsAppDeepLink,
  generateStaffQR,
  generateBranchQR,
  generateReferralQR,
} from '../src/services/merchant-qr.js';
import bcrypt from 'bcryptjs';

const REF_RE = /Ref:\s*([a-z0-9][a-z0-9-]{0,48}[a-z0-9])(?:\/([a-f0-9-]+))?/i;
const CJR_RE = /Cjr:\s*([a-z0-9]{4,16})/i;
const REF2U_RE = /Ref2U:\s*([a-z0-9]{4,16})/i;

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

function decodedText(deepLink: string): string {
  const m = deepLink.match(/[?&]text=([^&]+)/);
  return decodeURIComponent(m?.[1] || '');
}

async function main() {
  console.log('=== Short-payload QR E2E ===\n');

  const ts = Date.now();
  const tenant = await createTenant(`Short QR ${ts}`, `short-${ts}`, `short-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);

  // ── Tenant deep link ──
  const tenantLink = await generateWhatsAppDeepLink(tenant.slug, tenant.name);
  const tenantText = decodedText(tenantLink);
  await assert('tenant payload is under 40 chars',
    tenantText.length < 40, `len=${tenantText.length} text="${tenantText}"`);
  await assert('tenant payload carries Ref: marker',
    REF_RE.test(tenantText) && (tenantText.match(REF_RE)![1] === tenant.slug),
    `match=${tenantText.match(REF_RE)?.[1]}`);
  await assert('tenant payload is ASCII-only (no emoji)',
    !/[^\x00-\x7f]/.test(tenantText), `text="${tenantText}"`);
  await assert('tenant deep link URL is under 80 chars',
    tenantLink.length < 80, `len=${tenantLink.length}`);

  // ── Staff QR ──
  const staff = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cajero Test', email: `c-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
    },
  });
  const staffQr = await generateStaffQR(staff.id);
  const staffText = decodedText(staffQr.deepLink);
  await assert('staff payload carries Ref: and Cjr: markers',
    REF_RE.test(staffText) && CJR_RE.test(staffText)
      && staffText.match(REF_RE)![1] === tenant.slug
      && staffText.match(CJR_RE)![1] === staffQr.qrSlug,
    `text="${staffText}"`);
  await assert('staff payload is under 55 chars',
    staffText.length < 55, `len=${staffText.length}`);

  // ── Branch QR ──
  const branch = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal A', active: true },
  });
  const branchQr = await generateBranchQR(branch.id);
  const branchText = decodedText(branchQr.deepLink);
  await assert('branch payload carries Ref: slug/branchId',
    REF_RE.test(branchText) && branchText.match(REF_RE)![1] === tenant.slug
      && branchText.match(REF_RE)![2] === branch.id,
    `text="${branchText}"`);
  await assert('branch payload under 85 chars (uuid dominates)',
    branchText.length < 85, `len=${branchText.length}`);

  // ── Referral QR ──
  const refQr = await generateReferralQR({
    merchantSlug: tenant.slug,
    merchantName: tenant.name,
    referralSlug: 'abcd1234',
  });
  const refText = decodedText(refQr.deepLink);
  await assert('referral payload carries Ref: and Ref2U: markers',
    REF_RE.test(refText) && REF2U_RE.test(refText)
      && refText.match(REF_RE)![1] === tenant.slug
      && refText.match(REF2U_RE)![1] === 'abcd1234',
    `text="${refText}"`);
  await assert('referral payload is under 65 chars',
    refText.length < 65, `len=${refText.length}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
