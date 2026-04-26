/**
 * Locks in the cosmetic 10x display rule for the multiplier UI (Eric 2026-04-25).
 * The actual conversion rate stays raw (50/100/etc) so the math is unchanged;
 * only the label adds a zero so the merchant sees a bigger marketing number.
 *
 * This is a pure-logic test — frontend rendering is verified by the
 * presence of these helpers and constants in the page source.
 */
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

console.log('=== UI: multiplier x10 label rule ===\n');

// 1. The label helper produces the expected display strings.
const labelX = (r: number) => `${(r * 10).toLocaleString('es-VE')}x`;
assert(labelX(50) === '500x', `50 → "500x" (got "${labelX(50)}")`);
assert(labelX(100) === '1.000x', `100 → "1.000x" (got "${labelX(100)}")`);
assert(labelX(150) === '1.500x', `150 → "1.500x" (got "${labelX(150)}")`);
assert(labelX(200) === '2.000x', `200 → "2.000x" (got "${labelX(200)}")`);

// 2. Cashback math: rate / 10 = percent (1000pts = $1 baseline).
const pct = (r: number) => `${(r / 10).toFixed(r % 10 === 0 ? 0 : 1)}%`;
assert(pct(50) === '5%', `50 → 5% cashback`);
assert(pct(100) === '10%', `100 → 10% cashback`);
assert(pct(150) === '15%', `150 → 15% cashback`);
assert(pct(200) === '20%', `200 → 20% cashback`);

// 3. $10 example: $10 * rate = points earned. With raw rate 50, $10 → 500 pts.
const example = (rate: number) => Math.round(10 * rate);
assert(example(50) === 500, `$10 at 50x raw → 500 pts`);
assert(example(100) === 1000, `$10 at 100x raw → 1000 pts`);

// 4. The frontend page source must use the labelX helper for the big rate
//    display, the preset buttons, and the "Cada $10 gastados = N puntos"
//    line, so the labels stay coherent.
const pageSrc = readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/page.tsx', 'utf-8');
assert(/const labelX = \(r: number\) => `\$\{\(r \* 10\)\.toLocaleString/.test(pageSrc), 'labelX helper present in page source');
assert(pageSrc.includes('{labelX(rateNow)}'), 'Big header uses labelX(rateNow)');
assert(pageSrc.includes('{labelX(parseFloat(p.value))}'), 'Preset buttons use labelX');
assert(pageSrc.includes('Cada <span className="font-semibold">$10</span> gastados = <span className="font-semibold">{Math.round(rateNow * 10)'), 'Subtitle reframed to $10 (so points number matches)');

// 5. Backend value stored is unchanged — the preset button still sends the raw
//    value (50/100/150/200) to api.setMultiplier. This is critical so the
//    actual conversion math doesn't change.
assert(/value: '50',  label: '5%'/.test(pageSrc), 'Preset value 50 unchanged');
assert(/value: '100', label: '10%'/.test(pageSrc), 'Preset value 100 unchanged');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
