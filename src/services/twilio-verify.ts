/**
 * Twilio Verify wrapper. Used as the SMS fallback OTP channel when the
 * admin flips auth_channel = 'sms' (Eric 2026-05-04 — emergency path
 * for when WhatsApp / Meta is unavailable).
 *
 * Twilio Verify owns the OTP itself: we ask it to send a code to a
 * phone, and later ask it to confirm the code the user typed. We never
 * store the code ourselves on the SMS path — Twilio is the source of
 * truth, which also means the OTP works internationally without us
 * having to pick numbers per country.
 */

const VERIFY_BASE = 'https://verify.twilio.com/v2';

interface TwilioCreds {
  accountSid: string;
  authToken: string;
  serviceSid: string;
}

function getCreds(): TwilioCreds | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!accountSid || !authToken || !serviceSid) return null;
  return { accountSid, authToken, serviceSid };
}

export function isTwilioConfigured(): boolean {
  return getCreds() !== null;
}

function authHeader(c: TwilioCreds): string {
  return 'Basic ' + Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64');
}

/**
 * Trigger an SMS containing the OTP. Twilio generates the code and
 * stores its expiry/state internally — we don't see the digits.
 *
 * Returns true when Twilio accepted the request (status 'pending'),
 * false on any failure. Caller should fall through to whatsapp on
 * false so the user is not stranded if Twilio is down.
 */
export async function startTwilioSmsVerification(phoneNumber: string): Promise<boolean> {
  const c = getCreds();
  if (!c) {
    console.warn('[Twilio Verify] credentials missing — skipping SMS send');
    return false;
  }
  try {
    const body = new URLSearchParams({ To: phoneNumber, Channel: 'sms' });
    const r = await fetch(`${VERIFY_BASE}/Services/${c.serviceSid}/Verifications`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader(c),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const json = await r.json().catch(() => ({})) as any;
    if (!r.ok) {
      console.error(`[Twilio Verify] start failed: status=${r.status} body=${JSON.stringify(json).slice(0, 300)}`);
      return false;
    }
    console.log(`[Twilio Verify] start: phone=${phoneNumber} sid=${json.sid} status=${json.status}`);
    return json.status === 'pending';
  } catch (err) {
    console.error('[Twilio Verify] start error:', err);
    return false;
  }
}

/**
 * Submit the user's typed code to Twilio for verification. Returns
 * true when Twilio confirms the code is approved.
 */
export async function checkTwilioSmsVerification(phoneNumber: string, code: string): Promise<boolean> {
  const c = getCreds();
  if (!c) return false;
  try {
    const body = new URLSearchParams({ To: phoneNumber, Code: code });
    const r = await fetch(`${VERIFY_BASE}/Services/${c.serviceSid}/VerificationCheck`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader(c),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const json = await r.json().catch(() => ({})) as any;
    if (!r.ok) {
      // 404 here means the verification expired or was already consumed —
      // not a server error, just a wrong/stale code. Log it but don't shout.
      if (r.status === 404) {
        console.log(`[Twilio Verify] check 404 (expired or unknown): phone=${phoneNumber}`);
      } else {
        console.error(`[Twilio Verify] check failed: status=${r.status} body=${JSON.stringify(json).slice(0, 300)}`);
      }
      return false;
    }
    console.log(`[Twilio Verify] check: phone=${phoneNumber} status=${json.status}`);
    return json.status === 'approved';
  } catch (err) {
    console.error('[Twilio Verify] check error:', err);
    return false;
  }
}
