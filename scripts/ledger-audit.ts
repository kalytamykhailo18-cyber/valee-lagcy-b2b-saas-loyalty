/**
 * Ledger integrity audit.
 *
 * Verifies every financial invariant that must hold 100% of the time on a
 * platform like Valee. Runs on every tenant against the live DB. Exits 0 when
 * all invariants hold, non-zero (with a detailed breakdown) on any violation.
 *
 * Intended to run after every deploy and on a cron (bundled into the smoke
 * schedule). This is the "lab" verification Eric asked for before going to
 * market.
 *
 * Invariants checked:
 *   A. Double-entry: every reference_id in a tenant has exactly 2 rows, one
 *      DEBIT and one CREDIT, with equal amounts.
 *   B. Value conservation: sum(CREDIT amounts) = sum(DEBIT amounts) per tenant.
 *   C. No negative balances on consumer accounts (shadow/verified).
 *   D. Unique reference_id per tenant (no duplicates).
 *   E. Hash chain: each entry's prev_hash matches the previous entry's hash
 *      (ordered by created_at, then DEBIT-before-CREDIT within ties).
 *   F. Referential integrity: every staffId/branchId in metadata resolves to
 *      a real row, every Referral row's referrer & referee exist.
 *   G. Pairing consistency: every paired_entry_id forms a valid bidirectional
 *      pair (A.paired = B.id AND B.paired = A.id) with same amount/reference.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { verifyHashChain } from '../src/services/ledger.js';

type Violation = { tenantSlug: string; invariant: string; detail: string };
const violations: Violation[] = [];
const scalars: Record<string, number> = { entriesChecked: 0, tenantsChecked: 0 };

function violate(tenantSlug: string, invariant: string, detail: string) {
  violations.push({ tenantSlug, invariant, detail });
}

async function auditTenant(tenantId: string, tenantSlug: string) {
  scalars.tenantsChecked++;

  // ----------------- A. Double-entry pairing per reference_id -----------------
  // A reference_id in a tenant should have exactly 2 rows (debit + credit)
  // with equal amount. Some reference_ids (PENDING- and the confirmed form
  // after reconciliation) may share rows across both states; we group strictly
  // by reference_id.
  const refAggregates = await prisma.$queryRaw<Array<{ reference_id: string; count: bigint; debit_sum: string; credit_sum: string }>>`
    SELECT reference_id,
           COUNT(*)::bigint AS count,
           COALESCE(SUM(CASE WHEN entry_type = 'DEBIT'  THEN amount ELSE 0 END), 0)::text AS debit_sum,
           COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0)::text AS credit_sum
    FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid
    GROUP BY reference_id
  `;
  for (const r of refAggregates) {
    if (Number(r.count) !== 2) {
      violate(tenantSlug, 'A.double-entry', `reference_id=${r.reference_id} has ${r.count} rows (expected 2)`);
    }
    if (r.debit_sum !== r.credit_sum) {
      violate(tenantSlug, 'A.balanced-pair', `reference_id=${r.reference_id} debit=${r.debit_sum} vs credit=${r.credit_sum}`);
    }
  }

  // ----------------- B. Value conservation (sum credits == sum debits) -----------------
  const [conservation] = await prisma.$queryRaw<[{ credit_sum: string; debit_sum: string }]>`
    SELECT
      COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0)::text AS credit_sum,
      COALESCE(SUM(CASE WHEN entry_type = 'DEBIT'  THEN amount ELSE 0 END), 0)::text AS debit_sum
    FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid
  `;
  if (conservation.credit_sum !== conservation.debit_sum) {
    violate(tenantSlug, 'B.conservation',
      `tenant-wide sum(CREDIT)=${conservation.credit_sum} != sum(DEBIT)=${conservation.debit_sum}`);
  }

  // ----------------- C. No negative balances on consumer accounts -----------------
  const negBalances = await prisma.$queryRaw<Array<{ account_id: string; phone: string | null; balance: string }>>`
    SELECT a.id::text AS account_id, a.phone_number AS phone,
           (COALESCE(SUM(CASE WHEN le.entry_type = 'CREDIT' AND le.status != 'reversed' THEN le.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN le.entry_type = 'DEBIT'  AND le.status != 'reversed' THEN le.amount ELSE 0 END), 0))::text AS balance
    FROM accounts a
    LEFT JOIN ledger_entries le ON le.account_id = a.id
    WHERE a.tenant_id = ${tenantId}::uuid
      AND a.account_type IN ('shadow', 'verified')
    GROUP BY a.id, a.phone_number
    HAVING (COALESCE(SUM(CASE WHEN le.entry_type = 'CREDIT' AND le.status != 'reversed' THEN le.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN le.entry_type = 'DEBIT'  AND le.status != 'reversed' THEN le.amount ELSE 0 END), 0)) < 0
  `;
  for (const r of negBalances) {
    violate(tenantSlug, 'C.non-negative-balance',
      `account=${r.account_id.slice(0,8)} phone=${r.phone} balance=${r.balance}`);
  }

  // ----------------- D. No duplicate reference_id (already covered partially by A) -----------------
  const dupes = await prisma.$queryRaw<Array<{ reference_id: string; count: bigint }>>`
    SELECT reference_id, COUNT(*)::bigint AS count
    FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid
    GROUP BY reference_id
    HAVING COUNT(*) > 2
  `;
  for (const r of dupes) {
    violate(tenantSlug, 'D.ref-uniqueness', `reference_id=${r.reference_id} has ${r.count} rows (>2)`);
  }

  // ----------------- E. Hash chain -----------------
  const chainResult = await verifyHashChain(tenantId);
  if (!chainResult.valid) {
    violate(tenantSlug, 'E.hash-chain', `broken at ${chainResult.brokenAt}`);
  }

  // ----------------- F. Referential integrity on metadata -----------------
  // staffId in metadata must resolve to a real staff row of this tenant
  const staffRefs = await prisma.$queryRaw<Array<{ entry_id: string; staff_id: string }>>`
    SELECT id::text AS entry_id, (metadata->>'staffId')::text AS staff_id
    FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid AND metadata->>'staffId' IS NOT NULL
  `;
  for (const r of staffRefs) {
    const exists = await prisma.staff.findFirst({ where: { id: r.staff_id, tenantId }, select: { id: true } });
    if (!exists) violate(tenantSlug, 'F.staff-ref-integrity', `entry=${r.entry_id.slice(0,8)} staffId=${r.staff_id} not found in this tenant`);
  }
  // branch_id on entries must resolve to a real branch of this tenant
  const branchRefs = await prisma.$queryRaw<Array<{ entry_id: string; branch_id: string }>>`
    SELECT id::text AS entry_id, branch_id::text AS branch_id
    FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid AND branch_id IS NOT NULL
  `;
  for (const r of branchRefs) {
    const b = await prisma.branch.findFirst({ where: { id: r.branch_id, tenantId }, select: { id: true } });
    if (!b) violate(tenantSlug, 'F.branch-ref-integrity', `entry=${r.entry_id.slice(0,8)} branchId=${r.branch_id} not found in this tenant`);
  }

  // ----------------- G. paired_entry_id bidirectional -----------------
  // For each row, paired_entry_id should point to a row that points back.
  const pairs = await prisma.$queryRaw<Array<{ id: string; paired: string; ref: string; amt: string; et: string }>>`
    SELECT id::text AS id, paired_entry_id::text AS paired, reference_id AS ref, amount::text AS amt, entry_type::text AS et
    FROM ledger_entries
    WHERE tenant_id = ${tenantId}::uuid AND paired_entry_id IS NOT NULL
  `;
  scalars.entriesChecked += pairs.length;
  // Build map for O(1) lookup
  const byId = new Map(pairs.map(p => [p.id, p]));
  for (const p of pairs) {
    const back = byId.get(p.paired);
    if (!back) {
      violate(tenantSlug, 'G.pair-back-reference', `entry=${p.id.slice(0,8)} paired=${p.paired.slice(0,8)} but pair row not found`);
      continue;
    }
    if (back.paired !== p.id) {
      violate(tenantSlug, 'G.pair-symmetry', `entry=${p.id.slice(0,8)} pairs to ${p.paired.slice(0,8)} but back pairs to ${back.paired.slice(0,8)}`);
    }
    if (back.ref !== p.ref) {
      violate(tenantSlug, 'G.pair-reference', `entry=${p.id.slice(0,8)} ref=${p.ref} but paired ref=${back.ref}`);
    }
    if (back.amt !== p.amt) {
      violate(tenantSlug, 'G.pair-amount', `entry=${p.id.slice(0,8)} amt=${p.amt} paired amt=${back.amt}`);
    }
    if (back.et === p.et) {
      violate(tenantSlug, 'G.pair-type', `entry=${p.id.slice(0,8)} entry_type=${p.et} same as paired`);
    }
  }
}

async function auditReferrals() {
  const orphans = await prisma.$queryRaw<Array<{ id: string; side: string; account_id: string }>>`
    SELECT r.id::text AS id, 'referrer' AS side, r.referrer_account_id::text AS account_id
    FROM referrals r LEFT JOIN accounts a ON a.id = r.referrer_account_id
    WHERE a.id IS NULL
    UNION ALL
    SELECT r.id::text AS id, 'referee' AS side, r.referee_account_id::text AS account_id
    FROM referrals r LEFT JOIN accounts a ON a.id = r.referee_account_id
    WHERE a.id IS NULL
  `;
  for (const r of orphans) {
    violate('(global)', 'F.referral-integrity', `referral=${r.id.slice(0,8)} ${r.side}=${r.account_id.slice(0,8)} missing`);
  }
}

async function main() {
  console.log('\n=== Ledger integrity audit ===\n');
  const start = Date.now();

  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } });
  for (const t of tenants) {
    process.stdout.write(`· ${t.slug}...`);
    const before = violations.length;
    await auditTenant(t.id, t.slug);
    const added = violations.length - before;
    process.stdout.write(added === 0 ? ' ok\n' : ` ${added} violations\n`);
  }
  await auditReferrals();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nChecked ${scalars.tenantsChecked} tenants, ${scalars.entriesChecked} paired entries in ${elapsed}s`);

  if (violations.length === 0) {
    console.log('\nALL INVARIANTS HOLD ✓');
    await prisma.$disconnect();
    process.exit(0);
  }

  console.log(`\n${violations.length} VIOLATIONS:`);
  const byTenant = new Map<string, Violation[]>();
  for (const v of violations) {
    if (!byTenant.has(v.tenantSlug)) byTenant.set(v.tenantSlug, []);
    byTenant.get(v.tenantSlug)!.push(v);
  }
  for (const [slug, list] of byTenant) {
    console.log(`\n[${slug}] ${list.length}`);
    const grouped = new Map<string, number>();
    for (const v of list) grouped.set(v.invariant, (grouped.get(v.invariant) || 0) + 1);
    for (const [inv, count] of grouped) {
      console.log(`  ${inv}: ${count}`);
    }
    // Print up to 3 sample details per tenant
    for (const v of list.slice(0, 3)) console.log(`    ${v.invariant}: ${v.detail}`);
  }

  await prisma.$disconnect();
  process.exit(1);
}

main().catch(async e => {
  console.error('AUDIT CRASHED:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
