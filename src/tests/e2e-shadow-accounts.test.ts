import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { writeDoubleEntry, getAccountBalance } from '../services/ledger.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { initiateRedemption } from '../services/redemption.js';

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
  await prisma.dispute.deleteMany(); await prisma.redemptionToken.deleteMany();
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
  console.log('=== SHADOW ACCOUNT SYSTEM: FULL E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Shadow Shop', 'shadow-shop', 'ss@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@ss.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // ──────────────────────────────────
  // 1. Auto-created on first contact (no registration)
  // ──────────────────────────────────
  console.log('1. Auto-created on first contact — no registration');
  const r1 = await findOrCreateConsumerAccount(tenant.id, '+58412555001');
  assert(r1.created === true, 'Account created automatically');
  assert(r1.account.accountType === 'shadow', 'Type is "shadow"');
  assert(r1.account.phoneNumber === '+58412555001', 'Phone stored in international format');
  assert(r1.account.tenantId === tenant.id, 'Belongs to correct tenant');
  assert(!!r1.account.createdAt, 'Has creation timestamp');
  assert(!!r1.account.id, 'Has ledger account ID (UUID)');

  // ──────────────────────────────────
  // 2. Idempotent — same phone returns same account
  // ──────────────────────────────────
  console.log('\n2. Idempotent — same phone returns existing account');
  const r2 = await findOrCreateConsumerAccount(tenant.id, '+58412555001');
  assert(r2.created === false, 'Not created again');
  assert(r2.account.id === r1.account.id, 'Same account ID returned');

  // Call it 5 more times — still the same
  for (let i = 0; i < 5; i++) {
    const r = await findOrCreateConsumerAccount(tenant.id, '+58412555001');
    assert(r.account.id === r1.account.id, `Call ${i+3}: still same ID`);
  }

  // ──────────────────────────────────
  // 3. Unique constraint — no duplicates at DB level
  // ──────────────────────────────────
  console.log('\n3. DB-level unique constraint');
  try {
    await prisma.account.create({
      data: { tenantId: tenant.id, phoneNumber: '+58412555001', accountType: 'shadow' },
    });
    assert(false, 'Should have been rejected by unique constraint');
  } catch (err: any) {
    assert(err.code === 'P2002', 'Duplicate phone rejected at DB level');
  }

  // ──────────────────────────────────
  // 4. Balance starts at zero
  // ──────────────────────────────────
  console.log('\n4. Balance starts at zero');
  const balance = await getAccountBalance(r1.account.id, asset.id, tenant.id);
  assert(Number(balance) === 0, `Initial balance: 0 (got ${balance})`);

  // ──────────────────────────────────
  // 5. Can receive value (earn points) without registration
  // ──────────────────────────────────
  console.log('\n5. Shadow account can earn value');
  await processCSV(`invoice_number,total\nSHAD-001,300.00`, tenant.id, staff.id);
  const valResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+58412555001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SHAD-001', total_amount: 300, transaction_date: '2024-01-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(valResult.success === true, 'Invoice validated for shadow account');
  const balAfter = await getAccountBalance(r1.account.id, asset.id, tenant.id);
  assert(Number(balAfter) === 300, `Balance after earning: 300 (got ${balAfter})`);

  // ──────────────────────────────────
  // 6. Can hold a balance and redeem — no difference from verified
  // ──────────────────────────────────
  console.log('\n6. Shadow account can redeem value');
  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Shadow Prize', redemptionCost: '50.00000000', assetTypeId: asset.id, stock: 5, active: true },
  });
  const redemption = await initiateRedemption({
    consumerAccountId: r1.account.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  assert(redemption.success === true, 'Shadow account can initiate redemption');
  const balAfterRedeem = await getAccountBalance(r1.account.id, asset.id, tenant.id);
  assert(Number(balAfterRedeem) === 250, `Balance after redemption: 250 (got ${balAfterRedeem})`);

  // ──────────────────────────────────
  // 7. Same phone, different tenant = separate shadow account
  // ──────────────────────────────────
  console.log('\n7. Same phone, different tenant = separate account');
  const tenant2 = await createTenant('Other Shop', 'other-shop', 'os@t.com');
  await createSystemAccounts(tenant2.id);
  const r3 = await findOrCreateConsumerAccount(tenant2.id, '+58412555001');
  assert(r3.created === true, 'New account created in different tenant');
  assert(r3.account.id !== r1.account.id, 'Different account ID');
  assert(r3.account.tenantId === tenant2.id, 'Belongs to second tenant');
  const bal2 = await getAccountBalance(r3.account.id, asset.id, tenant2.id);
  assert(Number(bal2) === 0, `Zero balance in second tenant (got ${bal2})`);

  console.log(`\n=== SHADOW ACCOUNTS: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
