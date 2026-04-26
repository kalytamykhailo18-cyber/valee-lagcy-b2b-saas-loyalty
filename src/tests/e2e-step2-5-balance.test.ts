import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { initiateRedemption, processRedemption } from '../services/redemption.js';
import { getAccountBalance } from '../services/ledger.js';

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
  console.log('=== STEP 2.5: BALANCE TRACKING THROUGH FULL REDEMPTION CYCLE ===\n');
  await cleanAll();

  const tenant = await createTenant('Balance Store', 'balance-store-25', 'bs@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'c@bs.com', passwordHash: '$2b$10$x', role: 'cashier' },
  });

  // Give consumer 500 pts
  await processCSV(`invoice_number,total\nBAL-001,500.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'BAL-001', total_amount: 500, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });
  const product = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Prize', redemptionCost: '100.00000000', assetTypeId: asset.id, stock: 5, active: true, minLevel: 1 },
  });

  // Track balance at each step
  console.log('Balance tracking through the full redemption cycle:\n');

  const bal0 = await getAccountBalance(account!.id, asset.id, tenant.id);
  console.log(`  1. After earning 500 pts: ${bal0}`);
  assert(Number(bal0) === 500, `Starting balance: 500`);

  // Initiate redemption (100 pts reserved)
  const redemption = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  const bal1 = await getAccountBalance(account!.id, asset.id, tenant.id);
  console.log(`  2. After PENDING_REDEMPTION (100 reserved): ${bal1}`);
  assert(Number(bal1) === 400, `After reservation: 400 (500 - 100)`);

  // Cashier scans QR
  const scan = await processRedemption({
    token: redemption.token!, cashierStaffId: staff.id, cashierTenantId: tenant.id,
  });
  assert(scan.success === true, 'Scan succeeded');

  const bal2 = await getAccountBalance(account!.id, asset.id, tenant.id);
  console.log(`  3. After REDEMPTION_CONFIRMED: ${bal2}`);
  assert(Number(bal2) === 400, `After confirmation: 400 (value consumed, not returned)`);

  // Verify all ledger entries make accounting sense
  console.log('\nLedger entries for this consumer:');
  const entries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, accountId: account!.id },
    orderBy: { createdAt: 'asc' },
  });

  for (const e of entries) {
    const sign = e.entryType === 'CREDIT' ? '+' : '-';
    console.log(`  ${sign}${Number(e.amount)} | ${e.eventType}`);
  }

  // Count credits and debits
  const totalCredits = entries.filter(e => e.entryType === 'CREDIT').reduce((s, e) => s + Number(e.amount), 0);
  const totalDebits = entries.filter(e => e.entryType === 'DEBIT').reduce((s, e) => s + Number(e.amount), 0);
  const computedBalance = totalCredits - totalDebits;

  console.log(`\n  Total credits: +${totalCredits}`);
  console.log(`  Total debits:  -${totalDebits}`);
  console.log(`  Computed:      ${computedBalance}`);

  assert(computedBalance === 400, `Computed balance matches API: ${computedBalance}`);
  assert(Number(bal2) === computedBalance, 'API balance === computed from entries');

  // Product stock
  const finalProduct = await prisma.product.findUnique({ where: { id: product.id } });
  assert(finalProduct!.stock === 4, `Product stock: 5 → ${finalProduct!.stock}`);

  // Second redemption — balance drops further
  console.log('\nSecond redemption:');
  const redemption2 = await initiateRedemption({
    consumerAccountId: account!.id, productId: product.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  const bal3 = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(Number(bal3) === 300, `After 2nd reservation: 300 (got ${bal3})`);

  await processRedemption({
    token: redemption2.token!, cashierStaffId: staff.id, cashierTenantId: tenant.id,
  });
  const bal4 = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(Number(bal4) === 300, `After 2nd confirmation: 300 (got ${bal4})`);

  const finalProduct2 = await prisma.product.findUnique({ where: { id: product.id } });
  assert(finalProduct2!.stock === 3, `Product stock: 4 → ${finalProduct2!.stock}`);

  console.log(`\n=== BALANCE TRACKING: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
