/**
 * E2E: per-endpoint rate limits return 429 when over the threshold.
 *
 * Covers:
 *   - POST /api/merchant/auth/login      → 10/min per IP
 *   - POST /api/admin/auth/login          → 5/min  per IP
 *   - POST /api/merchant/signup           → 5/10min per IP
 *   - POST /api/consumer/auth/request-otp → 10/10min per IP
 *   - Confirms 429 response carries retryAfterSeconds
 *   - Confirms /api/health is NOT rate-limited (skipped via allowList)
 *
 * Uses a unique fake X-Forwarded-For per flow so each flow starts with a
 * fresh bucket. Don't run on a real production IP unless you want the real
 * caller locked out for the window duration.
 */

import dotenv from 'dotenv';
dotenv.config();

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function hit(path: string, ip: string, body: any) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch {}
  return { status: res.status, body: parsed };
}

async function flow_merchant_login() {
  const ip = `10.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
  const LIMIT = 10;
  let last429: any = null;
  let okOrAuthFail = 0;

  // Fire LIMIT+2 requests. The first LIMIT should pass the rate limiter (and
  // return 401 for bad credentials). Calls beyond that must return 429.
  for (let i = 0; i < LIMIT + 2; i++) {
    const r = await hit('/api/merchant/auth/login', ip, { email: 'rate@e2e.local', password: 'nope' });
    if (r.status === 429) { last429 = r; }
    else if (r.status === 401 || r.status === 400) { okOrAuthFail++; }
  }
  await assert('merchant login: within-limit calls pass rate limiter', okOrAuthFail >= LIMIT - 1,
    `okOrAuthFail=${okOrAuthFail} (expected >= ${LIMIT - 1})`);
  await assert('merchant login: over-limit returns 429', !!last429, `last429=${!!last429}`);
  await assert('merchant login: 429 body carries retryAfterSeconds',
    typeof last429?.body?.retryAfterSeconds === 'number' && last429.body.retryAfterSeconds > 0,
    `retryAfterSeconds=${last429?.body?.retryAfterSeconds}`);
}

async function flow_admin_login() {
  const ip = `10.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
  const LIMIT = 5;
  let trip = false;

  for (let i = 0; i < LIMIT + 2; i++) {
    const r = await hit('/api/admin/auth/login', ip, { email: 'rate-admin@e2e.local', password: 'nope' });
    if (r.status === 429) { trip = true; }
  }
  await assert('admin login: hits 429 within bucket window', trip, `trip=${trip}`);
}

async function flow_signup() {
  const ip = `10.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
  const LIMIT = 5;
  let trip = false;

  for (let i = 0; i < LIMIT + 2; i++) {
    // Invalid body is fine — rate limiter runs before body validation.
    const r = await hit('/api/merchant/signup', ip, { businessName: '' });
    if (r.status === 429) { trip = true; break; }
  }
  await assert('signup: hits 429 within bucket window', trip, `trip=${trip}`);
}

async function flow_otp_request() {
  const ip = `10.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
  const LIMIT = 10;
  let trip = false;

  for (let i = 0; i < LIMIT + 2; i++) {
    // Use different phones so the per-phone OTP bucket doesn't hit first. We
    // want to measure the per-IP rate limit specifically.
    const r = await hit('/api/consumer/auth/request-otp', ip, { phoneNumber: `+1970111${String(i).padStart(4, '0')}` });
    if (r.status === 429) { trip = true; break; }
  }
  await assert('OTP request: hits 429 within bucket window', trip, `trip=${trip}`);
}

async function flow_health_not_limited() {
  // Fire 500 rapid hits against /api/health from one IP. Global limiter
  // default is 300; if health were limited we'd see 429s before 500.
  const ip = `10.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
  let ok = 0;
  for (let i = 0; i < 500; i++) {
    const r = await fetch(`${API}/api/health`, { headers: { 'X-Forwarded-For': ip } });
    if (r.status === 200) ok++;
    if (r.status === 429) break;
  }
  await assert('/api/health is NOT rate-limited (allowList hit)', ok === 500, `ok=${ok}/500`);
}

async function main() {
  console.log('=== Rate limiting E2E ===\n');
  await flow_merchant_login();
  await flow_admin_login();
  await flow_signup();
  await flow_otp_request();
  await flow_health_not_limited();
  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
