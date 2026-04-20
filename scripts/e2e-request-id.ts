/**
 * E2E: every response carries an X-Request-Id header that matches the
 * reqId Fastify stamps in logs.
 *
 * Covers:
 *   - 200 happy path surfaces header
 *   - 401 auth-rejected surfaces header
 *   - 429 rate-limited surfaces header
 *   - inbound X-Request-Id is echoed back (trace propagation)
 *   - auto-generated IDs match the expected `req-...` shape
 */

import dotenv from 'dotenv';
dotenv.config();

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== X-Request-Id end-to-end ===\n');

  // 1. Happy path: /api/health
  const ok = await fetch(`${API}/api/health`);
  const okId = ok.headers.get('x-request-id');
  await assert('200 response carries X-Request-Id', ok.status === 200 && !!okId,
    `status=${ok.status} id=${okId}`);
  await assert('auto-generated id matches req-... shape',
    !!okId && /^req-[a-z0-9]+-[a-z0-9]+$/i.test(okId!),
    `id=${okId}`);

  // 2. Inbound propagation
  const TRACE = 'trace-e2e-aaaaaaaa';
  const propagated = await fetch(`${API}/api/health`, {
    headers: { 'X-Request-Id': TRACE },
  });
  const propId = propagated.headers.get('x-request-id');
  await assert('inbound X-Request-Id is echoed back', propId === TRACE,
    `sent=${TRACE} got=${propId}`);

  // 3. 401 response also carries the header
  const unauth = await fetch(`${API}/api/consumer/balance`);
  const unauthId = unauth.headers.get('x-request-id');
  await assert('401 auth-rejected carries X-Request-Id',
    unauth.status === 401 && !!unauthId, `status=${unauth.status} id=${unauthId}`);

  // 4. 429 rate-limited response also carries the header.
  // Use a high-churn IP so we don't need to flood an otherwise-clean bucket.
  const floodIp = `10.88.99.${Math.floor(Math.random() * 255)}`;
  let rateId: string | null = null;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${API}/api/merchant/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': floodIp },
      body: JSON.stringify({ email: 'x', password: 'y' }),
    });
    if (r.status === 429) { rateId = r.headers.get('x-request-id'); break; }
  }
  await assert('429 rate-limited response carries X-Request-Id', !!rateId, `id=${rateId}`);

  // 5. 500 unhandled error response would carry the header too (skipping
  //    since there's no deliberately broken endpoint).

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
