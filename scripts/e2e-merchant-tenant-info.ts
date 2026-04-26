/**
 * E2E for Eric's 2026-04-24 cashier-session screenshot: the sidebar was
 * showing the generic "Valee"/"V" fallback instead of the real merchant
 * name and logo. Root cause: /api/merchant/settings is owner-only, so the
 * cashier's fetch came back 403 and the sidebar never updated.
 *
 * /api/merchant/tenant-info is the lightweight replacement that both
 * owner and cashier can read. This E2E verifies:
 *   - cashier can read tenant-info and sees { name, slug, logoUrl }
 *   - owner sees the same payload
 *   - cashier STILL can't read /settings (403) — scope preserved
 *   - cross-tenant isolation still holds
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== Merchant tenant-info (owner + cashier) E2E ===\n');

  const ts = Date.now();
  const tenant = await createTenant(`TInfo ${ts}`, `tinfo-${ts}`, `tinfo-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { logoUrl: 'https://cdn.example/logo.png', plan: 'x10' },
  });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `o-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Cashier', email: `c-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'cashier',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;
  const cashierToken = issueStaffTokens({
    staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff',
  }).accessToken;

  // ── cashier reads tenant-info ──
  const cashierInfo = await http('/api/merchant/tenant-info', cashierToken);
  await assert('cashier can read tenant-info',
    cashierInfo.status === 200
      && cashierInfo.body.name === tenant.name
      && cashierInfo.body.slug === tenant.slug
      && cashierInfo.body.logoUrl === 'https://cdn.example/logo.png',
    `status=${cashierInfo.status} body=${JSON.stringify(cashierInfo.body)}`);

  // ── owner reads the same payload ──
  const ownerInfo = await http('/api/merchant/tenant-info', ownerToken);
  await assert('owner sees the same tenant-info',
    ownerInfo.status === 200 && ownerInfo.body.name === tenant.name,
    `status=${ownerInfo.status}`);

  // ── cashier is STILL locked out of /settings (owner-only) ──
  const cashierSettings = await http('/api/merchant/settings', cashierToken);
  await assert('cashier still blocked from /settings',
    cashierSettings.status === 403,
    `status=${cashierSettings.status}`);

  // ── cross-tenant isolation ──
  const other = await createTenant(`TInfoOther ${ts}`, `tinfo-other-${ts}`, `tinfo-other-${ts}@e2e.local`);
  await createSystemAccounts(other.id);
  const otherOwner = await prisma.staff.create({
    data: {
      tenantId: other.id, name: 'Other', email: `x-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const otherToken = issueStaffTokens({
    staffId: otherOwner.id, tenantId: other.id, role: 'owner', type: 'staff',
  }).accessToken;
  const cross = await http('/api/merchant/tenant-info', otherToken);
  await assert('different tenant sees their own name, not the first tenant',
    cross.status === 200 && cross.body.name === other.name,
    `body=${JSON.stringify(cross.body)}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
