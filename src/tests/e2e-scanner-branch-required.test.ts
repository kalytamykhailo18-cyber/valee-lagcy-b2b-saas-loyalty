/**
 * Eric 2026-04-25: scanner page must REQUIRE a sucursal selection before
 * any canje is processed (camera or manual). Verifies the page source has
 * the guards in place — the actual UX needs a browser to fully verify.
 */
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

console.log('=== UI: scanner blocks until branch is selected ===\n');

const src = readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/scanner/page.tsx', 'utf-8');

// 1. processToken has the early-exit guard for multi-sucursal merchants.
assert(/const requiresBranch = branches\.filter\(b => b\.active\)\.length >= 2\s+if \(requiresBranch && !branchId\)/.test(src),
  'processToken aborts when multi-sucursal AND no branchId selected');
assert(/Antes de escanear, elige la sucursal/.test(src),
  'Block message tells the staff to pick the sucursal first');

// 2. Camera does not auto-start when blocked.
assert(/if \(state === 'scanning' && inputMode === 'camera' && !blocked\)/.test(src),
  'Camera startup gated on !blocked');

// 3. Manual button + input disabled when no branch picked.
assert(/disabled=\{tokenInput\.length !== 6 \|\| \(branches\.length >= 2 && !branchId\)\}/.test(src),
  'Manual submit button disabled when no branch');
assert(/disabled=\{branches\.length >= 2 && !branchId\}/.test(src),
  'Manual input disabled when no branch');

// 4. Visual cue: the selector card switches to the amber "Paso 1" treatment.
assert(/Paso 1: Elige la sucursal/.test(src), 'Step-1 framing surfaces when no branch');
assert(/bg-amber-50 border-amber-400/.test(src), 'Amber outline highlights the selector');

// 5. The whole input panel gets opacity-60 + pointer-events-none when blocked.
assert(/opacity-60 pointer-events-none/.test(src), 'Input panel dims when blocked');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
