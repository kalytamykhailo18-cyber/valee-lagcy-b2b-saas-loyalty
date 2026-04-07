/**
 * WhatsApp Template Registry
 *
 * Maps logical template names used by the application to the actual Meta-approved
 * template names registered in WhatsApp Business Manager. Each entry defines:
 * - The Meta template name (must match exactly what is registered in Meta)
 * - The language code (typically 'es')
 * - A function that builds the variable list from a payload
 *
 * To add a new template:
 * 1. Register it in Meta Business Manager (developers.facebook.com → WhatsApp → Message Templates)
 * 2. Wait for Meta approval (24-48h)
 * 3. Add an entry below
 * 4. Use sendTemplateMessage('logical_name', phone, payload) anywhere in the bot
 */

import { sendWhatsAppTemplate, sendWhatsAppMessage } from './whatsapp.js';

interface TemplateDef {
  metaName: string;
  language: string;
  buildParams: (payload: any) => string[];
  // Fallback plain-text version for the 24h window or when Meta rejects the template
  fallbackText: (payload: any) => string;
}

export const TEMPLATES: Record<string, TemplateDef> = {
  welcome: {
    metaName: 'valee_welcome',
    language: 'es',
    buildParams: (p) => [String(p.merchantName || 'el comercio'), String(p.bonusAmount || '50')],
    fallbackText: (p) =>
      `¡Hola! Bienvenido a ${p.merchantName || 'el comercio'}. Ganaste ${p.bonusAmount || 50} puntos de bienvenida. Envianos una foto de tu factura para acumular mas puntos.`,
  },

  points_earned: {
    metaName: 'valee_points_earned',
    language: 'es',
    buildParams: (p) => [String(p.amount), String(p.balance)],
    fallbackText: (p) =>
      `¡Felicidades! Ganaste ${p.amount} puntos por tu factura. Tu saldo actual: ${p.balance} puntos.`,
  },

  invoice_pending: {
    metaName: 'valee_invoice_pending',
    language: 'es',
    buildParams: (p) => [String(p.amount), String(p.balance)],
    fallbackText: (p) =>
      `Recibimos tu factura. Ganaste ${p.amount} puntos (en verificacion). Tu saldo: ${p.balance} puntos. Te confirmamos en breve.`,
  },

  invoice_rejected: {
    metaName: 'valee_invoice_rejected',
    language: 'es',
    buildParams: (p) => [String(p.reason || 'no se pudo validar')],
    fallbackText: (p) =>
      `Tu factura no pudo ser validada: ${p.reason || 'no se pudo validar'}. Si crees que es un error, contactanos.`,
  },

  redemption_confirmed: {
    metaName: 'valee_redemption_confirmed',
    language: 'es',
    buildParams: (p) => [String(p.productName)],
    fallbackText: (p) =>
      `Tu canje fue procesado: ${p.productName}. Disfrutalo.`,
  },

  recurrence_reminder: {
    metaName: 'valee_recurrence_reminder',
    language: 'es',
    buildParams: (p) => [String(p.name || 'cliente'), String(p.daysSince), String(p.bonus || '50')],
    fallbackText: (p) =>
      `Hola ${p.name || ''}, hace ${p.daysSince} dias que no nos visitas. Te dejamos un regalo: ${p.bonus || 50} puntos extra en tu proxima compra.`,
  },

  flash_offer: {
    metaName: 'valee_flash_offer',
    language: 'es',
    buildParams: (p) => [String(p.title), String(p.expiresAt)],
    fallbackText: (p) =>
      `¡Oferta flash! ${p.title}. Valida hasta ${p.expiresAt}.`,
  },
};

/**
 * Send a templated WhatsApp message.
 *
 * mode='auto' (default): tries the Meta template first, falls back to plain text on failure.
 * mode='template_only': only sends the template (used when we know we're outside the 24h window).
 * mode='text_only': only sends plain text (used inside the 24h customer service window).
 *
 * Returns true if any send succeeded.
 */
export async function sendTemplateMessage(
  templateName: string,
  phoneNumber: string,
  payload: any,
  mode: 'auto' | 'template_only' | 'text_only' = 'auto',
): Promise<boolean> {
  const template = TEMPLATES[templateName];
  if (!template) {
    console.error(`[WhatsApp Templates] Unknown template: ${templateName}`);
    return false;
  }

  if (mode === 'text_only') {
    return sendWhatsAppMessage(phoneNumber, template.fallbackText(payload));
  }

  // Try the Meta template
  const ok = await sendWhatsAppTemplate(
    phoneNumber,
    template.metaName,
    template.language,
    template.buildParams(payload),
  );

  if (ok) return true;

  if (mode === 'template_only') return false;

  // Fall back to plain text (we're probably within the 24h window or template not yet approved)
  console.log(`[WhatsApp Templates] Template ${templateName} failed, falling back to text`);
  return sendWhatsAppMessage(phoneNumber, template.fallbackText(payload));
}

export function listTemplates(): Array<{ name: string; metaName: string; language: string; example: string }> {
  return Object.entries(TEMPLATES).map(([name, def]) => ({
    name,
    metaName: def.metaName,
    language: def.language,
    example: def.fallbackText({
      merchantName: 'Demo Store',
      bonusAmount: 50,
      amount: 100,
      balance: 1000,
      reason: 'numero de factura no encontrado',
      productName: 'Cafe Gratis',
      name: 'Eric',
      daysSince: 14,
      bonus: 100,
      title: '20% off en bebidas',
      expiresAt: 'hoy 8 PM',
    }),
  }));
}
