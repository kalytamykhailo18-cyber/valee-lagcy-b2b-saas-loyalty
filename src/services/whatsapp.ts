/**
 * WhatsApp messaging via Evolution API.
 * All connection params from .env — never hardcoded.
 */

function getConfig() {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE_NAME;

  if (!url || !key || !instance) {
    return null; // Not configured — log only mode
  }

  return { url: url.replace(/\/$/, ''), key, instance };
}

export async function sendWhatsAppMessage(phoneNumber: string, text: string): Promise<boolean> {
  const config = getConfig();

  if (!config) {
    console.log(`[WhatsApp][not configured] To ${phoneNumber}: ${text.slice(0, 80)}...`);
    return false;
  }

  try {
    const res = await fetch(`${config.url}/message/sendText/${config.instance}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.key,
      },
      body: JSON.stringify({
        number: phoneNumber.replace('+', ''),
        text,
      }),
    });

    if (!res.ok) {
      console.error(`[WhatsApp] Send failed: ${res.status} ${await res.text()}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[WhatsApp] Send error:', err);
    return false;
  }
}

export async function sendWhatsAppOTP(phoneNumber: string, otp: string): Promise<boolean> {
  return sendWhatsAppMessage(
    phoneNumber,
    `Tu codigo de verificacion es: *${otp}*\n\nEste codigo expira en 5 minutos. No lo compartas con nadie.`
  );
}
