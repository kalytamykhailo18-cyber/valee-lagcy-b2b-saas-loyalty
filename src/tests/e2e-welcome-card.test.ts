import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import fs from 'fs';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function test() {
  console.log('=== WELCOME CARD VERIFICATION ===\n');

  const src = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx', 'utf-8');

  // ──────────────────────────────────
  // 1. Shows ONLY on first visit (before any invoice validated)
  // ──────────────────────────────────
  console.log('1. Appears only on first visit (no invoice history)');
  assert(src.includes("!localStorage.getItem('welcomeDismissed')"), 'Checks welcomeDismissed in localStorage');
  assert(src.includes('histData.entries.length === 0'), 'Only shows when history is empty (no invoices)');
  assert(src.includes('setShowWelcome(true)'), 'Sets showWelcome=true when both conditions met');

  // ──────────────────────────────────
  // 2. Greets generically
  // ──────────────────────────────────
  console.log('\n2. Greets user generically');
  assert(src.includes('>Hola!</'), 'Says "Hola!" (generic greeting)');
  assert(src.includes('Bienvenido a tu programa de recompensas'), 'Explains what the app is for');

  // ──────────────────────────────────
  // 3. Never appears again after dismissal
  // ──────────────────────────────────
  console.log('\n3. Never appears again (persistent localStorage)');
  assert(src.includes("localStorage.setItem('welcomeDismissed', 'true')"), 'Stores dismissal permanently in localStorage');
  assert(src.includes('dismissWelcome'), 'Has dismiss function');
  assert(src.includes('Entendido'), 'Dismiss button says "Entendido"');

  // The flow:
  // - On load: check localStorage.welcomeDismissed
  // - If not dismissed AND no history: show card
  // - On dismiss: set welcomeDismissed=true in localStorage → never shown again
  // - localStorage persists across page reloads, browser restarts
  assert(!src.includes('sessionStorage'), 'Uses localStorage (not sessionStorage) — survives restarts');

  // ──────────────────────────────────
  // 4. Content explains the app
  // ──────────────────────────────────
  console.log('\n4. Content explains what the app is for');
  assert(src.includes('facturas'), 'Mentions invoices/facturas');
  assert(src.includes('puntos'), 'Mentions points');
  assert(src.includes('productos'), 'Mentions products for redemption');

  // ──────────────────────────────────
  // 5. Animation
  // ──────────────────────────────────
  console.log('\n5. Animated entrance');
  assert(src.includes('animate-fade-in'), 'Welcome card has fade-in animation');

  // Check animation is defined in CSS
  const cssSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/globals.css', 'utf-8');
  assert(cssSrc.includes('fadeIn'), 'fadeIn animation defined in CSS');
  assert(cssSrc.includes('.animate-fade-in'), '.animate-fade-in class exists');

  console.log(`\n=== WELCOME CARD: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
