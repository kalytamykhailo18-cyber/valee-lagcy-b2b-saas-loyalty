/**
 * E2E: WhatsApp greetings include the branch name when the user scanned
 * a branch QR. Genesis L4 — 'Luxor Fitness' should read 'Luxor Fitness
 * - Luxor Valencia' when a branch is in the scan context.
 */

import dotenv from 'dotenv';
dotenv.config();

import { getStateGreeting } from '../src/services/whatsapp-bot.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== WhatsApp greeting includes branch name E2E ===\n');

  // With branch
  const withBranch = getStateGreeting(
    'first_time', 'Luxor Fitness', '0', '+19999999999',
    '50', 'luxor-fitness', 'Luxor Valencia',
  );
  const joinedFirst = withBranch.join(' ');
  await assert('first_time greeting includes "Luxor Fitness - Luxor Valencia"',
    joinedFirst.includes('Luxor Fitness - Luxor Valencia'),
    `got="${joinedFirst.slice(0, 120)}..."`);

  const active = getStateGreeting(
    'active_purchase', 'Luxor Fitness', '50', '+19999999999',
    undefined, 'luxor-fitness', 'Luxor Valencia',
  );
  await assert('active_purchase greeting includes branch',
    active.join(' ').includes('Luxor Fitness - Luxor Valencia'),
    `got="${active.join(' ').slice(0, 120)}..."`);

  const never = getStateGreeting(
    'registered_never_scanned', 'Luxor Fitness', '0', '+19999999999',
    undefined, 'luxor-fitness', 'Luxor Valencia',
  );
  await assert('registered_never_scanned includes branch',
    never.join(' ').includes('Luxor Fitness - Luxor Valencia'),
    'yes');

  // Without branch (fallback) — just the merchant name
  const noBranch = getStateGreeting(
    'first_time', 'Luxor Fitness', '0', '+19999999999',
    '50', 'luxor-fitness',
  );
  const joinedNoBranch = noBranch.join(' ');
  await assert('no-branch fallback keeps merchant name only',
    joinedNoBranch.includes('Luxor Fitness') && !joinedNoBranch.includes(' - '),
    `got="${joinedNoBranch.slice(0, 120)}..."`);

  // returning_with_history greeting doesn't mention the merchant (by design
  // — 'Hola de nuevo! Tu saldo actual...'), so branch name doesn't apply
  // there and shouldn't be injected.
  const returning = getStateGreeting(
    'returning_with_history', 'Luxor Fitness', '100', '+19999999999',
    undefined, 'luxor-fitness', 'Luxor Valencia',
  );
  await assert('returning greeting stays generic (no branch injection)',
    !returning.join(' ').includes('Luxor Valencia'),
    `got="${returning.join(' ').slice(0, 120)}..."`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
