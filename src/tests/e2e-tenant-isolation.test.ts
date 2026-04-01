import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { getAccountBalance, getAccountHistory } from '../services/ledger.js';
import { initiateRedemption } from '../services/redemption.js';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function cleanAll() {
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
  console.log('=== MULTI-TENANT ISOLATION: FULL E2E ===\n');
  await cleanAll();

  const asset = await createAssetType('Points', 'pts', '1.00000000');

  // Create two completely independent tenants
  const tenantA = await createTenant('Bakery A', 'bakery-a', 'a@bakery.com');
  const tenantB = await createTenant('Cafe B', 'cafe-b', 'b@cafe.com');
  const sysA = await createSystemAccounts(tenantA.id);
  const sysB = await createSystemAccounts(tenantB.id);

  const staffA = await prisma.staff.create({
    data: { tenantId: tenantA.id, name: 'Owner A', email: 'owner@a.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  const staffB = await prisma.staff.create({
    data: { tenantId: tenantB.id, name: 'Owner B', email: 'owner@b.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Same phone number registers at both merchants — two separate accounts
  const PHONE = '+58412SAME001';

  // ──────────────────────────────────
  // 1. ACCOUNTS: same phone, different accounts
  // ──────────────────────────────────
  console.log('1. ACCOUNTS: same phone creates separate accounts per tenant');
  const { account: consA } = await findOrCreateConsumerAccount(tenantA.id, PHONE);
  const { account: consB } = await findOrCreateConsumerAccount(tenantB.id, PHONE);
  assert(consA.id !== consB.id, `Different account IDs (A=${consA.id.slice(0,8)}, B=${consB.id.slice(0,8)})`);
  assert(consA.tenantId === tenantA.id, 'Account A belongs to Tenant A');
  assert(consB.tenantId === tenantB.id, 'Account B belongs to Tenant B');

  // ──────────────────────────────────
  // 2. INVOICES: upload to A, invisible to B
  // ──────────────────────────────────
  console.log('\n2. INVOICES: CSV data scoped to uploading tenant');
  await processCSV(`invoice_number,total\nISO-001,500.00\nISO-002,300.00`, tenantA.id, staffA.id);
  await processCSV(`invoice_number,total\nISO-001,200.00`, tenantB.id, staffB.id); // same invoice_number, different tenant

  const invoicesA = await prisma.invoice.findMany({ where: { tenantId: tenantA.id } });
  const invoicesB = await prisma.invoice.findMany({ where: { tenantId: tenantB.id } });
  assert(invoicesA.length === 2, `Tenant A has 2 invoices (got ${invoicesA.length})`);
  assert(invoicesB.length === 1, `Tenant B has 1 invoice (got ${invoicesB.length})`);
  assert(Number(invoicesA.find(i => i.invoiceNumber === 'ISO-001')!.amount) === 500, 'Tenant A ISO-001 = $500');
  assert(Number(invoicesB.find(i => i.invoiceNumber === 'ISO-001')!.amount) === 200, 'Tenant B ISO-001 = $200 (different amount, same number)');

  // ──────────────────────────────────
  // 3. LEDGER: validation credits only to the correct tenant
  // ──────────────────────────────────
  console.log('\n3. LEDGER: financial events scoped to tenant');
  await validateInvoice({
    tenantId: tenantA.id, senderPhone: PHONE, assetTypeId: asset.id,
    extractedData: { invoice_number: 'ISO-001', total_amount: 500, transaction_date: '2024-01-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  await validateInvoice({
    tenantId: tenantB.id, senderPhone: PHONE, assetTypeId: asset.id,
    extractedData: { invoice_number: 'ISO-001', total_amount: 200, transaction_date: '2024-01-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  const ledgerA = await prisma.ledgerEntry.findMany({ where: { tenantId: tenantA.id } });
  const ledgerB = await prisma.ledgerEntry.findMany({ where: { tenantId: tenantB.id } });
  assert(ledgerA.length === 2, `Tenant A has 2 ledger entries (got ${ledgerA.length})`);
  assert(ledgerB.length === 2, `Tenant B has 2 ledger entries (got ${ledgerB.length})`);
  assert(!ledgerA.some(e => e.tenantId === tenantB.id), 'No Tenant B data in Tenant A ledger');
  assert(!ledgerB.some(e => e.tenantId === tenantA.id), 'No Tenant A data in Tenant B ledger');

  // ──────────────────────────────────
  // 4. BALANCE: independent per tenant
  // ──────────────────────────────────
  console.log('\n4. BALANCE: independent per tenant for same phone number');
  const balA = await getAccountBalance(consA.id, asset.id, tenantA.id);
  const balB = await getAccountBalance(consB.id, asset.id, tenantB.id);
  assert(Number(balA) === 500, `Tenant A balance = 500 (got ${balA})`);
  assert(Number(balB) === 200, `Tenant B balance = 200 (got ${balB})`);

  // ──────────────────────────────────
  // 5. HISTORY: independent per tenant
  // ──────────────────────────────────
  console.log('\n5. HISTORY: each tenant sees only their own events');
  const histA = await getAccountHistory(consA.id, tenantA.id);
  const histB = await getAccountHistory(consB.id, tenantB.id);
  assert(histA.length === 1, `Tenant A history: 1 event (got ${histA.length})`);
  assert(histB.length === 1, `Tenant B history: 1 event (got ${histB.length})`);
  assert(histA.every(e => e.tenantId === tenantA.id), 'All Tenant A history belongs to A');
  assert(histB.every(e => e.tenantId === tenantB.id), 'All Tenant B history belongs to B');

  // ──────────────────────────────────
  // 6. PRODUCTS: scoped per tenant
  // ──────────────────────────────────
  console.log('\n6. PRODUCTS: scoped per tenant');
  const prodA = await prisma.product.create({
    data: { tenantId: tenantA.id, name: 'Bread', redemptionCost: '100.00000000', assetTypeId: asset.id, stock: 10, active: true },
  });
  const prodB = await prisma.product.create({
    data: { tenantId: tenantB.id, name: 'Latte', redemptionCost: '50.00000000', assetTypeId: asset.id, stock: 20, active: true },
  });

  const prodsA = await prisma.product.findMany({ where: { tenantId: tenantA.id } });
  const prodsB = await prisma.product.findMany({ where: { tenantId: tenantB.id } });
  assert(prodsA.length === 1 && prodsA[0].name === 'Bread', 'Tenant A sees only Bread');
  assert(prodsB.length === 1 && prodsB[0].name === 'Latte', 'Tenant B sees only Latte');

  // ──────────────────────────────────
  // 7. STAFF: scoped per tenant
  // ──────────────────────────────────
  console.log('\n7. STAFF: scoped per tenant');
  const staffListA = await prisma.staff.findMany({ where: { tenantId: tenantA.id } });
  const staffListB = await prisma.staff.findMany({ where: { tenantId: tenantB.id } });
  assert(staffListA.length === 1 && staffListA[0].name === 'Owner A', 'Tenant A sees only Owner A');
  assert(staffListB.length === 1 && staffListB[0].name === 'Owner B', 'Tenant B sees only Owner B');

  // ──────────────────────────────────
  // 8. CROSS-TENANT CLAIM: consumer A cannot claim Tenant B invoice
  // ──────────────────────────────────
  console.log('\n8. CROSS-TENANT: Tenant A consumer cannot claim Tenant B invoice');
  await processCSV(`invoice_number,total\nCROSS-001,100.00`, tenantB.id, staffB.id);
  const crossResult = await validateInvoice({
    tenantId: tenantA.id, senderPhone: PHONE, assetTypeId: asset.id,
    extractedData: { invoice_number: 'CROSS-001', total_amount: 100, transaction_date: '2024-01-01', customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(crossResult.success === false, 'Cross-tenant claim rejected');
  assert(crossResult.stage === 'cross_reference', `Rejected at cross-reference (not found in Tenant A data)`);

  // ──────────────────────────────────
  // 9. ADMIN: can see both tenants
  // ──────────────────────────────────
  console.log('\n9. ADMIN: cross-tenant visibility');
  const allTenants = await prisma.tenant.findMany();
  const allLedger = await prisma.ledgerEntry.findMany();
  const allAccounts = await prisma.account.findMany({ where: { accountType: { in: ['shadow', 'verified'] } } });
  assert(allTenants.length === 2, `Admin sees 2 tenants (got ${allTenants.length})`);
  assert(allLedger.length === 4, `Admin sees 4 ledger entries total (got ${allLedger.length})`);
  assert(allAccounts.length === 2, `Admin sees 2 consumer accounts (got ${allAccounts.length})`);

  console.log(`\n=== TENANT ISOLATION: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
