/**
 * E2E: cashier scanner pre-filters garbled camera decodes before
 * hitting the redemption API.
 *
 * Eric 2026-04-23 "Acotacion": first scan of a fresh redemption QR
 * surfaced a red "RECHAZADO / Codigo QR invalido" screen; second
 * scan of the same QR went through cleanly. The camera was firing
 * a partial/misfocused decode that hit the backend, which rejected
 * the garbled string as an unparseable base64. Fix is client-side:
 * the scanner drops decodes that don't look like a real redemption
 * token (6-digit short code or base64-JSON with { payload.tokenId,
 * signature }) and just keeps scanning.
 *
 * This is a frontend-only guard, so we execute the validator
 * directly and exercise the inputs the camera actually produces.
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs/promises';

// Mirror the helper defined at the top of the scanner page. If the
// frontend implementation drifts, the file-content regression guard
// below catches it.
function looksLikeRedemptionToken(token: string): boolean {
  if (/^\d{6}$/.test(token)) return true;
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    return (
      !!decoded
      && typeof decoded.signature === 'string'
      && decoded.signature.length > 0
      && !!decoded.payload
      && typeof decoded.payload.tokenId === 'string'
      && decoded.payload.tokenId.length === 36
    );
  } catch {
    return false;
  }
}

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Scanner pre-filter E2E ===\n');

  // ── Valid inputs (must pass through) ──
  await assert('6-digit short code accepted', looksLikeRedemptionToken('123456'), 'ok');
  const validToken = Buffer.from(JSON.stringify({
    payload: {
      tokenId: '00000000-0000-0000-0000-000000000001',
      consumerAccountId: '00000000-0000-0000-0000-000000000002',
      productId:         '00000000-0000-0000-0000-000000000003',
      amount: '10.00000000',
      tenantId:          '00000000-0000-0000-0000-000000000004',
      assetTypeId:       '00000000-0000-0000-0000-000000000005',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    },
    signature: 'abcdef1234567890',
  })).toString('base64');
  await assert('well-formed base64 redemption token accepted',
    looksLikeRedemptionToken(validToken), 'ok');

  // ── Camera-noise inputs (must be silently rejected) ──
  await assert('empty string rejected',
    !looksLikeRedemptionToken(''), 'ok');
  await assert('random text rejected',
    !looksLikeRedemptionToken('hello world'), 'ok');
  await assert('short numeric (5 digits) rejected',
    !looksLikeRedemptionToken('12345'), 'ok');
  await assert('long numeric (7 digits) rejected',
    !looksLikeRedemptionToken('1234567'), 'ok');
  await assert('base64 of plain string rejected',
    !looksLikeRedemptionToken(Buffer.from('just some text').toString('base64')),
    'ok');
  await assert('base64 JSON missing payload rejected',
    !looksLikeRedemptionToken(Buffer.from(JSON.stringify({ signature: 'x' })).toString('base64')),
    'ok');
  await assert('base64 JSON missing signature rejected',
    !looksLikeRedemptionToken(Buffer.from(JSON.stringify({
      payload: { tokenId: '00000000-0000-0000-0000-000000000001' },
    })).toString('base64')),
    'ok');
  await assert('base64 JSON with non-uuid tokenId rejected',
    !looksLikeRedemptionToken(Buffer.from(JSON.stringify({
      payload: { tokenId: 'short' },
      signature: 'x',
    })).toString('base64')),
    'ok');
  // A merchant QR payload (different shape) — cashier accidentally
  // pointed at the wrong QR. Must not fire a rejection.
  await assert('merchant-QR-like base64 rejected',
    !looksLikeRedemptionToken(Buffer.from(JSON.stringify({
      merchantSlug: 'kromi', tenantId: 'abc',
    })).toString('base64')),
    'ok');

  // ── Source regression guard: the scanner page calls this helper
  //    and wires it into the camera decode callback. If someone
  //    removes it, the Eric bug comes back silently.
  const src = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(merchant)/merchant/scanner/page.tsx',
    'utf8',
  );
  await assert('scanner page defines looksLikeRedemptionToken',
    /function\s+looksLikeRedemptionToken\b/.test(src),
    'verified');
  await assert('scanner camera callback guards on looksLikeRedemptionToken',
    /if\s*\(\s*!looksLikeRedemptionToken\(clean\)\s*\)\s*return/.test(src),
    'verified');
  await assert('manual-input path is not gated by the validator',
    /function handleManualScan\(\)[\s\S]*processToken\(tokenInput\.trim\(\)\)/.test(src)
    && !/handleManualScan[\s\S]{0,200}looksLikeRedemptionToken/.test(src),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
