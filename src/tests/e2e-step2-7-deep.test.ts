import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { getAccountBalance, getAccountHistory } from '../services/ledger.js';
import { issueConsumerTokens, issueStaffTokens, issueAdminTokens } from '../services/auth.js';
import consumerRoutes from '../api/routes/consumer.js';
import merchantRoutes from '../api/routes/merchant.js';
import adminRoutes from '../api/routes/admin.js';
import bcrypt from 'bcryptjs';
import fs from 'fs';

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
  console.log('=== STEP 2.7: SHADOW TO VERIFIED UPGRADE — DEEP E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Upgrade Store', 'upgrade-store', 'up@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'c@up.com', passwordHash: await bcrypt.hash('pass', 10), role: 'cashier' },
  });
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@up.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  const admin = await prisma.adminUser.create({
    data: { name: 'Admin', email: 'admin@up.com', passwordHash: await bcrypt.hash('admin', 10) },
  });

  // Give consumer some history
  await processCSV(`invoice_number,total\nUP-001,200.00\nUP-002,150.00`, tenant.id, owner.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'UP-001', total_amount: 200, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'UP-002', total_amount: 150, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  // Create second consumer for cedula conflict test
  const { findOrCreateConsumerAccount } = await import('../services/accounts.js');
  await findOrCreateConsumerAccount(tenant.id, '+584125550002');

  const account1 = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

  // Start server
  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(consumerRoutes); await app.register(merchantRoutes); await app.register(adminRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const cashierToken = issueStaffTokens({ staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff' }).accessToken;
  const consumerToken = issueConsumerTokens({ accountId: account1!.id, tenantId: tenant.id, phoneNumber: '+584125550001', type: 'consumer' }).accessToken;
  const adminToken = issueAdminTokens({ adminId: admin.id, type: 'admin' }).accessToken;

  // ──────────────────────────────────
  // 1. CASHIER LOOKUP: phone → account status + history + invoices
  // ──────────────────────────────────
  console.log('1. Cashier lookup by phone number');
  const lookupRes = await fetch(`${base}/api/merchant/customer-lookup/${encodeURIComponent('+584125550001')}`, {
    headers: { Authorization: `Bearer ${cashierToken}` },
  });
  const lookupData = await lookupRes.json() as any;
  assert(lookupRes.ok, `Lookup: ${lookupRes.status}`);
  assert(lookupData.account.phoneNumber === '+584125550001', `Phone: ${lookupData.account.phoneNumber}`);
  assert(lookupData.account.accountType === 'shadow', `Status: shadow`);
  assert(lookupData.account.level >= 1, `Level: ${lookupData.account.level}`);
  assert(Number(lookupData.balance) === 350, `Balance: ${lookupData.balance}`);
  assert(lookupData.history.length >= 2, `Ledger history: ${lookupData.history.length} entries`);
  assert(lookupData.invoices.length >= 2, `Invoice history: ${lookupData.invoices.length} invoices`);
  assert(lookupData.invoices[0].invoiceNumber !== undefined, 'Invoice number in history');
  assert(lookupData.invoices[0].status !== undefined, 'Invoice status in history');

  // Audit: CUSTOMER_LOOKUP logged
  const lookupAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE action_type = 'CUSTOMER_LOOKUP' AND tenant_id = ${tenant.id}::uuid
  `;
  assert(lookupAudit.length === 1, 'CUSTOMER_LOOKUP audit entry');
  assert(lookupAudit[0].actor_id === cashier.id, 'Logged cashier ID');

  // ──────────────────────────────────
  // 2. UPGRADE: shadow → verified
  // ──────────────────────────────────
  console.log('\n2. Upgrade shadow → verified');
  const upgradeRes = await fetch(`${base}/api/merchant/identity-upgrade`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
    body: JSON.stringify({ phoneNumber: '+584125550001', cedula: 'V-12345678' }),
  });
  const upgradeData = await upgradeRes.json() as any;
  assert(upgradeRes.ok, `Upgrade: ${upgradeRes.status}`);
  assert(upgradeData.account.accountType === 'verified', 'Account type: verified');
  assert(upgradeData.account.cedula === 'V-12345678', `Cedula stored: ${upgradeData.account.cedula}`);

  // Audit: IDENTITY_UPGRADE logged
  const upgradeAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE action_type = 'IDENTITY_UPGRADE' AND tenant_id = ${tenant.id}::uuid
  `;
  assert(upgradeAudit.length === 1, 'IDENTITY_UPGRADE audit entry');

  // ──────────────────────────────────
  // 3. HISTORY PRESERVED after upgrade
  // ──────────────────────────────────
  console.log('\n3. Ledger history preserved after upgrade');
  const historyAfter = await getAccountHistory(account1!.id, tenant.id);
  assert(historyAfter.length >= 2, `History intact: ${historyAfter.length} entries`);
  const balanceAfter = await getAccountBalance(account1!.id, asset.id, tenant.id);
  assert(Number(balanceAfter) === 350, `Balance unchanged: ${balanceAfter}`);

  // ──────────────────────────────────
  // 4. CONSUMER sees "verified" in PWA
  // ──────────────────────────────────
  console.log('\n4. Consumer sees verified status in PWA');
  const accRes = await fetch(`${base}/api/consumer/account`, {
    headers: { Authorization: `Bearer ${consumerToken}` },
  });
  const accData = await accRes.json() as any;
  assert(accData.accountType === 'verified', `PWA shows: ${accData.accountType}`);
  assert(accData.cedula === 'V-12345678', `PWA shows cedula: ${accData.cedula}`);

  // Frontend displays verified status
  const pageSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx', 'utf-8');
  assert(pageSrc.includes("'verified'") && pageSrc.includes('Cuenta verificada'), 'Frontend shows "Cuenta verificada"');

  // ──────────────────────────────────
  // 5. DUPLICATE CEDULA → warning (409)
  // ──────────────────────────────────
  console.log('\n5. Duplicate cedula → 409 conflict');
  const dupRes = await fetch(`${base}/api/merchant/identity-upgrade`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
    body: JSON.stringify({ phoneNumber: '+584125550002', cedula: 'V-12345678' }),
  });
  const dupData = await dupRes.json() as any;
  assert(dupRes.status === 409, `Duplicate cedula: 409 (got ${dupRes.status})`);
  assert(dupData.error.includes('already linked'), `Warning: ${dupData.error}`);
  assert(dupData.existingPhone !== undefined, 'Shows existing phone linked to cedula');
  assert(dupData.requiresConfirmation === true, 'Requires confirmation');

  // ──────────────────────────────────
  // 6. ALREADY VERIFIED → cannot re-upgrade
  // ──────────────────────────────────
  console.log('\n6. Already verified → 400');
  const reUpgrade = await fetch(`${base}/api/merchant/identity-upgrade`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
    body: JSON.stringify({ phoneNumber: '+584125550001', cedula: 'V-99999999' }),
  });
  assert(reUpgrade.status === 400, `Already verified: 400 (got ${reUpgrade.status})`);

  // ──────────────────────────────────
  // 7. ADMIN CAN UNLINK CEDULA (downgrade)
  // ──────────────────────────────────
  console.log('\n7. Admin can unlink cedula (downgrade)');
  const unlinkRes = await fetch(`${base}/api/admin/unlink-cedula`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ accountId: account1!.id, tenantId: tenant.id, reason: 'Incorrect cedula linked' }),
  });
  const unlinkData = await unlinkRes.json() as any;
  assert(unlinkRes.ok, `Unlink: ${unlinkRes.status}`);
  assert(unlinkData.account.accountType === 'shadow', 'Downgraded to shadow');
  assert(unlinkData.account.cedula === null, 'Cedula removed');

  // ──────────────────────────────────
  // 8. CASHIER CANNOT UNLINK (only admin)
  // ──────────────────────────────────
  console.log('\n8. Cashier cannot unlink cedula');
  const cashierUnlink = await fetch(`${base}/api/admin/unlink-cedula`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
    body: JSON.stringify({ accountId: account1!.id, tenantId: tenant.id, reason: 'test' }),
  });
  assert(cashierUnlink.status === 401 || cashierUnlink.status === 403, `Cashier unlink blocked: ${cashierUnlink.status}`);

  // ──────────────────────────────────
  // 9. FRONTEND: customers page has all elements
  // ──────────────────────────────────
  console.log('\n9. Frontend elements');
  const custSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/customers/page.tsx', 'utf-8');
  assert(custSrc.includes('lookupCustomer') || custSrc.includes('handleSearch'), 'Phone search field');
  assert(custSrc.includes('Verificada') && custSrc.includes('Shadow'), 'Shows account status');
  assert(custSrc.includes('Verificar identidad'), '"Verify Identity" button for shadow');
  assert(custSrc.includes('Cedula') || custSrc.includes('cedula'), 'Cedula input field');
  assert(custSrc.includes('Vincular cedula'), '"Link cedula" button');
  assert(custSrc.includes('customer.invoices'), 'Shows invoice submission history');
  assert(custSrc.includes('invoiceNumber'), 'Invoice number in history');
  assert(custSrc.includes('customer.account.level'), 'Shows consumer level');
  assert(custSrc.includes('Advertencia') || custSrc.includes('ya esta vinculada'), 'Warns on duplicate cedula');

  // ──────────────────────────────────
  // 10. PHONE + CEDULA unique constraints
  // ──────────────────────────────────
  console.log('\n10. DB constraints');
  const phoneUnique = await prisma.$queryRaw<any[]>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'accounts' AND indexdef LIKE '%phone_number%' AND indexdef LIKE '%UNIQUE%'
  `;
  assert(phoneUnique.length === 1, '(tenant_id, phone_number) UNIQUE constraint');

  const cedulaUnique = await prisma.$queryRaw<any[]>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'accounts' AND indexdef LIKE '%cedula%' AND indexdef LIKE '%UNIQUE%'
  `;
  assert(cedulaUnique.length === 1, '(tenant_id, cedula) UNIQUE constraint');

  await app.close();
  console.log(`\n=== STEP 2.7: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
