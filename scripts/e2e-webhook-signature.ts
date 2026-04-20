/**
 * E2E: Meta WhatsApp webhook rejects forged requests via X-Hub-Signature-256.
 *
 * Covers:
 *   - Missing signature header      → 401
 *   - Malformed signature header    → 401
 *   - Wrong signature                → 401
 *   - Right signature                → 200 (whether message is ignored or
 *     processed downstream, the point is the verification passed)
 *   - Timing: same-length mismatch is still rejected (guards against any
 *     accidental non-constant-time compare)
 *   - GET webhook verification still works with META_WHATSAPP_WEBHOOK_VERIFY_TOKEN
 *
 * Requires META_APP_SECRET to be set in the running server's environment.
 * Reads it from .env so the script uses the same secret the server uses.
 */

import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';
const SECRET = process.env.META_APP_SECRET;
if (!SECRET) {
  console.error('FAIL: META_APP_SECRET is not set in .env — signature verification cannot be tested.');
  process.exit(1);
}

const VERIFY_TOKEN = process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN;

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

function signBody(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function post(body: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}/api/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return { status: res.status };
}

async function main() {
  console.log('=== Meta webhook HMAC verification ===\n');

  // Realistic-looking status-update payload so if the signature passes, the
  // handler takes the "status update logged" branch and returns 200 without
  // touching the DB. That keeps this test side-effect-free.
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'TEST',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          statuses: [{ id: 'wamid.TEST', recipient_id: '584140000001', status: 'delivered', timestamp: '1' }],
        },
      }],
    }],
  });

  // 1. No signature → 401
  const noSig = await post(payload);
  await assert('missing X-Hub-Signature-256 → 401', noSig.status === 401, `status=${noSig.status}`);

  // 2. Malformed (no sha256= prefix) → 401
  const malformed = await post(payload, { 'X-Hub-Signature-256': 'deadbeefdeadbeef' });
  await assert('malformed signature → 401', malformed.status === 401, `status=${malformed.status}`);

  // 3. Wrong signature (right format, bad HMAC) → 401
  const wrongSig = signBody('wrong-secret-here-just-for-test', payload);
  const wrong = await post(payload, { 'X-Hub-Signature-256': wrongSig });
  await assert('wrong signature → 401', wrong.status === 401, `status=${wrong.status}`);

  // 4. Correct signature → 200
  const correctSig = signBody(SECRET, payload);
  const ok = await post(payload, { 'X-Hub-Signature-256': correctSig });
  await assert('valid signature → 200', ok.status === 200, `status=${ok.status}`);

  // 5. Body tampered AFTER signing → 401 (replay with different body)
  const tamperedBody = payload.replace('delivered', 'read');
  const tampered = await post(tamperedBody, { 'X-Hub-Signature-256': correctSig });
  await assert('same signature + tampered body → 401', tampered.status === 401,
    `status=${tampered.status}`);

  // 6. Same-length but wrong hex (timing-safe compare regression)
  const sameLenWrong = 'sha256=' + '0'.repeat(64);
  const slw = await post(payload, { 'X-Hub-Signature-256': sameLenWrong });
  await assert('same-length wrong hex → 401', slw.status === 401, `status=${slw.status}`);

  // 7. GET verification still works
  if (VERIFY_TOKEN) {
    const url = `${API}/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=CHALLENGE123`;
    const r = await fetch(url);
    const text = await r.text();
    await assert('GET verify with correct token returns challenge',
      r.status === 200 && text === 'CHALLENGE123',
      `status=${r.status} body=${text.slice(0,20)}`);

    const bad = await fetch(`${API}/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=X`);
    await assert('GET verify with wrong token → 403', bad.status === 403, `status=${bad.status}`);
  }

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
