/**
 * E2E: merchant can configure a RIF via the settings endpoint, and the
 * invoice validation pipeline then rejects any fiscal_invoice that doesn't
 * carry that exact RIF.
 *
 * Scenarios:
 *   1. Signup a merchant → settings.rif is null
 *   2. PUT /merchant/settings with rif → response stores canonical format
 *   3. PUT with malformed RIF → 400
 *   4. PUT with empty string clears the RIF
 *   5. Submit invoice with matching merchant_rif → success
 *   6. Submit invoice with different merchant_rif → rejected ("no coincide")
 *   7. Submit fiscal_invoice with no merchant_rif at all → rejected
 *      ("no logramos identificar el RIF")
 *   8. Mobile-payment (non-fiscal) invoice with no RIF → NOT rejected for
 *      missing RIF (the guard only applies to fiscal_invoice docs)
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { validateInvoice } from '../src/services/invoice-validation.js';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log('=== Merchant RIF configuration + validation E2E ===\n');

  const ts = Date.now();
  const merchantRif = `J-${String(ts).slice(-9).padStart(9, '0')}-1`;

  // Signup to get a real owner token.
  const signup = await http('/api/merchant/signup', null, {
    method: 'POST',
    body: JSON.stringify({
      businessName: `RIF E2E ${ts}`,
      ownerName: 'RIF Owner',
      ownerEmail: `rif-${ts}@e2e.local`,
      password: 'passw0rd-rif',
    }),
  });
  await assert('signup ok', signup.status === 200, `status=${signup.status}`);
  const ownerToken = signup.body.accessToken as string;
  const tenantId = signup.body.tenant.id as string;

  // Fresh tenant has no RIF
  const s0 = await http('/api/merchant/settings', ownerToken);
  await assert('settings.rif starts null', s0.body.rif === null, `rif=${s0.body.rif}`);

  // Malformed RIF rejected
  const bad = await http('/api/merchant/settings', ownerToken, {
    method: 'PUT', body: JSON.stringify({ rif: 'not a rif' }),
  });
  await assert('malformed RIF rejected with 400', bad.status === 400, `status=${bad.status}`);

  // Set a valid RIF
  const put = await http('/api/merchant/settings', ownerToken, {
    method: 'PUT', body: JSON.stringify({ rif: merchantRif }),
  });
  await assert('valid RIF accepted', put.status === 200, `status=${put.status}`);

  const s1 = await http('/api/merchant/settings', ownerToken);
  await assert('settings.rif persisted in canonical form',
    s1.body.rif === merchantRif, `rif=${s1.body.rif}`);

  // ── Submit invoice whose OCR says a DIFFERENT RIF ──
  const asset = await prisma.assetType.findFirstOrThrow();
  const wrongRif = 'J-987654321-0';
  const imgMismatch = Buffer.from(`rif-mismatch-${ts}`);
  const rMismatch = await validateInvoice({
    tenantId,
    senderPhone: `+19400${String(ts).slice(-7)}1`,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `RIF-MISMATCH-${ts}`,
      total_amount: 50,
      transaction_date: new Date().toISOString(),
      customer_phone: null,
      merchant_name: 'Impostor Store',
      merchant_rif: wrongRif,
      currency: 'USD',
      document_type: 'fiscal_invoice',
      confidence_score: 0.99,
    },
    ocrRawText: `IMPOSTOR ${wrongRif}`,
    imageBuffer: imgMismatch,
  });
  await assert('mismatched RIF → rejected', rMismatch.success === false,
    `stage=${rMismatch.stage} msg="${rMismatch.message?.slice(0, 80)}"`);
  await assert('mismatch message mentions "no coincide"',
    /no coincide/i.test(rMismatch.message || ''), `msg="${rMismatch.message}"`);

  // ── Submit fiscal invoice with NO RIF in the image ──
  const imgMissing = Buffer.from(`rif-missing-${ts}`);
  const rMissing = await validateInvoice({
    tenantId,
    senderPhone: `+19400${String(ts).slice(-7)}2`,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `RIF-MISSING-${ts}`,
      total_amount: 50,
      transaction_date: new Date().toISOString(),
      customer_phone: null,
      merchant_name: 'No RIF Shop',
      merchant_rif: null,
      currency: 'USD',
      document_type: 'fiscal_invoice',
      confidence_score: 0.99,
    },
    ocrRawText: `NO RIF ${ts}`,
    imageBuffer: imgMissing,
  });
  await assert('fiscal invoice with no RIF → rejected', rMissing.success === false,
    `stage=${rMissing.stage}`);
  await assert('missing-RIF message asks for clearer photo',
    /RIF del comercio/i.test(rMissing.message || ''), `msg="${rMissing.message}"`);

  // ── Submit invoice with matching RIF ──
  const imgOk = Buffer.from(`rif-ok-${ts}`);
  const rOk = await validateInvoice({
    tenantId,
    senderPhone: `+19400${String(ts).slice(-7)}3`,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `RIF-OK-${ts}`,
      total_amount: 50,
      transaction_date: new Date().toISOString(),
      customer_phone: null,
      merchant_name: 'RIF E2E',
      merchant_rif: merchantRif,
      currency: 'USD',
      document_type: 'fiscal_invoice',
      confidence_score: 0.99,
    },
    ocrRawText: `RIF OK ${merchantRif}`,
    imageBuffer: imgOk,
  });
  await assert('matching RIF → success', rOk.success === true,
    `stage=${rOk.stage} msg="${rOk.message?.slice(0, 60)}"`);

  // ── Mobile-payment document (non-fiscal) with NO RIF shouldn't be blocked
  // for that reason — the RIF guard is fiscal_invoice only. It may still be
  // rejected for OTHER reasons (e.g. presence trust level), but the error
  // message should NOT be about RIF. ──
  const imgMobile = Buffer.from(`rif-mobile-${ts}`);
  const rMobile = await validateInvoice({
    tenantId,
    senderPhone: `+19400${String(ts).slice(-7)}4`,
    assetTypeId: asset.id,
    extractedData: {
      invoice_number: `MOBILE-${ts}`,
      total_amount: 50,
      transaction_date: new Date().toISOString(),
      customer_phone: null,
      merchant_name: null,
      merchant_rif: null,
      currency: 'USD',
      document_type: 'mobile_payment',
      confidence_score: 0.99,
      bank_name: 'Banco Venezuela',
      payment_reference: `REF-${ts}`,
    },
    ocrRawText: `MOBILE ${ts}`,
    imageBuffer: imgMobile,
  });
  // Either success OR rejected-for-other-reason is fine; we just assert the
  // rejection (if any) isn't about missing RIF.
  const rejectedForRif = !rMobile.success && /RIF/i.test(rMobile.message || '');
  await assert('mobile_payment not rejected for missing RIF',
    !rejectedForRif, `success=${rMobile.success} msg="${rMobile.message?.slice(0, 60)}"`);

  // Clear the RIF by sending empty string
  const clear = await http('/api/merchant/settings', ownerToken, {
    method: 'PUT', body: JSON.stringify({ rif: '' }),
  });
  await assert('clearing RIF with empty string → 200', clear.status === 200, `status=${clear.status}`);
  const s2 = await http('/api/merchant/settings', ownerToken);
  await assert('settings.rif null after clear', s2.body.rif === null, `rif=${s2.body.rif}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
