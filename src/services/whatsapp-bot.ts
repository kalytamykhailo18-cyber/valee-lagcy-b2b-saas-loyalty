import prisma from '../db/client.js';
import { findOrCreateConsumerAccount } from './accounts.js';
import { getAccountBalance, getAccountHistory } from './ledger.js';

// ============================================================
// CONVERSATION STATE DETECTION
// ============================================================

export type ConversationState = 'first_time' | 'returning_with_history' | 'active_purchase' | 'registered_never_scanned';

export async function detectConversationState(
  phoneNumber: string,
  tenantId: string
): Promise<{ state: ConversationState; accountId: string | null; balance: string }> {
  // Check if account exists
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId, phoneNumber } },
  });

  if (!account) {
    return { state: 'first_time', accountId: null, balance: '0' };
  }

  // Check for confirmed INVOICE_CLAIMED events
  const claimedCount = await prisma.ledgerEntry.count({
    where: {
      tenantId,
      accountId: account.id,
      eventType: 'INVOICE_CLAIMED',
      entryType: 'CREDIT',
      status: { not: 'reversed' },
    },
  });

  if (claimedCount === 0) {
    return { state: 'registered_never_scanned', accountId: account.id, balance: '0' };
  }

  // Check if the consumer recently scanned a merchant QR (within 60 minutes)
  // We approximate this by checking if there's a recent ledger entry in the last 60 min
  const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentActivity = await prisma.ledgerEntry.findFirst({
    where: {
      tenantId,
      accountId: account.id,
      createdAt: { gte: sixtyMinutesAgo },
    },
  });

  // Get balance
  const assetType = await prisma.assetType.findFirst();
  const balance = assetType
    ? await getAccountBalance(account.id, assetType.id, tenantId)
    : '0';

  if (recentActivity) {
    return { state: 'active_purchase', accountId: account.id, balance };
  }

  return { state: 'returning_with_history', accountId: account.id, balance };
}

// ============================================================
// MESSAGE COPY (Spanish)
// ============================================================

export function getStateGreeting(
  state: ConversationState,
  merchantName: string,
  balance: string,
  phoneNumber: string
): string[] {
  switch (state) {
    case 'first_time':
      return [
        `¡Hola! 👋 Bienvenido a ${merchantName}.`,
        `Acabas de hacer una compra y puedes ganar recompensas por ella. Es muy fácil:`,
        `📸 Envíanos una foto de tu factura y te cargaremos tus puntos automáticamente. ¡Así de simple!`,
      ];

    case 'returning_with_history':
      return [
        `¡Hola de nuevo! Tu saldo actual es de ${balance} puntos.`,
        `¿Tienes una nueva factura para escanear? 📸 Envíala aquí.`,
      ];

    case 'active_purchase':
      return [
        `¡Acabas de visitar ${merchantName}! No olvides enviar tu factura para ganar tus puntos. 📸`,
        `Tu saldo actual: ${balance} puntos.`,
      ];

    case 'registered_never_scanned':
      return [
        `¡Hola! Te registraste hace un tiempo pero aún no has ganado puntos.`,
        `Es muy fácil: la próxima vez que compres en ${merchantName}, envíanos una foto de tu factura aquí. 📸`,
        `¡Así empezarás a acumular puntos para canjear por productos!`,
      ];
  }
}

// ============================================================
// SUPPORT INTENT DETECTION
// ============================================================

export type SupportIntent =
  | 'balance_query'
  | 'receipt_status'
  | 'how_to_redeem'
  | 'report_problem'
  | 'unknown';

export function detectSupportIntent(message: string): SupportIntent {
  const lower = message.toLowerCase().trim();

  // How to redeem (check BEFORE balance to avoid "mis puntos" ambiguity)
  if (/canjear|canje|redimir|redeem|como canjeo|c.mo canjeo|usar.*puntos/.test(lower)) {
    return 'how_to_redeem';
  }

  // Balance queries
  if (/saldo|balance|cu.nto tengo|cuanto tengo|mis puntos/.test(lower)) {
    return 'balance_query';
  }

  // Receipt status
  if (/factura|recibo|receipt|estado|qué pasó|que paso|mi factura|última factura/.test(lower)) {
    return 'receipt_status';
  }

  // Report problem
  if (/problema|error|ayuda|help|reclamo|queja|no funciona|mal/.test(lower)) {
    return 'report_problem';
  }

  return 'unknown';
}

// ============================================================
// SUPPORT RESPONSES (Spanish)
// ============================================================

export async function handleSupportIntent(
  intent: SupportIntent,
  phoneNumber: string,
  tenantId: string,
  accountId: string | null
): Promise<string[]> {
  switch (intent) {
    case 'balance_query': {
      if (!accountId) return ['Aún no tienes una cuenta. Escanea el QR del comercio para comenzar.'];
      const assetType = await prisma.assetType.findFirst();
      const balance = assetType
        ? await getAccountBalance(accountId, assetType.id, tenantId)
        : '0';
      return [`Tu saldo actual es de ${balance} puntos. 💰`];
    }

    case 'receipt_status': {
      if (!accountId) return ['No tienes facturas registradas aún.'];
      const lastInvoice = await prisma.invoice.findFirst({
        where: { tenantId, consumerAccountId: accountId },
        orderBy: { createdAt: 'desc' },
      });
      if (!lastInvoice) return ['No encontramos facturas recientes asociadas a tu cuenta.'];
      const statusMap: Record<string, string> = {
        'available': 'disponible',
        'claimed': 'reclamada ✅',
        'pending_validation': 'en verificación ⏳',
        'rejected': 'rechazada ❌',
        'manual_review': 'en revisión manual 🔍',
      };
      return [
        `Tu última factura (${lastInvoice.invoiceNumber}):`,
        `Estado: ${statusMap[lastInvoice.status] || lastInvoice.status}`,
        `Monto: $${lastInvoice.amount}`,
      ];
    }

    case 'how_to_redeem':
      return [
        `Para canjear tus puntos:`,
        `1️⃣ Abre la app (PWA) en tu navegador.`,
        `2️⃣ Ve al catálogo de productos.`,
        `3️⃣ Elige el producto que deseas.`,
        `4️⃣ Genera un QR de canje.`,
        `5️⃣ Muestra el QR al cajero y listo. ¡Disfruta tu premio! 🎉`,
      ];

    case 'report_problem':
      return [
        `Lamentamos que tengas un inconveniente. 😔`,
        `Por favor describe tu problema y lo revisaremos lo antes posible.`,
        `También puedes adjuntar una captura de pantalla si es necesario.`,
      ];

    case 'unknown':
      return [
        `No entendí tu mensaje. Estas son las opciones disponibles:`,
        `📸 Envía una foto de tu factura para ganar puntos.`,
        `💰 Escribe "saldo" para ver tus puntos.`,
        `📄 Escribe "factura" para ver el estado de tu última factura.`,
        `🎁 Escribe "canjear" para saber cómo usar tus puntos.`,
        `❓ Escribe "ayuda" si tienes un problema.`,
      ];
  }
}

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

export async function handleIncomingMessage(params: {
  phoneNumber: string;
  tenantId: string;
  messageType: 'text' | 'image';
  messageText?: string;
  imageBuffer?: Buffer;
}): Promise<string[]> {
  const { phoneNumber, tenantId, messageType, messageText } = params;

  // Detect conversation state BEFORE creating account (to catch first-time)
  const { state, accountId, balance } = await detectConversationState(phoneNumber, tenantId);

  // Now ensure account exists
  const { account } = await findOrCreateConsumerAccount(tenantId, phoneNumber);

  // Get merchant name
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const merchantName = tenant?.name || 'el comercio';

  // If it's the first message or a greeting, send state-based greeting
  if (messageType === 'text' && messageText) {
    const lower = messageText.toLowerCase().trim();

    // Check if it's a greeting
    if (/^(hola|hi|hello|hey|buenos|buenas|buen día|saludos|qué tal|que tal)/.test(lower)) {
      return getStateGreeting(state, merchantName, balance, phoneNumber);
    }

    // Check support intents
    const intent = detectSupportIntent(messageText);
    return handleSupportIntent(intent, phoneNumber, tenantId, accountId);
  }

  // If it's an image, it's an invoice submission
  if (messageType === 'image') {
    // In production: process through the validation pipeline
    // Return confirmation that we received the image
    return [
      `📸 Recibimos tu factura. Estamos procesándola...`,
      `Te notificaremos en unos segundos con el resultado.`,
    ];
  }

  // Default: state greeting
  return getStateGreeting(state, merchantName, balance, phoneNumber);
}
