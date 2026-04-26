/**
 * Eric 2026-04-25: branch selector visibility rules.
 *  - If the comercio has 0 active sucursales → the Sucursal selector card is
 *    hidden entirely (one-store layout).
 *  - If the comercio has 1+ active sucursales → only "Todas" + each sucursal
 *    appears. The "Sin sucursal" / "_unassigned" option must never appear,
 *    even if there's historical data without branch attribution.
 *
 * This test verifies the page source enforces both rules.
 */
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

console.log('=== UI: branch selector visibility rule ===\n');

const src = readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/page.tsx', 'utf-8');

// Two selectors live in the dashboard: the top "Sucursal" card and the
// transactions filter dropdown. Both must follow the same rule.

// 1. Each selector is wrapped in a conditional that requires AT LEAST one
//    ACTIVE branch. Inactive-only branches → still hidden.
const wrapMatches = src.match(/branches\.filter\(b => b\.active\)\.length > 0/g) || [];
assert(wrapMatches.length >= 2, `Active-branch wrapper used >= 2 times (got ${wrapMatches.length})`);

// 2. No "_unassigned" option remains in the rendered options. We allow the
//    string in comments / state-clearing useEffect, but NOT inside an
//    <option value="_unassigned"> tag.
const optionUnassigned = src.match(/<option value="_unassigned"/g) || [];
assert(optionUnassigned.length === 0, `No '<option value="_unassigned"' tag remains (got ${optionUnassigned.length})`);

// 3. The "valueIssuedUnassigned > 0" gate that previously surfaced the option
//    is gone from BOTH selectors. The defensive useEffect that resets a
//    stale '_unassigned' selection back to '' is allowed to keep referencing
//    the field (it just keeps the UI tidy if the bucket disappears).
const surfaceConditions = src.match(/metrics\?\.valueIssuedUnassigned && parseFloat\(metrics\.valueIssuedUnassigned\) > 0 && \(\s*<option/g) || [];
assert(surfaceConditions.length === 0, `No conditional surfacing _unassigned option (got ${surfaceConditions.length})`);

// 4. The "Todas las sucursales (total comercio)" option still leads the top
//    selector — that's the merchant-wide view.
assert(src.includes('Todas las sucursales (total comercio)'), 'Top selector still leads with "Todas las sucursales"');
assert(src.includes('<option value="">Todas</option>'), 'Transactions filter still has "Todas"');

// 5. The branch list inside both selectors maps over the active branches.
const branchOptionMaps = src.match(/branches\.filter\(b => b\.active\)\.map\(b =>\s*\(\s*<option key=\{b\.id\} value=\{b\.id\}>\{b\.name\}<\/option>/g) || [];
assert(branchOptionMaps.length >= 2, `Each selector maps over active branches (got ${branchOptionMaps.length})`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
