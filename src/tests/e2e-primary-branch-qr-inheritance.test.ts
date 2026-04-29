/**
 * Eric 2026-04-26 (item "Panel Cajero y QR"):
 *   The first sucursal a merchant declares during onboarding (Kromi Valencia
 *   in Eric's setup) should inherit the QR generated at signup ("QR del
 *   comercio"). Today the Sucursales card for that first sede shows
 *   "Generar QR" as if the sede had no code yet; clicking generate produces a
 *   *different* QR (branch-scoped deep link), leaving the merchant with two
 *   separate QRs that should logically be one.
 *
 * This test proves:
 *   1. createBranch on a tenant with no branches inherits tenant.qrCodeUrl.
 *   2. Pre-existing tenants whose first branch missed the inheritance get
 *      reconciled the next time listBranches runs (lazy backfill).
 *   3. Subsequent branches (the 2nd, 3rd) do NOT inherit — they keep their
 *      own qrCodeUrl pathway.
 *   4. Regenerating the primary branch's QR rotates BOTH tenant.qrCodeUrl
 *      and branch.qrCodeUrl, and both end up identical.
 *   5. Regenerating a non-primary branch's QR rotates only that branch's
 *      qrCodeUrl, leaving tenant.qrCodeUrl untouched.
 */
import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createBranch, listBranches } from '../services/branches.js';
import { generateMerchantQR, generateBranchQR } from '../services/merchant-qr.js';

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
  await prisma.merchantScanSession.deleteMany();
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
  console.log('=== E2E: primary sucursal QR === tenant QR (single source of truth) ===\n');
  await cleanAll();

  // ─────────── Tenant A — happy path: first branch inherits ───────────
  console.log('1. Tenant A: signup → first branch inherits tenant.qrCodeUrl');
  const tenantA = await createTenant('Kromi', 'kromi-a', 'a@k.com');
  await createSystemAccounts(tenantA.id);
  await generateMerchantQR(tenantA.id);
  const tA1 = await prisma.tenant.findUnique({ where: { id: tenantA.id } });
  assert(!!tA1?.qrCodeUrl, `Tenant A has onboarding qrCodeUrl (got ${!!tA1?.qrCodeUrl})`);

  const valenciaA = await createBranch({ tenantId: tenantA.id, name: 'Kromi Valencia' });
  const valenciaARefreshed = await prisma.branch.findUnique({ where: { id: valenciaA.id } });
  assert(valenciaARefreshed?.qrCodeUrl === tA1!.qrCodeUrl,
    `First branch inherited tenant QR (branch === tenant: ${valenciaARefreshed?.qrCodeUrl === tA1!.qrCodeUrl})`);

  // ─────────── 2. Second branch does NOT inherit ───────────
  console.log('\n2. Tenant A: second branch starts with NO qrCodeUrl (independent path)');
  const caracasA = await createBranch({ tenantId: tenantA.id, name: 'Kromi Caracas' });
  const caracasARefreshed = await prisma.branch.findUnique({ where: { id: caracasA.id } });
  assert(caracasARefreshed?.qrCodeUrl === null,
    `Second branch starts with null qrCodeUrl (got ${caracasARefreshed?.qrCodeUrl})`);

  // ─────────── Tenant B — lazy backfill for already-broken state ───────────
  console.log('\n3. Tenant B: pre-existing branches with mismatched QRs get reconciled on listBranches');
  const tenantB = await createTenant('Kromi', 'kromi-b', 'b@k.com');
  await createSystemAccounts(tenantB.id);
  await generateMerchantQR(tenantB.id);
  const tB1 = await prisma.tenant.findUnique({ where: { id: tenantB.id } });
  // Simulate Eric's broken state: directly create the first branch via
  // prisma (bypassing the inheritance path) and stamp it with a random URL
  // that mimics a separately-generated branch QR.
  const firstB = await prisma.branch.create({
    data: { tenantId: tenantB.id, name: 'Kromi Valencia',
      qrCodeUrl: 'https://example.invalid/separately-generated-branch-qr.png' },
  });
  // Add two more branches (also separately stamped) so the primary really is
  // the oldest by createdAt (we created firstB first).
  await new Promise(r => setTimeout(r, 5));
  await prisma.branch.create({
    data: { tenantId: tenantB.id, name: 'Kromi Maracay',
      qrCodeUrl: 'https://example.invalid/maracay-branch-qr.png' },
  });
  await new Promise(r => setTimeout(r, 5));
  await prisma.branch.create({
    data: { tenantId: tenantB.id, name: 'Kromi Caracas',
      qrCodeUrl: 'https://example.invalid/caracas-branch-qr.png' },
  });

  // Sanity: before listBranches runs, the primary's QR is wrong.
  const primaryBeforeSync = await prisma.branch.findUnique({ where: { id: firstB.id } });
  assert(primaryBeforeSync?.qrCodeUrl !== tB1!.qrCodeUrl,
    `Pre-sync: primary branch QR differs from tenant QR (got ${primaryBeforeSync?.qrCodeUrl !== tB1!.qrCodeUrl})`);

  // listBranches triggers the lazy reconcile.
  const listed = await listBranches(tenantB.id);
  assert(listed.length === 3, `listBranches returned all 3 branches (got ${listed.length})`);
  const primaryAfterSync = await prisma.branch.findUnique({ where: { id: firstB.id } });
  assert(primaryAfterSync?.qrCodeUrl === tB1!.qrCodeUrl,
    `Post-sync: primary branch QR matches tenant QR (got ${primaryAfterSync?.qrCodeUrl === tB1!.qrCodeUrl})`);

  // Non-primary branches were NOT touched by the reconcile.
  const maracay = listed.find(b => b.name === 'Kromi Maracay');
  const caracas = listed.find(b => b.name === 'Kromi Caracas');
  assert(maracay?.qrCodeUrl === 'https://example.invalid/maracay-branch-qr.png',
    `Non-primary Maracay QR untouched (got ${maracay?.qrCodeUrl})`);
  assert(caracas?.qrCodeUrl === 'https://example.invalid/caracas-branch-qr.png',
    `Non-primary Caracas QR untouched (got ${caracas?.qrCodeUrl})`);

  // ─────────── 4. Regenerating PRIMARY branch rotates tenant + branch ───────────
  console.log('\n4. Regenerating primary branch QR rotates tenant.qrCodeUrl AND branch.qrCodeUrl identically');
  const tenantQrBefore = (await prisma.tenant.findUnique({ where: { id: tenantA.id } }))!.qrCodeUrl;
  const regenPrimary = await generateBranchQR(valenciaA.id);
  const tenantAfter = await prisma.tenant.findUnique({ where: { id: tenantA.id } });
  const valenciaAfter = await prisma.branch.findUnique({ where: { id: valenciaA.id } });
  assert(regenPrimary.qrCodeUrl !== null, `Regen returned a qrCodeUrl (got ${regenPrimary.qrCodeUrl !== null})`);
  assert(tenantAfter?.qrCodeUrl === regenPrimary.qrCodeUrl,
    `Tenant QR rotated to the new value (match: ${tenantAfter?.qrCodeUrl === regenPrimary.qrCodeUrl})`);
  assert(valenciaAfter?.qrCodeUrl === regenPrimary.qrCodeUrl,
    `Primary branch QR rotated to the new value (match: ${valenciaAfter?.qrCodeUrl === regenPrimary.qrCodeUrl})`);
  assert(tenantAfter?.qrCodeUrl === valenciaAfter?.qrCodeUrl,
    `Tenant and primary branch share identical QR after regen (match: ${tenantAfter?.qrCodeUrl === valenciaAfter?.qrCodeUrl})`);
  // Primary regen uses the slug-only deep link (no branch suffix), same as the onboarding QR.
  const decodedPrimary = decodeURIComponent(regenPrimary.deepLink);
  assert(/Valee Ref: kromi-a(?!\/)/.test(decodedPrimary),
    `Primary regen deep link encodes slug only, no branch suffix (got: "${decodedPrimary}")`);

  // ─────────── 5. Regenerating NON-PRIMARY branch leaves tenant alone ───────────
  console.log('\n5. Regenerating non-primary branch QR leaves tenant.qrCodeUrl untouched');
  const tenantBeforeCaracasRegen = (await prisma.tenant.findUnique({ where: { id: tenantA.id } }))!.qrCodeUrl;
  const regenCaracas = await generateBranchQR(caracasA.id);
  const tenantAfterCaracasRegen = await prisma.tenant.findUnique({ where: { id: tenantA.id } });
  const caracasAfter = await prisma.branch.findUnique({ where: { id: caracasA.id } });
  assert(tenantAfterCaracasRegen?.qrCodeUrl === tenantBeforeCaracasRegen,
    `Tenant QR unchanged after non-primary regen (match: ${tenantAfterCaracasRegen?.qrCodeUrl === tenantBeforeCaracasRegen})`);
  assert(caracasAfter?.qrCodeUrl === regenCaracas.qrCodeUrl,
    `Non-primary branch QR rotated (match: ${caracasAfter?.qrCodeUrl === regenCaracas.qrCodeUrl})`);
  assert(caracasAfter?.qrCodeUrl !== tenantAfterCaracasRegen?.qrCodeUrl,
    `Non-primary branch QR DIFFERS from tenant QR (different: ${caracasAfter?.qrCodeUrl !== tenantAfterCaracasRegen?.qrCodeUrl})`);
  // Non-primary regen uses the branch-suffix deep link.
  const decodedCaracas = decodeURIComponent(regenCaracas.deepLink);
  assert(new RegExp(`Valee Ref: kromi-a/${caracasA.id}`).test(decodedCaracas),
    `Non-primary regen deep link encodes branch suffix (got: "${decodedCaracas}")`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
