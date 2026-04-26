/**
 * Eric 2026-04-25: the consumer landing page (first screen when entering a
 * comercio) shows a "Canjea tus puntos" carousel of product cards. They
 * must include the same stock + sucursal info the full catalog already
 * shows (image_2 reference): "N disponibles" and "Solo en X" / "Todas
 * las sucursales: A, B, C".
 */
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

console.log('=== UI: consumer landing preview cards show stock + sucursal ===\n');

const src = readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx', 'utf-8');

// Carousel sections rendered:
//   1. Regular products ("Canjea tus puntos")
//   2. Hybrid products ("Puntos + Efectivo")
// Both must surface stock + branch.

// 1. Stock counter line ("N disponibles") appears in the source twice
//    (once per carousel).
const stockMatches = src.match(/p\.stock\} disponibles/g) || [];
assert(stockMatches.length === 2, `Stock counter rendered in both carousels (got ${stockMatches.length})`);

// 2. Branch-scope rendering (Solo en / Todas las sucursales).
const onlyInMatches = src.match(/Solo en \{p\.branchName\}/g) || [];
assert(onlyInMatches.length === 2, `"Solo en X" branch-locked label rendered in both (got ${onlyInMatches.length})`);

const allBranchesMatches = src.match(/Todas las sucursales/g) || [];
assert(allBranchesMatches.length >= 2, `"Todas las sucursales" tenant-wide label rendered in both (got ${allBranchesMatches.length})`);

// 3. The branch logic switches on p.branchScope === 'branch' / 'tenant',
//    same as the full catalog (so the data path is shared).
const scopeBranch = src.match(/p\.branchScope === 'branch'/g) || [];
const scopeTenant = src.match(/p\.branchScope === 'tenant'/g) || [];
assert(scopeBranch.length === 2, `branchScope === 'branch' check in both (got ${scopeBranch.length})`);
assert(scopeTenant.length === 2, `branchScope === 'tenant' check in both (got ${scopeTenant.length})`);

// 4. The catalog page (the "perfecta" reference) has the exact same line
//    pattern, so a future drift would show up here.
const catSrc = readFileSync('/home/loyalty-platform/frontend/app/(consumer)/catalog/page.tsx', 'utf-8');
assert(/product\.stock\} disponibles/.test(catSrc), 'Catalog page still shows stock disponibles (reference)');
assert(/Solo en \{product\.branchName\}/.test(catSrc), 'Catalog page still shows "Solo en" (reference)');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
