/**
 * E2E: consumer logout clears httpOnly cookies server-side.
 *
 * Before the fix, logout() only cleared localStorage. The server-set
 * accessToken + refreshToken cookies stayed alive (refresh TTL = 30 days),
 * so API calls with credentials:'include' still authenticated as the prior
 * user. This test drives the actual HTTP endpoints to confirm the new
 * /api/consumer/auth/logout clears both cookies.
 */

import dotenv from 'dotenv';
dotenv.config();

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

function parseSetCookie(setCookieHeaders: string[] | string | null): Record<string, { value: string; maxAge?: number }> {
  const out: Record<string, { value: string; maxAge?: number }> = {};
  if (!setCookieHeaders) return out;
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const header of arr) {
    const parts = header.split(';').map(s => s.trim());
    const [name, ...valParts] = parts[0].split('=');
    const value = valParts.join('=');
    let maxAge: number | undefined;
    for (const p of parts.slice(1)) {
      const [k, v] = p.split('=');
      if (k.toLowerCase() === 'max-age') maxAge = parseInt(v);
    }
    out[name] = { value, maxAge };
  }
  return out;
}

async function main() {
  // Request OTP + verify for a test phone under a real tenant (smoke-test).
  const phone = `+19500${String(Date.now()).slice(-7)}`;

  const reqOtp = await fetch(`${API}/api/consumer/auth/request-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone, tenantSlug: 'smoke-test' }),
  });
  const otpBody = await reqOtp.json() as any;
  await assert('request-otp OK', reqOtp.status === 200 && otpBody.otp,
    `status=${reqOtp.status} otp=${otpBody.otp?.slice(0,2)}…`);

  const verifyRes = await fetch(`${API}/api/consumer/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone, otp: otpBody.otp, tenantSlug: 'smoke-test' }),
  });
  const verifySetCookies = verifyRes.headers.getSetCookie?.() || verifyRes.headers.get('set-cookie');
  const verifyCookies = parseSetCookie(verifySetCookies as any);
  await assert('verify-otp sets accessToken cookie', !!verifyCookies.accessToken && !!verifyCookies.accessToken.value,
    `accessToken present=${!!verifyCookies.accessToken}`);
  await assert('verify-otp sets refreshToken cookie', !!verifyCookies.refreshToken && !!verifyCookies.refreshToken.value,
    `refreshToken present=${!!verifyCookies.refreshToken}`);

  // Now hit logout and verify both cookies are cleared (Max-Age=0 or empty value).
  const logoutRes = await fetch(`${API}/api/consumer/auth/logout`, { method: 'POST' });
  const logoutSetCookies = logoutRes.headers.getSetCookie?.() || logoutRes.headers.get('set-cookie');
  const logoutCookies = parseSetCookie(logoutSetCookies as any);

  await assert('logout returns 200', logoutRes.status === 200, `status=${logoutRes.status}`);
  await assert('logout clears accessToken (Max-Age=0 or empty)',
    !!logoutCookies.accessToken && (logoutCookies.accessToken.maxAge === 0 || logoutCookies.accessToken.value === ''),
    `maxAge=${logoutCookies.accessToken?.maxAge} value="${logoutCookies.accessToken?.value}"`);
  await assert('logout clears refreshToken (Max-Age=0 or empty)',
    !!logoutCookies.refreshToken && (logoutCookies.refreshToken.maxAge === 0 || logoutCookies.refreshToken.value === ''),
    `maxAge=${logoutCookies.refreshToken?.maxAge} value="${logoutCookies.refreshToken?.value}"`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
