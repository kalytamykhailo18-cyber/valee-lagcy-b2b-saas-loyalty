/**
 * E2E: formatPoints/formatCash use es-VE thousand separators so the
 * consumer PWA and merchant panel render amounts consistently (Genesis:
 * consumer showed '2207' while merchant already showed '2.207').
 *
 * The helper is pure and runs fine in Node, so we test it directly.
 */

import dotenv from 'dotenv';
dotenv.config();

import { formatPoints, formatCash } from '../frontend/lib/format.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== formatPoints / formatCash thousand-separator E2E ===\n');

  // formatPoints: whole-number, es-VE separator ('.' for thousands)
  await assert('formatPoints(2207) has thousand separator',
    formatPoints(2207) === '2.207', `got="${formatPoints(2207)}"`);
  await assert('formatPoints("172327") separates both groups',
    formatPoints('172327') === '172.327', `got="${formatPoints('172327')}"`);
  await assert('formatPoints(45) stays bare',
    formatPoints(45) === '45', `got="${formatPoints(45)}"`);
  await assert('formatPoints rounds floats',
    formatPoints(303.6) === '304', `got="${formatPoints(303.6)}"`);
  await assert('formatPoints handles NaN gracefully',
    formatPoints('oops') === '0', `got="${formatPoints('oops')}"`);

  // formatCash: integer branch gets separator, decimals get 2-digit fraction
  await assert('formatCash integer uses separator',
    formatCash(5000) === '5.000', `got="${formatCash(5000)}"`);
  await assert('formatCash fractional has 2 decimals + separator',
    formatCash(1234.5) === '1.234,50', `got="${formatCash(1234.5)}"`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
