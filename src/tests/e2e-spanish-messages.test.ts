import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import fs from 'fs';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function test() {
  console.log('=== SPANISH MESSAGES CHECK ===\n');

  const botSrc = fs.readFileSync('/home/loyalty-platform/src/services/whatsapp-bot.ts', 'utf-8');

  // ──────────────────────────────────
  // 1. State 1 (first-time) — welcoming, educational
  // ──────────────────────────────────
  console.log('1. State 1 greeting (first-time) — Spanish, welcoming');
  assert(botSrc.includes('Bienvenido'), 'Contains "Bienvenido" (welcome)');
  assert(botSrc.includes('Envíanos una foto de tu factura'), 'Instruction to send photo');
  assert(botSrc.includes('Así de simple'), 'Encouraging tone');

  // ──────────────────────────────────
  // 2. State 2 (returning) — familiar, efficient
  // ──────────────────────────────────
  console.log('\n2. State 2 greeting (returning) — Spanish, familiar');
  assert(botSrc.includes('Hola de nuevo'), '"Hola de nuevo" (welcome back)');
  assert(botSrc.includes('Tu saldo actual'), 'Shows balance immediately');
  assert(botSrc.includes('nueva factura'), 'Asks about new receipt');

  // ──────────────────────────────────
  // 3. State 3 (active purchase) — contextual
  // ──────────────────────────────────
  console.log('\n3. State 3 greeting (active purchase) — Spanish, contextual');
  assert(botSrc.includes('Acabas de visitar'), '"Acabas de visitar" (you just visited)');
  assert(botSrc.includes('No olvides enviar tu factura'), 'Reminder to send receipt');

  // ──────────────────────────────────
  // 4. State 4 (never scanned) — re-educational
  // ──────────────────────────────────
  console.log('\n4. State 4 greeting (never scanned) — Spanish, educational');
  assert(botSrc.includes('no has ganado puntos'), '"no has ganado puntos" (haven\'t earned points)');
  assert(botSrc.includes('Es muy fácil'), '"Es muy fácil" (it\'s very easy)');

  // ──────────────────────────────────
  // 5. Support responses — all Spanish
  // ──────────────────────────────────
  console.log('\n5. Support responses — Spanish');
  assert(botSrc.includes('Tu saldo actual es de'), 'Balance response in Spanish');
  assert(botSrc.includes('Tu última factura'), 'Receipt status in Spanish');
  assert(botSrc.includes('Para canjear tus puntos'), 'Redeem instructions in Spanish');
  assert(botSrc.includes('Lamentamos'), 'Problem response in Spanish');
  assert(botSrc.includes('No entendí tu mensaje'), 'Fallback in Spanish');

  // ──────────────────────────────────
  // 6. Invoice validation responses — Spanish
  // ──────────────────────────────────
  console.log('\n6. Validation responses — Spanish');
  assert(botSrc.includes('Factura validada'), 'Success: "Factura validada"');
  assert(botSrc.includes('Has ganado'), 'Success: "Has ganado" (you earned)');
  assert(botSrc.includes('Tu saldo total'), 'Success: "Tu saldo total" (your total balance)');
  assert(botSrc.includes('No pudimos leer tu factura'), 'Retry: "No pudimos leer" (couldn\'t read)');
  assert(botSrc.includes('foto más clara'), 'Retry: "foto más clara" (clearer photo)');
  assert(botSrc.includes('validación no puede completarse'), 'Give-up: "validación no puede completarse"');

  // ──────────────────────────────────
  // 7. No English-only user-facing messages
  // ──────────────────────────────────
  console.log('\n7. No English-only messages in bot responses');
  // The validateInvoice service returns English messages, but the bot handler
  // wraps them in Spanish. Check the bot handler doesn't leak English:
  const botImageBlock = botSrc.slice(
    botSrc.indexOf("messageType === 'image'"),
    botSrc.indexOf("// Default: state greeting")
  );
  assert(!botImageBlock.includes("'Invoice validated"), 'No English "Invoice validated" in bot image handler');
  assert(botImageBlock.includes('Factura validada'), 'Uses Spanish "Factura validada" instead');

  // ──────────────────────────────────
  // 8. Webhook sends all messages via WhatsApp
  // ──────────────────────────────────
  console.log('\n8. Messages delivered via WhatsApp');
  const webhookSrc = fs.readFileSync('/home/loyalty-platform/src/api/routes/webhook.ts', 'utf-8');
  assert(webhookSrc.includes('sendWhatsAppMessage(formattedPhone, msg)'), 'Each message sent to consumer via WhatsApp');
  assert(webhookSrc.includes('No pudimos identificar tu comercio'), 'No-tenant fallback in Spanish');

  console.log(`\n=== SPANISH: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
