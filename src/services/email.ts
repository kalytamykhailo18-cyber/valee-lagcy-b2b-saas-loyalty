/**
 * Transactional email via Resend API.
 * API key from .env — never hardcoded.
 */

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[Email][not configured] To: ${params.to} Subject: ${params.subject}`);
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: 'Valee <noreply@valee.app>',
        to: params.to,
        subject: params.subject,
        html: params.html,
      }),
    });

    if (!res.ok) {
      console.error('[Email] Send failed:', res.status, await res.text());
      return false;
    }

    return true;
  } catch (err) {
    console.error('[Email] Send error:', err);
    return false;
  }
}

export async function sendTenantCredentials(
  ownerEmail: string,
  ownerName: string,
  tenantName: string,
  password: string,
  tenantSlug: string
): Promise<boolean> {
  return sendEmail({
    to: ownerEmail,
    subject: `Bienvenido a Valee — Credenciales de ${tenantName}`,
    html: `
      <h2>Hola ${ownerName},</h2>
      <p>Tu comercio <strong>${tenantName}</strong> ha sido creado en la plataforma Valee.</p>
      <p><strong>URL del dashboard:</strong> https://valee.app/merchant/login</p>
      <p><strong>Codigo del comercio:</strong> ${tenantSlug}</p>
      <p><strong>Email:</strong> ${ownerEmail}</p>
      <p><strong>Contrasena temporal:</strong> ${password}</p>
      <p>Por favor cambia tu contrasena al iniciar sesion por primera vez.</p>
    `,
  });
}

export async function sendPasswordResetLink(
  ownerEmail: string,
  resetUrl: string,
  ttlMinutes: number,
): Promise<boolean> {
  return sendEmail({
    to: ownerEmail,
    subject: 'Recupera tu contrasena de Valee',
    html: `
      <p>Recibimos una solicitud para recuperar la contrasena de tu cuenta de comercio en Valee.</p>
      <p>Haz clic en este enlace para definir una contrasena nueva. El enlace expira en ${ttlMinutes} minutos:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>Si no fuiste tu, ignora este correo — tu contrasena actual sigue siendo valida.</p>
    `,
  });
}
