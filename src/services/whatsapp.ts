/**
 * WhatsApp messaging via Meta Cloud API (official).
 * All connection params from .env — never hardcoded.
 *
 * Uses Meta's Graph API directly. Free-form messages work within the 24h
 * "customer service window" after the user sends a message. Outside that
 * window, only pre-approved templates can be used.
 */

function getConfig() {
  const token = process.env.META_WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.META_WHATSAPP_API_VERSION || 'v22.0';

  if (!token || !phoneNumberId) {
    return null;
  }

  return { token, phoneNumberId, apiVersion };
}

function normalizePhone(phoneNumber: string): string {
  return phoneNumber.replace(/[^\d]/g, '');
}

/**
 * Send a free-form text message. Only works within the 24h customer service
 * window (i.e., in response to a user message within the last 24h).
 */
export async function sendWhatsAppMessage(phoneNumber: string, text: string): Promise<boolean> {
  const config = getConfig();

  if (!config) {
    console.log(`[WhatsApp][not configured] To ${phoneNumber}: ${text.slice(0, 80)}...`);
    return false;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: normalizePhone(phoneNumber),
          type: 'text',
          text: { preview_url: false, body: text },
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[WhatsApp] Send failed: ${res.status} ${errText}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[WhatsApp] Send error:', err);
    return false;
  }
}

/**
 * Send a pre-approved template message. Required for initiating conversations
 * outside the 24h customer service window.
 *
 * Template parameters are substituted into {{1}}, {{2}}, etc. placeholders.
 */
export async function sendWhatsAppTemplate(
  phoneNumber: string,
  templateName: string,
  languageCode: string = 'es',
  parameters: string[] = []
): Promise<boolean> {
  const config = getConfig();

  if (!config) {
    console.log(`[WhatsApp][not configured] Template ${templateName} to ${phoneNumber}`);
    return false;
  }

  try {
    const templatePayload: any = {
      name: templateName,
      language: { code: languageCode },
    };

    if (parameters.length > 0) {
      templatePayload.components = [
        {
          type: 'body',
          parameters: parameters.map((p) => ({ type: 'text', text: p })),
        },
      ];
    }

    const res = await fetch(
      `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: normalizePhone(phoneNumber),
          type: 'template',
          template: templatePayload,
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[WhatsApp] Template send failed: ${res.status} ${errText}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[WhatsApp] Template send error:', err);
    return false;
  }
}

/**
 * Download media (image/document) from Meta Cloud API.
 * Returns the Buffer of the media file.
 */
export async function downloadWhatsAppMedia(mediaId: string): Promise<Buffer | null> {
  const config = getConfig();
  if (!config) return null;

  try {
    // Step 1: get the media URL
    const metaRes = await fetch(
      `https://graph.facebook.com/${config.apiVersion}/${mediaId}`,
      {
        headers: { 'Authorization': `Bearer ${config.token}` },
      }
    );
    if (!metaRes.ok) {
      console.error(`[WhatsApp] Media metadata fetch failed: ${metaRes.status}`);
      return null;
    }
    const meta = await metaRes.json() as { url?: string };
    if (!meta.url) return null;

    // Step 2: download the actual media
    const mediaRes = await fetch(meta.url, {
      headers: { 'Authorization': `Bearer ${config.token}` },
    });
    if (!mediaRes.ok) {
      console.error(`[WhatsApp] Media download failed: ${mediaRes.status}`);
      return null;
    }
    const arrayBuffer = await mediaRes.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error('[WhatsApp] Media download error:', err);
    return null;
  }
}

/**
 * Send an OTP via Meta's authentication-category template.
 *
 * Unlike regular free-form messages (which need the 24h customer service
 * window), authentication templates work for first-time contacts. Required
 * for onboarding — a brand-new user who has never messaged Valee must still
 * receive the login code.
 *
 * Format is specific: authentication templates require TWO components —
 *   1. body with the {{1}} parameter = the OTP code
 *   2. button sub_type=url, index=0, with the same OTP as parameter (Meta
 *      uses this for the auto-filling "Copy code" button)
 *
 * The template name lives in META_WHATSAPP_OTP_TEMPLATE (.env). Language
 * defaults to 'es'. If the template is not set OR Meta rejects it (not
 * approved, wrong format, etc.), we fall back to free-form text so existing
 * 24h-window users still get a code.
 */
async function sendOTPTemplate(phoneNumber: string, otp: string): Promise<boolean> {
  const config = getConfig();
  if (!config) return false;

  const templateName = process.env.META_WHATSAPP_OTP_TEMPLATE;
  if (!templateName) return false;

  const languageCode = process.env.META_WHATSAPP_OTP_TEMPLATE_LANG || 'es';

  try {
    const res = await fetch(
      `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: normalizePhone(phoneNumber),
          type: 'template',
          template: {
            name: templateName,
            language: { code: languageCode },
            components: [
              {
                type: 'body',
                parameters: [{ type: 'text', text: otp }],
              },
              {
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: otp }],
              },
            ],
          },
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[WhatsApp] OTP template send failed: ${res.status} ${errText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[WhatsApp] OTP template send error:', err);
    return false;
  }
}

export async function sendWhatsAppOTP(phoneNumber: string, otp: string): Promise<boolean> {
  // Try the authentication template first — this is the only path that works
  // for users who have never messaged the business (no 24h window open yet).
  const viaTemplate = await sendOTPTemplate(phoneNumber, otp);
  if (viaTemplate) return true;

  // Fallback: free-form text for users who are already in the 24h customer
  // service window. If the template wasn't configured OR Meta rejected it,
  // we still try this path so existing users aren't cut off.
  return sendWhatsAppMessage(
    phoneNumber,
    `Tu codigo de verificacion es: *${otp}*\n\nEste codigo expira en 10 minutos. No lo compartas con nadie.`
  );
}
