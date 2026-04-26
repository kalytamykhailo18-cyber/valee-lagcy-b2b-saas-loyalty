import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { writeDoubleEntry } from '../services/ledger.js';
import { getMerchantMetrics } from '../services/metrics.js';

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
  console.log('=== E2E: EMITIDO breakdown surfaces Referidos as its own bucket ===\n');
  await cleanAll();

  const tenant = await createTenant('Kozmo', 'kozmo-ref', 'k@k.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  await setTenantConversionRate(tenant.id, asset.id, '1.00000000');

  const consumer = await findOrCreateConsumerAccount(tenant.id, '+584125550100');

  // Seed one of each emission type so the bucket math is unambiguous.
  // INVOICE_CLAIMED 100
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '100.00000000', assetTypeId: asset.id,
    referenceId: 'INV-1', referenceType: 'invoice',
  });
  // WELCOME 50
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '50.00000000', assetTypeId: asset.id,
    referenceId: 'WELCOME-' + consumer.account.id, referenceType: 'manual_adjustment',
  });
  // REFERRAL 25
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '25.00000000', assetTypeId: asset.id,
    referenceId: 'REFERRAL-test1', referenceType: 'manual_adjustment',
  });
  // ADMIN MANUAL 10 (no WELCOME / REFERRAL prefix)
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: sys.pool.id, creditAccountId: consumer.account.id,
    amount: '10.00000000', assetTypeId: asset.id,
    referenceId: 'ADJ-' + Date.now(), referenceType: 'manual_adjustment',
  });

  // Tenant aggregate (no branch filter)
  const m = await getMerchantMetrics(tenant.id);
  assert(parseFloat(m.valueIssuedInvoices) === 100, `invoices = 100 (got ${m.valueIssuedInvoices})`);
  assert(parseFloat(m.valueIssuedWelcome) === 50, `welcome = 50 (got ${m.valueIssuedWelcome})`);
  assert(parseFloat((m as any).valueIssuedReferrals) === 25, `referrals = 25 (new bucket, got ${(m as any).valueIssuedReferrals})`);
  assert(parseFloat(m.valueIssuedManual) === 10, `manual = 10 (no longer absorbs referral, got ${m.valueIssuedManual})`);
  assert(parseFloat(m.valueIssued) === 185, `total = 100+50+25+10 = 185 (got ${m.valueIssued})`);

  // _unassigned slice — the 4 entries above were all written with branchId=null,
  // so the unassigned slice mirrors the aggregate.
  const mU = await getMerchantMetrics(tenant.id, '_unassigned');
  assert(parseFloat((mU as any).valueIssuedReferrals) === 25, `_unassigned referrals = 25 (got ${(mU as any).valueIssuedReferrals})`);

  // Branch-scoped slice — none of the entries have a branchId, so a branch
  // query returns 0 across the board (regression check).
  const branch = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Test', address: 'X', active: true },
  });
  const mB = await getMerchantMetrics(tenant.id, branch.id);
  assert(parseFloat((mB as any).valueIssuedReferrals) === 0, `Branch slice referrals = 0 (got ${(mB as any).valueIssuedReferrals})`);
  assert(parseFloat(mB.valueIssued) === 0, `Branch slice total = 0`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
