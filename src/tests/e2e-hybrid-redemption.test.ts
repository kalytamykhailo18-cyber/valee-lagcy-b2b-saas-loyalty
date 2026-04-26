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
  await prisma.recurrenceNotification.deleteMany(); await prisma.recurrenceRule.deleteMany();
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
  console.log('=== HYBRID REDEMPTION: CASH + POINTS ===\n');
  await cleanAll();

  const tenant = await createTenant('Hybrid Store', 'hybrid-store', 'hy@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@hy.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Consumer has 300 points
  await processCSV(`invoice_number,total\nHY-001,300.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'HY-001', total_amount: 300, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

  // Product: 1000 points OR $10 cash (hybrid enabled)
  const hybridProduct = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Premium Gift', redemptionCost: '1000.00000000', cashPrice: 10.00, assetTypeId: asset.id, stock: 5, active: true, minLevel: 1 },
  });

  // Points-only product (no cash price)
  const pointsOnlyProduct = await prisma.product.create({
    data: { tenantId: tenant.id, name: 'Basic Gift', redemptionCost: '100.00000000', assetTypeId: asset.id, stock: 5, active: true, minLevel: 1 },
  });

  // ──────────────────────────────────
  // 1. Full points redemption (no cash) — consumer can't afford 1000 pts
  // ──────────────────────────────────
  console.log('1. Full points — insufficient balance');
  const r1 = await initiateRedemption({
    consumerAccountId: account!.id, productId: hybridProduct.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  assert(r1.success === false, 'Rejected (300 < 1000 points)');
  assert(r1.message.includes('cash'), 'Suggests cash option');

  // ──────────────────────────────────
  // 2. Hybrid: $7 cash + points (covers 70%, needs 300 pts)
  // ──────────────────────────────────
  console.log('\n2. Hybrid: $7 cash + 300 points');
  const r2 = await initiateRedemption({
    consumerAccountId: account!.id, productId: hybridProduct.id, tenantId: tenant.id, assetTypeId: asset.id,
    cashAmount: '7.00',
  });
  assert(r2.success === true, `Hybrid redemption succeeded`);
  assert(r2.hybrid === true, 'Marked as hybrid');
  assert(r2.cashAmount === '7', `Cash: $${r2.cashAmount}`);
  assert(r2.message.includes('points') && r2.message.includes('cash'), `Message: ${r2.message.slice(0, 60)}`);

  // Points deducted (70% cash = 30% points = 300 pts)
  const balAfter = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(Number(balAfter) === 0, `Points balance: 0 (300 - 300) (got ${balAfter})`);

  // Ledger entries have hybrid metadata
  const pendingEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'REDEMPTION_PENDING' },
  });
  assert(pendingEntries.length === 2, '2 PENDING entries (double-entry)');
  const debitEntry = pendingEntries.find(e => e.entryType === 'DEBIT')!;
  assert((debitEntry.metadata as any)?.hybrid === true, 'Metadata: hybrid=true');
  assert((debitEntry.metadata as any)?.cashAmount === 7, 'Metadata: cashAmount=7');

  // Token has cashAmount
  const tokenRecord = await prisma.redemptionToken.findUnique({ where: { id: r2.tokenId! } });
  assert(Number(tokenRecord!.cashAmount) === 7, `Token cashAmount: ${tokenRecord!.cashAmount}`);

  // ──────────────────────────────────
  // 3. Cashier processes hybrid QR — same flow
  // ──────────────────────────────────
  console.log('\n3. Cashier processes hybrid QR');
  const scan = await processRedemption({ token: r2.token!, cashierStaffId: staff.id, cashierTenantId: tenant.id });
  assert(scan.success === true, 'Cashier scan succeeds');
  assert(scan.productName === 'Premium Gift', `Product: ${scan.productName}`);

  // ──────────────────────────────────
  // 4. Product without cash price — cash rejected
  // ──────────────────────────────────
  console.log('\n4. Points-only product rejects cash');
  // Give consumer more points first
  await processCSV(`invoice_number,total\nHY-002,500.00`, tenant.id, staff.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'HY-002', total_amount: 500, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const r4 = await initiateRedemption({
    consumerAccountId: account!.id, productId: pointsOnlyProduct.id, tenantId: tenant.id, assetTypeId: asset.id,
    cashAmount: '5.00',
  });
  assert(r4.success === false, 'Cash rejected for points-only product');
  assert(r4.message.includes('does not accept cash'), `Reason: ${r4.message}`);

  // ──────────────────────────────────
  // 5. Points-only product — works normally
  // ──────────────────────────────────
  console.log('\n5. Points-only product works normally');
  const r5 = await initiateRedemption({
    consumerAccountId: account!.id, productId: pointsOnlyProduct.id, tenantId: tenant.id, assetTypeId: asset.id,
  });
  assert(r5.success === true, 'Points-only redemption succeeds');
  assert(r5.hybrid === false || r5.hybrid === undefined, 'Not marked as hybrid');

  // ──────────────────────────────────
  // 6. Full cash (100%) — 0 points needed
  // ──────────────────────────────────
  console.log('\n6. Full cash payment (0 points)');
  const r6 = await initiateRedemption({
    consumerAccountId: account!.id, productId: hybridProduct.id, tenantId: tenant.id, assetTypeId: asset.id,
    cashAmount: '10.00', // full cash price
  });
  assert(r6.success === true, 'Full cash redemption succeeds');

  // ──────────────────────────────────
  // 7. DB schema
  // ──────────────────────────────────
  console.log('\n7. DB schema');
  const cols = await prisma.$queryRaw<any[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'cash_price'
  `;
  assert(cols.length === 1, 'products.cash_price column exists');

  const rtCols = await prisma.$queryRaw<any[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'redemption_tokens' AND column_name = 'cash_amount'
  `;
  assert(rtCols.length === 1, 'redemption_tokens.cash_amount column exists');

  console.log(`\n=== HYBRID REDEMPTION: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
