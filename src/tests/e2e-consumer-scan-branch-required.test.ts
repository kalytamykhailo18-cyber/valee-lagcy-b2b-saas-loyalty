/**
 * Eric 2026-04-26: from the consumer PWA the sucursal selector was visible
 * but the scan worked even with no branch picked. For multi-sucursal
 * comercios (>=2 branches) that means invoices got attributed to no branch.
 * Single-branch comercios stay un-gated so the consumer doesn't have to pick
 * the only option.
 *
 * Source-level checks that the gate logic is wired into the page. Full UX
 * needs a browser, but these guarantee the four critical guards exist:
 * camera doesn't open, processQrToken aborts, processInvoiceImage aborts,
 * Tomar foto / Galeria buttons disabled.
 */
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

console.log('=== UI: consumer scan blocks until sucursal picked (multi-branch) ===\n');

const src = readFileSync('/home/loyalty-platform/frontend/app/(consumer)/scan/page.tsx', 'utf-8');

// 1. Single-branch tenants stay un-gated — the existing selector still uses
//    branches.length > 1, matching the >=2 threshold consistently across the
//    file. (Block was added without changing the visibility rule.)
assert(/branches\.length > 1 &&/.test(src), 'Gate uses branches.length > 1 (i.e. 2+ active)');

// 2. processInvoiceImage aborts BEFORE uploading when blocked.
assert(/if \(branches\.length > 1 && !selectedBranchId\) \{[\s\S]{0,300}elige la sucursal[\s\S]{0,300}return/.test(src),
  'processInvoiceImage aborts with a clear message');

// 3. processQrToken aborts BEFORE setting processing state.
assert(/if \(branches\.length > 1 && !selectedBranchId\) return/.test(src),
  'processQrToken short-circuits when no branch picked');

// 4. Camera (Html5Qrcode.start) does NOT initialize when blocked.
assert(/startScanner = useCallback\(async \(\) => \{[\s\S]{0,400}if \(branches\.length > 1 && !selectedBranchId\) return/.test(src),
  'startScanner returns early when blocked (camera never opens)');

// 5. The auto-start effect tears down the scanner when the gate engages, and
//    re-fires when selectedBranchId becomes truthy.
assert(/if \(branches\.length > 1 && !selectedBranchId\) \{\s+stopScanner\(\)/.test(src),
  'Auto-start effect stops scanner while blocked');
assert(/\}, \[stage, startScanner, stopScanner, branches\.length, selectedBranchId\]/.test(src),
  'Auto-start effect deps include selectedBranchId so picking re-fires it');

// 6. Buttons disabled + visible cue.
assert(/disabled=\{branchGateBlocked\}/.test(src), 'Tomar foto / Galeria buttons disabled when blocked');
assert(/disabled:opacity-40 disabled:cursor-not-allowed/.test(src), 'Buttons render in blocked state');
assert(/Elege?[ií] sucursal arriba para activar el escaner/i.test(src) || /Elegi sucursal arriba/.test(src),
  'Footer hint changes to ask for sucursal selection');

// 7. Camera area shows an explicit overlay so the consumer knows why it's dark.
assert(/Elige tu sucursal[\s\S]{0,200}la camara se activa/.test(src),
  'Viewfinder overlay tells the consumer to pick a sucursal');

// 8. branchGateBlocked is the single derived flag the render uses.
assert(/const branchGateBlocked = branches\.length > 1 && !selectedBranchId/.test(src),
  'branchGateBlocked derived once at render time');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
