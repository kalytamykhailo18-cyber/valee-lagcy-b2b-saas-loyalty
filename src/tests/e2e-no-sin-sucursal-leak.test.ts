/**
 * Eric 2026-04-25: "Sin sucursal" must not leak into the merchant UI when
 * the comercio works with sucursales. Selectors already strip it; this
 * test catches the row-level badges and other places where the literal
 * string was being rendered as a fallback.
 *
 * Source-level scan — fast, deterministic, complements the page-source
 * tests already in the suite.
 */
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

console.log('=== UI: no "Sin sucursal" rendered fallback in merchant frontend ===\n');

// Find every JSX rendering of the literal "Sin sucursal" inside any merchant
// page source (NOT comments, NOT compiled .next bundles).
let renderedHits = '';
try {
  renderedHits = execSync(
    `grep -rn "Sin sucursal" /home/loyalty-platform/frontend/app/(merchant) ` +
    `| grep -v "/.next/" ` +
    `| grep -v "//" ` +
    `| grep -v "/\\*" ` +
    `| grep -v "// " || true`,
    { encoding: 'utf-8' }
  );
} catch (e: any) {
  // grep returns 1 when no matches; treat as success
  renderedHits = '';
}

// Allow comments inside JSX braces ({/* ... */}) by filtering further.
const lines = renderedHits.split('\n').filter(Boolean).filter(line => {
  // strip the file:line: prefix
  const code = line.replace(/^[^:]+:\d+:/, '');
  // skip lines that are entirely a JSX comment {/* ... */} or any plain comment
  if (/^\s*\{\s*\/\*/.test(code)) return false;
  if (/^\s*\/\//.test(code)) return false;
  if (/^\s*\*/.test(code)) return false;
  // skip lines that are part of a multi-line comment containing "Sin sucursal"
  if (/sucursales,?\s*"Sin sucursal"/i.test(code)) return false;
  if (/showed "Sin sucursal"/i.test(code)) return false;
  if (/producing "Sin sucursal"/i.test(code)) return false;
  if (/no se ofrece/i.test(code)) return false;
  return true;
});

assert(lines.length === 0, `No rendered "Sin sucursal" string in merchant pages (found ${lines.length})`);
if (lines.length > 0) {
  console.log('Offending lines:');
  for (const l of lines) console.log('  ', l);
}

// Spot check the dashboard: the row badge only renders the branch name now.
const dashSrc = readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/page.tsx', 'utf-8');
assert(
  /branches\.filter\(b => b\.active\)\.length > 0 && tx\.branchName && \(/.test(dashSrc),
  'Transactions row badge requires both active branches AND a real branchName'
);

// Spot check the customers panel: invoice subtitle only shows branch name when present.
const custSrc = readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/customers/page.tsx', 'utf-8');
assert(
  /\{inv\.branch\?\.name && <span>· \{inv\.branch\.name\}<\/span>\}/.test(custSrc),
  'Customers panel renders branch only when it exists, no fallback string'
);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
