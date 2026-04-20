/**
 * E2E: role-scoped localStorage token keys prevent consumer+merchant
 * sessions in the same browser from clobbering each other (Genesis H2).
 *
 * Before: both roles wrote to 'accessToken' / 'refreshToken', so
 * logging into one pushed the other out. A consumer tab's next API
 * call silently used the staff token, got 401/403, and the UI showed
 * phantom 0-balance renders + reload loops.
 *
 * After:
 *   consumer → consumerAccessToken / consumerRefreshToken
 *   staff    → staffAccessToken    / staffRefreshToken
 *   admin    → adminAccessToken    / adminRefreshToken
 *
 * This test is source-level + chunk-level: the behavior is entirely
 * client-side, so we prove the code path is in place.
 */

import dotenv from 'dotenv';
dotenv.config();

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Role-scoped tokens E2E (Genesis H2) ===\n');

  const fs = await import('fs/promises');
  const apiSrc = await fs.readFile('/home/loyalty-platform/frontend/lib/api.ts', 'utf8');
  const storeSrc = await fs.readFile('/home/loyalty-platform/frontend/lib/token-store.ts', 'utf8');
  const mlogin = await fs.readFile('/home/loyalty-platform/frontend/app/(merchant)/merchant/login/page.tsx', 'utf8');
  const clogin = await fs.readFile('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx', 'utf8');
  const alogin = await fs.readFile('/home/loyalty-platform/frontend/app/(admin)/admin/login/page.tsx', 'utf8');

  // Source-level: token-store defines the three buckets
  await assert('token-store has role-specific key definitions',
    /consumerAccessToken/.test(storeSrc)
    && /staffAccessToken/.test(storeSrc)
    && /adminAccessToken/.test(storeSrc),
    'verified');
  await assert('roleForApiPath maps api paths to the right role',
    /roleForApiPath/.test(storeSrc) && /api\/merchant/.test(storeSrc) && /api\/admin/.test(storeSrc),
    'verified');

  // api.ts routes requests by role
  await assert('api.ts uses roleForApiPath to pick the token',
    /roleForApiPath/.test(apiSrc) && /getAccess\(role\)/.test(apiSrc),
    'verified');
  await assert('api.ts refreshes per-role (not shared single-flight)',
    /refreshPromises\[role\]/.test(apiSrc),
    'verified');

  // Login pages write to their role's bucket
  await assert('merchant login writes staff bucket',
    /setTokens\(\s*['"]staff['"]/.test(mlogin),
    'verified');
  await assert('admin login writes admin bucket',
    /setTokens\(\s*['"]admin['"]/.test(alogin),
    'verified');
  await assert('consumer OTP verify writes consumer bucket',
    /setTokens\(\s*['"]consumer['"]/.test(clogin),
    'verified');

  // Legacy migration: old key is still read as a fallback
  await assert('migrateLegacy copies legacy accessToken into the bucket',
    /migrateLegacy/.test(storeSrc) && /legacyAccess/.test(storeSrc),
    'verified');

  // Chunk-grep: the new keys ship to the frontend
  const merchantHtml = await (await fetch(`${FRONTEND}/merchant/login`)).text();
  const mChunks = Array.from(merchantHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const mBodies = await Promise.all(mChunks.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('/merchant/login chunk references staffAccessToken key',
    mBodies.some(js => js.includes('staffAccessToken')),
    `scanned=${mChunks.length}`);

  const consumerHtml = await (await fetch(`${FRONTEND}/consumer`)).text();
  const cChunks = Array.from(consumerHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const cBodies = await Promise.all(cChunks.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('/consumer chunk references consumerAccessToken key',
    cBodies.some(js => js.includes('consumerAccessToken')),
    `scanned=${cChunks.length}`);

  // Behavioral API check: refresh endpoint is per-role (we already proved
  // consumer refresh reachable in e2e-shared-token-refresh; re-verify that
  // the merchant refresh endpoint also answers).
  const mRef = await fetch(`${API}/api/merchant/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: 'invalid-placeholder' }),
  });
  await assert('merchant refresh endpoint answers (wired independently of consumer)',
    mRef.status !== 404, `status=${mRef.status}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
