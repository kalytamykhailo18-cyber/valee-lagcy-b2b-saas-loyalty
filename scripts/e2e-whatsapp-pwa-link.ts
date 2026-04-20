/**
 * E2E: every WhatsApp response that should point the user to the PWA
 * includes a valid deep link built from the tenant slug (not from a
 * guessed slug derived from the merchant name).
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { getStateGreeting } from '../src/services/whatsapp-bot.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: 'smoke-test' } });
  if (!tenant) throw new Error('smoke-test tenant missing');

  const base = (process.env.CONSUMER_APP_URL || 'https://valee.app').replace(/\/+$/, '');
  const expected = `${base}/consumer?tenant=${tenant.slug}`;

  const states = ['first_time', 'returning_with_history', 'active_purchase', 'registered_never_scanned'] as const;
  for (const state of states) {
    const msgs = getStateGreeting(state, tenant.name, '0', '+19500000001', '50', tenant.slug);
    const joined = msgs.join('\n');
    await assert(`${state}: contains PWA link`, joined.includes(expected),
      `link=${expected} got="${joined.slice(0, 90)}..."`);
  }

  // With a display name that differs from slug, confirm the link uses slug and
  // not the name-derived fallback (the old bug produced e.g. "cafe-juan-valdez"
  // when the slug is actually "cafe-juan"). The merchantSlug param must win.
  const fakeName = 'Cafe Juan Valdez Plaza';
  const customSlug = 'cafe-juan';
  const msg = getStateGreeting('first_time', fakeName, '0', '+19500000002', '50', customSlug);
  const url = `${base}/consumer?tenant=${customSlug}`;
  await assert('slug wins over name-derived fallback', msg.join('\n').includes(url),
    `expected ${url}`);
  await assert('name-derived fallback absent when slug provided',
    !msg.join('\n').includes('cafe-juan-valdez-plaza'),
    'no stale slug leakage');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
