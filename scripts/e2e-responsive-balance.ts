/**
 * E2E: big-number balances don't wrap to 3 lines on mobile (Genesis M9).
 * The consumer hub's 'Tu saldo total' and per-merchant 'Saldo' shrink
 * based on digit count.
 *
 * Source-level assertion (minified chunks drop the ternary structure).
 */

import dotenv from 'dotenv';
dotenv.config();

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Responsive balance sizing E2E ===\n');

  const fs = await import('fs/promises');
  const src = await fs.readFile(
    '/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx',
    'utf8',
  );

  // Hero-total uses digit-count-based sizing
  await assert('hub hero uses digit-count-based sizing',
    src.includes('digits >= 9') && src.includes('digits >= 7'),
    'verified');
  // Per-merchant card also resizes
  await assert('per-merchant saldo also resizes',
    src.match(/cls\s*=\s*digits\s*>=\s*9/)?.length ? true : false,
    'verified');
  // The old break-all on totalBalance is gone (wraps characters badly)
  await assert('break-all removed from hero totalBalance render',
    !src.includes('aa-count tabular-nums break-all leading-none'),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
