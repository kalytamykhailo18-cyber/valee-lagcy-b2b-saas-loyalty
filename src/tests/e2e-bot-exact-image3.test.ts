import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { handleIncomingMessage } from '../services/whatsapp-bot.js';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function test() {
  console.log('=== E2E: bot reply to Erics exact image-3 text ===\n');

  // Use the existing Farmatodo tenant from the previous test run.
  // (cleanAll is intentionally NOT called — we want to keep the
  // welcome-bonus-off state to verify the inline path.)
  const tenant = await prisma.tenant.findFirst({ where: { slug: 'farmatodo' } });
  if (!tenant) {
    console.log('  SKIP — Farmatodo tenant not found, run e2e-bot-qr-rescan-and-unassigned first');
    process.exit(0);
  }
  // Re-enable bonus to test the welcome path correctly
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { welcomeBonusActive: true, welcomeBonusAmount: 2500 },
  });

  // The exact text from Eric's image 3 — no "Hola" prefix, no extra text.
  // This is what WhatsApp sends when a user fresh-scans a Cajero QR and the
  // deep link auto-fills the message body.
  const cases = [
    'Valee Ref: farmatodo Cjr: 4dcb1w43',
    'Valee Ref: farmatodo',                               // no cashier
    'Hola! Quiero ganar puntos en farmatodo Valee Ref: farmatodo Cjr: 4dcb1w43',
    'Hola Valee Ref: farmatodo Cjr: qv0vsywj',            // image 2 form
    'MERCHANT:farmatodo',                                 // legacy fallback
  ];

  for (const text of cases) {
    // Use a fresh phone each time so we hit the first_time path repeatedly.
    const phone = '+58412555' + String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const reply = await handleIncomingMessage({
      phoneNumber: phone,
      tenantId: tenant.id,
      messageType: 'text',
      messageText: text,
    });
    const joined = reply.join(' ');
    const hasNoEntiendo = /No entendí/i.test(joined);
    const hasGreeting = /bienvenida|Bienvenido|saldo/i.test(joined);
    assert(!hasNoEntiendo, `"${text.slice(0, 40)}..." → no fallback`);
    assert(hasGreeting,    `"${text.slice(0, 40)}..." → state-based greeting`);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
