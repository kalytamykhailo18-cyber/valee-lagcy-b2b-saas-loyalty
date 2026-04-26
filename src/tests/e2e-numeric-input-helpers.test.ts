/**
 * Locks in the dot/comma rejection behavior shared across every points/stock
 * input in the merchant frontend (Eric 2026-04-25). The helpers are inlined
 * in each page (so this test mirrors them locally), but the rule MUST stay:
 *   - any non-digit character is stripped on input
 *   - display always shows dot thousand separators
 *   - "1.500" parses to 1500, never 1.5
 *   - "14,5" parses to 145, never 14.5
 */

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

const fmtThousands = (s: string) => {
  const digits = String(s).replace(/\D/g, '');
  if (!digits) return '';
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};
const stripNonDigits = (s: string) => s.replace(/\D/g, '');

console.log('=== Numeric input helpers — dot/comma rejection ===\n');

// 1. Eric's exact regression: typing "1.500" must yield 1500, not 1.5.
assert(stripNonDigits('1.500') === '1500', '"1.500" → "1500"');
assert(parseInt(stripNonDigits('1.500'), 10) === 1500, 'parseInt → 1500');

// 2. Comma should be rejected too — Spanish locale users type both.
assert(stripNonDigits('1,500') === '1500', '"1,500" → "1500"');
assert(stripNonDigits('14,5') === '145', '"14,5" → "145" (never 14.5)');

// 3. Display formatting adds the dot back for readability.
assert(fmtThousands('1500') === '1.500', '"1500" → display "1.500"');
assert(fmtThousands('15000') === '15.000', '"15000" → display "15.000"');
assert(fmtThousands('1500000') === '1.500.000', '"1500000" → "1.500.000"');

// 4. Round-trip: store digits → display → round-trip on next change must
//    preserve the underlying integer.
const storedRoundtrip = stripNonDigits(fmtThousands(stripNonDigits('1.500')));
assert(storedRoundtrip === '1500', `Round-trip preserves 1500 (got ${storedRoundtrip})`);

// 5. Empty / partial states.
assert(fmtThousands('') === '', 'Empty → empty');
assert(stripNonDigits('') === '', 'Empty strip → empty');
assert(fmtThousands('abc') === '', 'Pure letters → empty');
assert(fmtThousands('5') === '5', 'Single digit unchanged');
assert(fmtThousands('50') === '50', 'Two digits unchanged');
assert(fmtThousands('500') === '500', 'Three digits unchanged');
assert(fmtThousands('5000') === '5.000', 'Four digits get separator');

// 6. Mixed garbage + digits — only digits survive.
assert(stripNonDigits('1.5abc00$%') === '1500', 'Mixed garbage → digits only');
assert(stripNonDigits('--500--') === '500', 'Dashes stripped');
assert(stripNonDigits('5e3') === '53', 'Scientific notation collapsed to digits');

// 7. Recurrencia interval/gracia: 365 / 90 caps. Backend validates the
//    upper bound; the helper only enforces "digits only".
assert(stripNonDigits('365') === '365', 'Max interval intact');
assert(stripNonDigits('90') === '90', 'Max grace intact');
assert(stripNonDigits('1') === '1', 'Min interval intact');
assert(stripNonDigits('0') === '0', 'Zero intact');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
