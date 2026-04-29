/**
 * Eric 2026-04-26: orphan ledger entries (branch_id IS NULL) had no badge in
 * the merchant transactions list and no filter option, so the owner had no
 * way to find them. This test guards both halves:
 *
 *   (a) Frontend: when sucursales exist AND there are orphan rows, the page
 *       shows a "Sin sucursal" filter option AND renders an amber badge on
 *       null-branch rows. When no orphans exist the option stays hidden so
 *       the prior "todo deberia estar atribuido" rule still holds.
 *
 *   (b) Backend: GET /api/merchant/transactions?branchId=_unassigned returns
 *       only the orphan rows, and the metrics endpoint reports
 *       valueIssuedUnassigned > 0 so the frontend can light up the option.
 */
import dotenv from 'dotenv'; dotenv.config();
import { readFileSync } from 'fs';
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { writeDoubleEntry } from '../services/ledger.js';
import { issueStaffTokens } from '../services/auth.js';
import merchantRoutes from '../api/routes/merchant.js';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function cleanAll() {
  assertTestDatabase();
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_truncate`;
  await prisma.$executeRaw`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_no_update`;
  await prisma.recurrenceNotification.deleteMany(); await prisma.recurrenceRule.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.dispute.deleteMany(); await prisma.redemptionToken.deleteMany();
  await prisma.dualScanSession.deleteMany(); await prisma.staffScanSession.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.invoice.deleteMany(); await prisma.uploadBatch.deleteMany();
  await prisma.ledgerEntry.deleteMany(); await prisma.auditLog.deleteMany();
  await prisma.idempotencyKey.deleteMany(); await prisma.tenantAssetConfig.deleteMany();
  await prisma.product.deleteMany(); await prisma.otpSession.deleteMany();
  await prisma.staff.deleteMany(); await prisma.account.deleteMany();
  await prisma.assetType.deleteMany(); await prisma.branch.deleteMany();
  await prisma.adminUser.deleteMany(); await prisma.tenant.deleteMany();
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_truncate`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_update`;
}

async function test() {
  console.log('=== E2E: orphan transactions stay traceable in the merchant panel ===\n');

  // ─────────── PART A: frontend source guards ───────────
  console.log('Part A — frontend source guards');
  const src = readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/page.tsx', 'utf-8');

  assert(/const hasUnassigned\s*=/.test(src), 'hasUnassigned derived from metrics');
  assert(/valueIssuedUnassigned[\s\S]{0,80}>\s*0[\s\S]{0,180}valueRedeemedUnassigned[\s\S]{0,80}>\s*0/.test(src),
    'hasUnassigned considers BOTH issued and redeemed orphans');
  assert(/hasUnassigned && \(\s*<option value="_unassigned">Sin sucursal \(sin atribuir\)/.test(src),
    'Top selector shows "_unassigned" option only when hasUnassigned');
  assert(/hasUnassigned && \(\s*<option value="_unassigned">Sin sucursal/.test(src),
    'Transactions filter shows "_unassigned" option only when hasUnassigned');
  assert(/!tx\.branchName && \(\s*<span[\s\S]{0,200}Sin sucursal\s*<\/span>/.test(src),
    'Row badge "Sin sucursal" renders for null-branch rows when sucursales exist');
  assert(/bg-amber-100 text-amber-800/.test(src),
    'Orphan badge uses amber palette to stand out from attributed indigo badge');

  // ─────────── PART B: backend behavior ───────────
  console.log('\nPart B — backend filters & metrics report orphans');
  await cleanAll();

  const tenant = await createTenant('Multi', 'multi-orphan', 't@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1');
  await setTenantConversionRate(tenant.id, asset.id, '1');

  const branchA = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal A', address: 'A', active: true },
  });
  await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal B', address: 'B', active: true },
  });

  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Eric', email: 'e@e.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  const consumer = await findOrCreateConsumerAccount(tenant.id, '+584125559900');

  // 3 invoices: one stamped to Sucursal A, two ORPHANS (the bugged
  // pre-fix scenario where the consumer-side scan didn't pick a branch).
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '100', assetTypeId: asset.id,
    referenceId: 'INV-A1', referenceType: 'invoice',
    branchId: branchA.id,
  });
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '50', assetTypeId: asset.id,
    referenceId: 'INV-ORPHAN-1', referenceType: 'invoice',
    branchId: null,
  });
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '75', assetTypeId: asset.id,
    referenceId: 'INV-ORPHAN-2', referenceType: 'invoice',
    branchId: null,
  });

  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const ownerToken = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;

  // 1. Metrics endpoint reports valueIssuedUnassigned > 0 so the frontend
  //    knows to surface the "_unassigned" option.
  const metricsRes = await fetch(`http://127.0.0.1:${port}/api/merchant/metrics`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const metrics: any = await metricsRes.json();
  assert(metricsRes.status === 200, `GET /metrics → 200 (got ${metricsRes.status})`);
  assert(parseFloat(metrics.valueIssuedUnassigned) === 125,
    `valueIssuedUnassigned = 50+75 = 125 (got ${metrics.valueIssuedUnassigned})`);

  // 2. /transactions with no branchId returns ALL three rows.
  const allRes = await fetch(`http://127.0.0.1:${port}/api/merchant/transactions?limit=50&offset=0`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const all: any = await allRes.json();
  const allRefs = (all.transactions || all.entries || []).map((t: any) => t.referenceId).sort();
  assert(allRefs.includes('INV-A1'), 'Aggregate view includes attributed row');
  assert(allRefs.includes('INV-ORPHAN-1') && allRefs.includes('INV-ORPHAN-2'),
    `Aggregate view includes both orphan rows (got ${JSON.stringify(allRefs)})`);

  // 3. /transactions?branchId=_unassigned returns ONLY the orphans.
  const orphanRes = await fetch(`http://127.0.0.1:${port}/api/merchant/transactions?branchId=_unassigned&limit=50&offset=0`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const orphan: any = await orphanRes.json();
  const orphanRefs = (orphan.transactions || orphan.entries || []).map((t: any) => t.referenceId).sort();
  assert(orphanRefs.length === 2, `_unassigned filter returns 2 rows (got ${orphanRefs.length}: ${JSON.stringify(orphanRefs)})`);
  assert(!orphanRefs.includes('INV-A1'), 'Attributed row is excluded');
  assert(orphanRefs.includes('INV-ORPHAN-1') && orphanRefs.includes('INV-ORPHAN-2'),
    'Both orphan rows present in _unassigned filter');

  // 4. /transactions?branchId=<branchA> returns ONLY the attributed row.
  const branchRes = await fetch(`http://127.0.0.1:${port}/api/merchant/transactions?branchId=${branchA.id}&limit=50&offset=0`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const branchData: any = await branchRes.json();
  const branchRefs = (branchData.transactions || branchData.entries || []).map((t: any) => t.referenceId).sort();
  assert(branchRefs.length === 1 && branchRefs[0] === 'INV-A1',
    `Branch A filter returns only INV-A1 (got ${JSON.stringify(branchRefs)})`);

  // 5. Each row exposes branchName so the frontend can render the badge or
  //    fall through to the "Sin sucursal" amber tag.
  const sample = (all.transactions || all.entries || []).find((t: any) => t.referenceId === 'INV-A1');
  const orphanSample = (all.transactions || all.entries || []).find((t: any) => t.referenceId === 'INV-ORPHAN-1');
  assert(sample?.branchName === 'Sucursal A', `Attributed row exposes branchName (got "${sample?.branchName}")`);
  assert(orphanSample && (orphanSample.branchName == null),
    `Orphan row reports branchName=null (got "${orphanSample?.branchName}")`);

  await app.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
