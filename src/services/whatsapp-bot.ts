import prisma from '../db/client.js';
import { findOrCreateConsumerAccount } from './accounts.js';
import { getAccountBalance, getAccountHistory } from './ledger.js';
import { grantWelcomeBonus } from './welcome-bonus.js';

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
    // Eric 2026-04-23 "Bot de whatsaap" Notion: a user scanning a
    // referral QR for the first time was getting the "te registraste
    // hace un tiempo" (registered_never_scanned) greeting instead of
    // the warm first-time welcome. Trace: webhook.ts creates the
    // account + grants the welcome bonus BEFORE handleIncomingMessage
    // runs, so by the time detectConversationState peeks, the account
    // exists and has zero INVOICE_CLAIMED rows (welcome bonus is
    // ADJUSTMENT_MANUAL). Treat an account created within the last
    // two hours with no claims as "effectively first_time" — they're
    // brand new on this merchant and haven't had any other session.
    const FIRST_TIME_WINDOW_MS = 2 * 60 * 60 * 1000;
    const justArrived = Date.now() - account.createdAt.getTime() < FIRST_TIME_WINDOW_MS;
    if (justArrived) {
      return { state: 'first_time', accountId: account.id, balance: '0' };
    }
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
  phoneNumber: string,
  welcomeBonusAmount?: string,
  merchantSlug?: string,
  branchName?: string | null,
  cashierSlug?: string | null,
): string[] {
  // Prefer the real tenant slug when available; the old fallback slugified
  // merchantName with spaces→dashes, which usually worked for "Valee Demo" but
  // would silently break for tenants whose display name doesn't match their
  // slug (e.g. "Café Juan Valdez" vs cafe-juan).
  const base = (process.env.CONSUMER_APP_URL || 'https://valee.app').replace(/\/+$/, '');
  const slug = (merchantSlug || merchantName.toLowerCase().replace(/\s+/g, '-')).toLowerCase();
  // Carry the cajero slug in the PWA link when the incoming QR identified a
  // cashier. Genesis 2026-04-24: without it the user clicking the link from
  // WhatsApp lands on the plain tenant view and the invoice they upload
  // from the PWA loses the staff attribution. The PWA reads `cajero=` and
  // registers a StaffScanSession so the attribution window carries across.
  const pwaLink = cashierSlug
    ? `${base}/consumer?tenant=${encodeURIComponent(slug)}&cajero=${encodeURIComponent(cashierSlug)}`
    : `${base}/consumer?tenant=${encodeURIComponent(slug)}`;
  // Combine the merchant name with the branch the user just scanned so the
  // bot reply reflects where they actually are (Genesis L4: 'Acabas de
  // visitar Luxor Fitness' should say 'Luxor Fitness - Luxor Valencia').
  const merchantLabel = branchName
    ? `${merchantName} - ${branchName}`
    : merchantName;

  switch (state) {
    case 'first_time': {
      // Eric (2026-04-23 Notion "Bot de WhatsApp"): lead with the welcome
      // bonus in a single warm line that names the merchant — "ganaste
      // X puntos de bienvenida, queremos verte en <comercio>". The
      // previous copy split this across two stilted lines and buried
      // the merchant name in a separate "Bienvenido a" greeting.
      // When the merchant has the welcome bonus disabled or capped
      // (welcomeBonusAmount === ''), drop the bonus line and lead with a
      // clean welcome — never leak "te regalo 0 puntos" (Eric 2026-04-25).
      // Eric 2026-04-26: format the bonus number with dot thousand
      // separators (5000 → "5.000") to match how the merchant configured
      // it in the panel. Locale 'es-VE' produces dot-as-thousands.
      const bonusFormatted = welcomeBonusAmount
        ? parseInt(welcomeBonusAmount).toLocaleString('es-VE')
        : '';
      const opener = welcomeBonusAmount && parseInt(welcomeBonusAmount) > 0
        ? `🎉 ¡Ganaste ${bonusFormatted} puntos de bienvenida, queremos verte en ${merchantLabel}!`
        : `👋 ¡Bienvenido a ${merchantLabel}!`;
      return [
        opener,
        `Envianos una foto de tu factura y te cargamos mas puntos automaticamente. 📸`,
        `📱 Accede a tu cuenta aqui: ${pwaLink}`,
      ];
    }

    case 'returning_with_history':
      return [
        `¡Hola de nuevo! Tu saldo actual es de ${Math.round(parseFloat(balance)).toLocaleString('es-VE')} puntos.`,
        `¿Tienes una nueva factura para escanear? 📸 Envíala aquí.`,
        `📱 Ver tu saldo y canjear: ${pwaLink}`,
      ];

    case 'active_purchase':
      return [
        `¡Acabas de visitar ${merchantLabel}! No olvides enviar tu factura para ganar tus puntos. 📸`,
        `Tu saldo actual: ${Math.round(parseFloat(balance)).toLocaleString('es-VE')} puntos.`,
        `📱 Ver tu cuenta: ${pwaLink}`,
      ];

    case 'registered_never_scanned':
      return [
        `¡Hola! Te registraste hace un tiempo pero aún no has ganado puntos.`,
        `Es muy fácil: la próxima vez que compres en ${merchantLabel}, envíanos una foto de tu factura aquí. 📸`,
        `¡Así empezarás a acumular puntos para canjear por productos!`,
        `📱 Tu cuenta aquí: ${pwaLink}`,
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
      if (!accountId) return ['Aun no tienes una cuenta. Escanea el QR del comercio para comenzar.'];
      const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
      const assetType = assetConfig
        ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
        : await prisma.assetType.findFirst();
      const balance = assetType
        ? await getAccountBalance(accountId, assetType.id, tenantId)
        : '0';
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      const merchantName = tenant?.name || 'el comercio';
      const unitLabel = assetType?.unitLabel || 'puntos';
      return [`Tu saldo en ${merchantName} es de ${Math.round(parseFloat(balance)).toLocaleString('es-VE')} ${unitLabel}.`];
    }

    case 'receipt_status': {
      if (!accountId) return ['No tienes facturas registradas aun.'];
      const lastInvoice = await prisma.invoice.findFirst({
        where: { tenantId, consumerAccountId: accountId },
        orderBy: { createdAt: 'desc' },
      });
      if (!lastInvoice) return ['No encontramos facturas recientes asociadas a tu cuenta.'];
      const statusMap: Record<string, string> = {
        'available': 'disponible',
        'claimed': 'reclamada',
        'pending_validation': 'en verificacion',
        'rejected': 'rechazada',
        'manual_review': 'en revision manual',
      };
      const ext = lastInvoice.extractedData as any;
      const currency = ext?.currency || 'BS';
      const lines: string[] = [
        `Tu ultima factura:`,
        `Estado: ${statusMap[lastInvoice.status] || lastInvoice.status}`,
        `Factura #: ${lastInvoice.invoiceNumber}`,
        `Monto: ${currency === 'USD' ? '$' : 'Bs'} ${lastInvoice.amount}`,
      ];
      if (ext) {
        if (ext.customer_name) lines.push(`Nombre: ${ext.customer_name}`);
        if (ext.customer_cedula) lines.push(`Cedula: ${ext.customer_cedula}`);
        if (ext.customer_phone) lines.push(`Telefono factura: ${ext.customer_phone}`);
        if (ext.merchant_name) lines.push(`Comercio: ${ext.merchant_name}`);
        if (ext.merchant_rif) lines.push(`RIF: ${ext.merchant_rif}`);
        if (ext.transaction_date) lines.push(`Fecha: ${ext.transaction_date}`);
        if (ext.order_items && ext.order_items.length > 0) {
          lines.push(`Items (${ext.order_items.length}):`);
          for (const item of ext.order_items) {
            const qty = item.quantity || 1;
            const price = item.unit_price != null ? ` Bs ${item.unit_price}` : '';
            lines.push(`- ${qty}x ${item.name}${price}`);
          }
        }
      }
      return lines;
    }

    case 'how_to_redeem': {
      const appUrl = process.env.CONSUMER_APP_URL || 'https://valee.app';
      return [
        `Para canjear tus puntos:`,
        `1. Abre la app ${appUrl} en tu navegador.`,
        `2. Ve al catalogo de productos.`,
        `3. Elige el producto que deseas.`,
        `4. Genera un QR de canje.`,
        `5. Muestra el QR al cajero y listo.`,
      ];
    }

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
// OCR RETRY TRACKING (max 2 retries per session)
// ============================================================

const MAX_OCR_RETRIES = 2;
// Map key: "{tenantId}:{phoneNumber}", value: { count, lastAttempt }
const ocrRetryMap = new Map<string, { count: number; lastAttempt: number }>();

export function getOcrRetryCount(tenantId: string, phoneNumber: string): number {
  const key = `${tenantId}:${phoneNumber}`;
  const entry = ocrRetryMap.get(key);
  // Reset if last attempt was more than 1 hour ago (new session)
  if (entry && Date.now() - entry.lastAttempt > 60 * 60 * 1000) {
    ocrRetryMap.delete(key);
    return 0;
  }
  return entry?.count || 0;
}

export function incrementOcrRetry(tenantId: string, phoneNumber: string): number {
  const key = `${tenantId}:${phoneNumber}`;
  const current = getOcrRetryCount(tenantId, phoneNumber);
  const newCount = current + 1;
  ocrRetryMap.set(key, { count: newCount, lastAttempt: Date.now() });
  return newCount;
}

export function resetOcrRetry(tenantId: string, phoneNumber: string): void {
  ocrRetryMap.delete(`${tenantId}:${phoneNumber}`);
}

// ============================================================
// MERCHANT IDENTIFIER PARSING
// ============================================================

/**
 * Parse the pre-filled message from the merchant QR code.
 * Accepts either the raw "MERCHANT:{slug}" tag or the friendly format with
 * the tag in brackets at the end: "Hola, quiero registrar... [MERCHANT:{slug}]".
 * Returns { tenantId, branchId } or null if not a QR message.
 */
/**
 * Parse optional `Cjr: <slug>` marker embedded in the QR message. Returns the
 * staffId if the slug resolves to an active staff member of `tenantId`.
 * Keeps merchant resolution independent so a stale/invalid staff slug never
 * blocks the primary merchant lookup.
 */
export async function parseStaffAttribution(messageText: string, tenantId: string): Promise<string | null> {
  const m = messageText.match(/Cjr:\s*([a-z0-9]{4,16})/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  const staff = await prisma.staff.findFirst({
    where: { qrSlug: slug, tenantId, active: true },
    select: { id: true },
  });
  return staff?.id || null;
}

export async function parseMerchantIdentifier(messageText: string): Promise<{
  tenantId: string;
  branchId: string | null;
  tenantName: string;
} | null> {
  // Match either the friendly "Ref: slug" / "Ref: slug/branchId" format
  // (current QR output) or the legacy "MERCHANT:slug" / "MERCHANT:slug:BRANCH:id"
  // format (still printed on old QRs out in the wild).
  const refMatch = messageText.match(/Ref:\s*([a-z0-9][a-z0-9-]{0,48}[a-z0-9])(?:\/([a-f0-9-]+))?/i);
  const legacyMatch = messageText.match(/MERCHANT:([a-z0-9\-]+)(?::BRANCH:([a-f0-9\-]+))?/i);
  const match = refMatch || legacyMatch;
  if (!match) return null;

  const slug = match[1].toLowerCase();
  const branchId = match[2] || null;

  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant || tenant.status !== 'active') return null;

  return { tenantId: tenant.id, branchId, tenantName: tenant.name };
}

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

export async function handleIncomingMessage(params: {
  phoneNumber: string;
  tenantId: string;
  branchId?: string | null;
  messageType: 'text' | 'image';
  messageText?: string;
  imageBuffer?: Buffer;
  senderProfileName?: string | null;
  // True when the incoming text carries a Ref2U: marker but the referral
  // was already recorded for this referee (Genesis re-scanning Eric's
  // code). We prepend a one-line explanation so the UX doesn't pretend
  // every rescan is a fresh "you just visited" event.
  referralAlreadyUsed?: boolean;
}): Promise<string[]> {
  const { phoneNumber, tenantId, messageType, messageText, referralAlreadyUsed } = params;

  // Detect conversation state BEFORE creating account (to catch first-time)
  const { state, accountId, balance } = await detectConversationState(phoneNumber, tenantId);

  // Now ensure account exists
  const { account, created } = await findOrCreateConsumerAccount(tenantId, phoneNumber, params.senderProfileName);

  // Grant welcome bonus on first contact. When the user got here via a
  // branch QR (Ref: slug/<branchId>), stamp that branch on the ledger
  // entries so the transactions panel can attribute the row correctly.
  // Track whether the bonus was actually granted so the greeting copy can
  // skip the "te regalo X puntos" line when the merchant has the bonus
  // turned off or capped (Eric 2026-04-25). Otherwise the bot was leaking
  // "te regalo 0 puntos" / a fake-positive bonus mention to the consumer.
  let welcomeBonusGranted = false;
  if (created) {
    const assetType = await prisma.assetType.findFirst();
    if (assetType) {
      const result = await grantWelcomeBonus(account.id, tenantId, assetType.id, params.branchId || null);
      welcomeBonusGranted = result.granted;
    }
  }

  // Get merchant name + slug (slug is needed so the PWA link in the greeting
  // deep-links to the right tenant instead of a slugified name guess). Also
  // resolve the branch name from params.branchId so the greeting can say
  // 'Luxor Fitness - Luxor Valencia' (Genesis L4).
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const merchantName = tenant?.name || 'el comercio';
  const merchantSlug = tenant?.slug;
  let branchName: string | null = null;
  if (params.branchId) {
    const branch = await prisma.branch.findFirst({
      where: { id: params.branchId, tenantId, active: true },
      select: { name: true },
    });
    branchName = branch?.name || null;
  }

  // Parse the Cjr: marker in the incoming text so the welcome / greeting
  // links can carry the cashier slug forward. Silently tolerates a missing
  // marker or stale/inactive cashier slug. When the marker is present the
  // PWA link ends with &cajero=<slug> and the frontend registers the
  // attribution session so the invoice the user uploads from the PWA still
  // gets credited to that cashier.
  let cashierSlug: string | null = null;
  if (messageText) {
    const cjrMatch = messageText.match(/Cjr:\s*([a-z0-9]{4,16})/i);
    if (cjrMatch) {
      const candidate = cjrMatch[1].toLowerCase();
      const staffRow = await prisma.staff.findFirst({
        where: { qrSlug: candidate, tenantId, active: true },
        select: { qrSlug: true },
      });
      if (staffRow?.qrSlug) cashierSlug = staffRow.qrSlug;
    }
  }

  // Prefix line surfaced whenever the caller detected a re-used referral
  // code. Applies to greeting responses, support-intent responses AND the
  // first_time welcome path so the user always gets the feedback on a
  // rescan, even when state detection still reads first_time because the
  // account was just created.
  const referralPrefix: string[] = referralAlreadyUsed
    ? ['Este codigo de referido ya lo usaste — solo funciona una vez por persona. Sigue enviando tus facturas para ganar puntos normalmente.']
    : [];

  // If account was just created (first contact via QR), always send welcome greeting.
  // BUT: if the very first interaction is an image (the user sent a photo of
  // their factura as their opening message — Eric 2026-04-23 referral
  // testing), we do NOT re-greet. The account is still first_time for up
  // to 2h after the welcome bonus, and without this carve-out every image
  // submitted in that window was bouncing back with the welcome copy
  // instead of the validation result. Image messages always flow into the
  // validation pipeline below.
  if ((created || state === 'first_time') && messageType !== 'image') {
    // Only mention the bonus amount when it was actually granted on this
    // contact. Active=false / capped / amount=0 → pass empty string so the
    // greeting falls back to a clean welcome without the bonus line.
    const bonusAmt = welcomeBonusGranted
      ? (tenant?.welcomeBonusAmount?.toString() || process.env.WELCOME_BONUS_AMOUNT || '50')
      : '';
    return [...referralPrefix, ...getStateGreeting('first_time', merchantName, bonusAmt, phoneNumber, bonusAmt, merchantSlug, branchName, cashierSlug)];
  }

  // If it's the first message or a greeting, send state-based greeting
  if (messageType === 'text' && messageText) {
    const lower = messageText.toLowerCase().trim();

    // Is this the pre-filled QR body? Returning users were dropping into
    // detectSupportIntent → "No entendi" whenever they rescanned a QR in
    // the current "Valee Ref: <slug> Cjr: <qr>" format because the check
    // below only recognized the legacy "MERCHANT:" tag. Accept every
    // marker we emit today (Ref:, Cjr:, Ref2U:) plus the legacy one
    // (MERCHANT:) so any QR scan lands on the state-based greeting.
    const isQrRescan = /\b(?:ref|cjr|ref2u):\s*[a-z0-9\-\/]+/i.test(lower)
      || /merchant:[a-z0-9\-]+/i.test(lower);
    if (isQrRescan) {
      return [...referralPrefix, ...getStateGreeting(state, merchantName, balance, phoneNumber, undefined, merchantSlug, branchName, cashierSlug)];
    }

    // Check if it's a greeting
    if (/^(hola|hi|hello|hey|buenos|buenas|buen día|saludos|qué tal|que tal)/.test(lower)) {
      return [...referralPrefix, ...getStateGreeting(state, merchantName, balance, phoneNumber, undefined, merchantSlug, branchName, cashierSlug)];
    }

    // Check support intents
    const intent = detectSupportIntent(messageText);
    return [...referralPrefix, ...(await handleSupportIntent(intent, phoneNumber, tenantId, accountId))];
  }

  // If it's an image, it's an invoice submission — run the full validation pipeline
  if (messageType === 'image') {
    const { validateInvoice } = await import('./invoice-validation.js');
    const { extractFromImage } = await import('./ocr.js');

    // Get asset type for this tenant
    const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
    const assetType = assetConfig
      ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
      : await prisma.assetType.findFirst();

    if (!assetType) {
      return ['Error: no se ha configurado el tipo de puntos para este comercio.'];
    }

    // Stage A: OCR + AI extraction from the image
    let extractedData;
    let ocrRawText: string | null = null;

    if (params.imageBuffer) {
      const extraction = await extractFromImage(params.imageBuffer);
      extractedData = extraction.extractedData;
      ocrRawText = extraction.ocrRawText;
    } else {
      // No image buffer available (e.g., Evolution API didn't provide it)
      return [
        '📸 Recibimos tu imagen pero no pudimos procesarla.',
        'Por favor intenta enviarla de nuevo como foto (no como documento).',
      ];
    }

    // Confidence gate is now handled inside validateInvoice (Stage A) using the
    // unified threshold + essentials bypass. We still keep the retry tracker so
    // the user gets a "X intentos restantes" message after repeated failures.

    // Run full validation (Stages B through E). Pass the imageBuffer (for the
    // SHA-256 dedup gate), the extractedData (so validateInvoice does not re-run
    // OCR), AND the ocrRawText (critical for Stage A1 Jaccard dedup — without
    // this, the stored invoice rows have empty ocr_raw_text and the fuzzy dedup
    // has nothing to compare against).
    const result = await validateInvoice({
      tenantId,
      senderPhone: phoneNumber,
      assetTypeId: assetType.id,
      extractedData,
      ocrRawText: ocrRawText || undefined,
      imageBuffer: params.imageBuffer,
      branchId: params.branchId || null,
    });

    if (result.success) {
      // PWA deep link — lets the user jump from WhatsApp straight to their
      // balance/catalog for this merchant without re-selecting the tenant.
      const base = (process.env.CONSUMER_APP_URL || 'https://valee.app').replace(/\/+$/, '');
      const pwaLink = merchantSlug
        ? `${base}/consumer?tenant=${encodeURIComponent(merchantSlug)}`
        : `${base}/consumer`;

      const isPending = result.stage === 'pending';
      if (isPending) {
        // Eric (2026-04-23 Notion "Bot de WhatsApp"): stop surfacing the
        // technical term "(provisional)" to the customer — it reads as
        // uncertainty. The follow-up line "Te confirmamos cuando se
        // valide" already conveys the pending state without the jargon.
        return [
          `✅ Factura recibida y en verificacion.`,
          `Ganaste ${Math.round(parseFloat(result.valueAssigned!)).toLocaleString('es-VE')} ${assetType.unitLabel}.`,
          `Tu saldo total: ${Math.round(parseFloat(result.newBalance!)).toLocaleString('es-VE')} ${assetType.unitLabel}.`,
          `Te confirmamos en breve cuando se valide.`,
          `📱 Ver tu cuenta y canjear premios: ${pwaLink}`,
        ];
      }
      return [
        `✅ Factura validada!`,
        `Ganaste ${Math.round(parseFloat(result.valueAssigned!)).toLocaleString('es-VE')} ${assetType.unitLabel}.`,
        `Tu saldo total: ${Math.round(parseFloat(result.newBalance!)).toLocaleString('es-VE')} ${assetType.unitLabel}.`,
        `📱 Ver tu cuenta y canjear premios: ${pwaLink}`,
      ];
    } else {
      // On failure, hint about typing "factura" for details
      return [
        result.message,
        `Si tienes dudas acerca del escaneo envia la palabra: factura`,
      ];
    }
  }

  // Default: state greeting
  return getStateGreeting(state, merchantName, balance, phoneNumber, undefined, merchantSlug, branchName, cashierSlug);
}
