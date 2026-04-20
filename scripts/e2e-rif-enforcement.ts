/**
 * E2E: RIF enforcement (Genesis M1).
 *
 * 1. Fiscal invoices targeted at a tenant with no RIF configured are
 *    rejected by the validation service — no ledger entry, no claim.
 * 2. Admin endpoint /api/admin/tenants-missing-rif surfaces the tenant
 *    in the backfill list.
 * 3. After the owner fills the RIF the tenant drops out of the list.
 * 4. Merchant /api/merchant/metrics carries rifMissing=true/false so
 *    the dashboard can render the reminder banner.
 * 5. /merchant chunk ships the banner copy.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { validateInvoice } from '../src/services/invoice-validation.js';
import { issueStaffTokens, issueAdminTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== RIF enforcement E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  // Tenant with no RIF (simulates an old pre-signup-requirement tenant)
  const tenant = await createTenant(`No Rif ${ts}`, `no-rif-${ts}`, `no-rif-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  await prisma.tenant.update({ where: { id: tenant.id }, data: { rif: null } });

  // Attempt to validate a fiscal invoice with pre-extracted data (skip OCR).
  const result = await validateInvoice({
    senderPhone: `+19000${String(ts).slice(-7)}`,
    tenantId: tenant.id,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `FACT-${ts}`,
      total_amount: 1234.56,
      transaction_date: new Date().toISOString().slice(0, 10),
      customer_phone: null,
      customer_cedula: null,
      merchant_rif: 'J-12345678-9',
      merchant_name: `No Rif ${ts}`,
      document_type: 'fiscal_invoice',
      currency: 'BS',
      payment_reference: null,
      bank_name: null,
      confidence_score: 0.95,
    } as any,
  });

  await assert('fiscal invoice to RIF-less tenant is rejected',
    result.success === false && result.stage === 'merchant_check',
    `success=${result.success} stage=${(result as any).stage}`);
  await assert('rejection message mentions RIF configuration',
    typeof result.message === 'string' && /RIF/i.test(result.message || ''),
    `msg="${result.message?.slice(0, 80)}"`);

  // No ledger entry should exist for this tenant
  const entries = await prisma.ledgerEntry.count({
    where: { tenantId: tenant.id, eventType: 'INVOICE_CLAIMED' },
  });
  await assert('no INVOICE_CLAIMED entry was created', entries === 0, `count=${entries}`);

  // Admin endpoint lists the tenant
  const admin = await prisma.adminUser.findFirstOrThrow();
  const adminToken = issueAdminTokens({ adminId: admin.id, type: 'admin' }).accessToken;
  const r1 = await fetch(`${API}/api/admin/tenants-missing-rif`, {
    headers: { 'Authorization': `Bearer ${adminToken}` },
  });
  const b1: any = await r1.json();
  await assert('/api/admin/tenants-missing-rif 200', r1.status === 200, `status=${r1.status}`);
  await assert('response has count field', typeof b1.count === 'number', `count=${b1.count}`);
  const listed1 = b1.tenants.find((t: any) => t.id === tenant.id);
  await assert('this tenant is in the missing-rif list', !!listed1, `found=${!!listed1}`);

  // Seed an owner + hit /api/merchant/metrics → rifMissing=true
  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `no-rif-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;
  const m1 = await fetch(`${API}/api/merchant/metrics`, {
    headers: { 'Authorization': `Bearer ${ownerToken}` },
  });
  const mBody1: any = await m1.json();
  await assert('metrics carries rifMissing=true when RIF is null',
    mBody1.rifMissing === true, `rifMissing=${mBody1.rifMissing}`);

  // Owner fills the RIF
  await prisma.tenant.update({ where: { id: tenant.id }, data: { rif: 'J-30058671-2' } });

  const r2 = await fetch(`${API}/api/admin/tenants-missing-rif`, {
    headers: { 'Authorization': `Bearer ${adminToken}` },
  });
  const b2: any = await r2.json();
  const listed2 = b2.tenants.find((t: any) => t.id === tenant.id);
  await assert('after filling RIF, tenant drops out of the backfill list',
    !listed2, `still_listed=${!!listed2}`);

  const m2 = await fetch(`${API}/api/merchant/metrics`, {
    headers: { 'Authorization': `Bearer ${ownerToken}` },
  });
  const mBody2: any = await m2.json();
  await assert('metrics flips rifMissing=false once RIF is set',
    mBody2.rifMissing === false, `rifMissing=${mBody2.rifMissing}`);

  // Frontend banner copy ships
  const html = await (await fetch(`${FRONTEND}/merchant`)).text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('/merchant chunk carries "Falta configurar tu RIF"',
    chunkBodies.some(js => js.includes('Falta configurar tu RIF')),
    `scanned=${chunkUrls.length}`);
  await assert('/merchant chunk carries the "Configurar RIF" CTA',
    chunkBodies.some(js => js.includes('Configurar RIF')),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
