import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { getAccountBalance, getAccountHistory } from '../services/ledger.js';
import { issueStaffTokens, issueConsumerTokens } from '../services/auth.js';
import merchantRoutes from '../api/routes/merchant.js';
import consumerRoutes from '../api/routes/consumer.js';
import bcrypt from 'bcryptjs';
import fs from 'fs';

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

async function post(base: string, path: string, body: any, token: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as any };
}
async function get(base: string, path: string, token: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, data: await res.json() as any };
}

async function test() {
  console.log('=== STEP 2.7: SHADOW TO VERIFIED UPGRADE — FULL E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Upgrade Store', 'upgrade-store', 'us@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@us.com', passwordHash: await bcrypt.hash('pass', 10), role: 'owner' },
  });
  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'c@us.com', passwordHash: await bcrypt.hash('pass', 10), role: 'cashier' },
  });

  // Create consumer with some history
  await processCSV(`invoice_number,total\nUP-001,200.00`, tenant.id, owner.id);
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'UP-001', total_amount: 200, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  // Create a second consumer for duplicate cedula test
  await findOrCreateConsumerAccount(tenant.id, '+584125550002');

  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

  // Start server
  const app = Fastify();
  await app.register(cors);
  await app.register(merchantRoutes);
  await app.register(consumerRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const cashierToken = issueStaffTokens({ staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff' }).accessToken;
  const consumerToken = issueConsumerTokens({ accountId: account!.id, tenantId: tenant.id, phoneNumber: '+584125550001', type: 'consumer' }).accessToken;

  // ──────────────────────────────────
  // 1. Cashier looks up consumer by phone number
  // ──────────────────────────────────
  console.log('1. Customer lookup by phone number');
  const lookupRes = await get(base, `/api/merchant/customer-lookup/${encodeURIComponent('+584125550001')}`, cashierToken);
  assert(lookupRes.status === 200, `Lookup: 200 (got ${lookupRes.status})`);
  assert(lookupRes.data.account.phoneNumber === '+584125550001', `Phone: ${lookupRes.data.account.phoneNumber}`);
  assert(lookupRes.data.account.accountType === 'shadow', `Type: shadow`);
  assert(lookupRes.data.account.cedula === null, `Cedula: null (not linked yet)`);
  assert(Number(lookupRes.data.balance) === 200, `Balance: ${lookupRes.data.balance}`);
  assert(lookupRes.data.history.length >= 1, `History: ${lookupRes.data.history.length} entries`);

  // Not found
  const notFound = await get(base, `/api/merchant/customer-lookup/${encodeURIComponent('+584129999999')}`, cashierToken);
  assert(notFound.status === 404, `Not found: 404 (got ${notFound.status})`);

  // Audit log for lookup
  const lookupAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenant.id}::uuid AND action_type = 'CUSTOMER_LOOKUP'
  `;
  assert(lookupAudit.length >= 1, `CUSTOMER_LOOKUP audit entry (${lookupAudit.length})`);

  // ──────────────────────────────────
  // 2. Upgrade shadow → verified with cédula
  // ──────────────────────────────────
  console.log('\n2. Upgrade shadow → verified');
  const upgradeRes = await post(base, '/api/merchant/identity-upgrade', {
    phoneNumber: '+584125550001', cedula: 'V-12345678',
  }, cashierToken);
  assert(upgradeRes.status === 200, `Upgrade: 200 (got ${upgradeRes.status})`);
  assert(upgradeRes.data.success === true, 'Success');
  assert(upgradeRes.data.account.accountType === 'verified', `Type: verified`);
  assert(upgradeRes.data.account.cedula === 'V-12345678', `Cedula: ${upgradeRes.data.account.cedula}`);

  // Verify in DB
  const dbAccount = await prisma.account.findUnique({ where: { id: account!.id } });
  assert(dbAccount!.accountType === 'verified', 'DB: account_type = verified');
  assert(dbAccount!.cedula === 'V-12345678', 'DB: cedula stored');

  // Audit log
  const upgradeAudit = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenant.id}::uuid AND action_type = 'IDENTITY_UPGRADE'
  `;
  assert(upgradeAudit.length === 1, `IDENTITY_UPGRADE audit entry`);

  // ──────────────────────────────────
  // 3. Historical ledger entries remain intact
  // ──────────────────────────────────
  console.log('\n3. Ledger history preserved after upgrade');
  const history = await getAccountHistory(account!.id, tenant.id);
  assert(history.length >= 1, `History still has entries (${history.length})`);
  assert(history[0].eventType === 'INVOICE_CLAIMED', `First event: ${history[0].eventType}`);

  const balance = await getAccountBalance(account!.id, asset.id, tenant.id);
  assert(Number(balance) === 200, `Balance unchanged: ${balance}`);

  // ──────────────────────────────────
  // 4. Phone remains primary, cédula is secondary
  // ──────────────────────────────────
  console.log('\n4. Phone = primary, cédula = secondary');
  const lookupAfter = await get(base, `/api/merchant/customer-lookup/${encodeURIComponent('+584125550001')}`, cashierToken);
  assert(lookupAfter.data.account.phoneNumber === '+584125550001', 'Still lookupable by phone');
  assert(lookupAfter.data.account.cedula === 'V-12345678', 'Cedula shown as secondary');

  // ──────────────────────────────────
  // 5. Already verified → cannot upgrade again
  // ──────────────────────────────────
  console.log('\n5. Already verified → rejected');
  const dupUpgrade = await post(base, '/api/merchant/identity-upgrade', {
    phoneNumber: '+584125550001', cedula: 'V-99999999',
  }, cashierToken);
  assert(dupUpgrade.status === 400, `Already verified: 400 (got ${dupUpgrade.status})`);
  assert(dupUpgrade.data.error.includes('already verified'), `Message: ${dupUpgrade.data.error}`);

  // ──────────────────────────────────
  // 6. Duplicate cédula → conflict warning
  // ──────────────────────────────────
  console.log('\n6. Duplicate cédula → 409 conflict');
  const dupCedula = await post(base, '/api/merchant/identity-upgrade', {
    phoneNumber: '+584125550002', cedula: 'V-12345678',
  }, cashierToken);
  assert(dupCedula.status === 409, `Duplicate cedula: 409 (got ${dupCedula.status})`);
  assert(dupCedula.data.requiresConfirmation === true, 'Requires confirmation');
  assert(dupCedula.data.existingPhone === '+584125550001', `Existing phone: ${dupCedula.data.existingPhone}`);

  // ──────────────────────────────────
  // 7. Consumer sees "verified" in PWA
  // ──────────────────────────────────
  console.log('\n7. Consumer sees verified status in PWA');
  const accRes = await get(base, '/api/consumer/account', consumerToken);
  assert(accRes.data.accountType === 'verified', `PWA shows: ${accRes.data.accountType}`);
  assert(accRes.data.cedula === 'V-12345678', `PWA shows cedula: ${accRes.data.cedula}`);

  // Frontend displays account type
  const pageSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx', 'utf-8');
  assert(pageSrc.includes("accountType === 'verified'"), 'Frontend checks verified status');
  assert(pageSrc.includes('Cuenta verificada'), 'Frontend shows "Cuenta verificada"');

  // ──────────────────────────────────
  // 8. Cashier interface: lookup + verify button
  // ──────────────────────────────────
  console.log('\n8. Cashier interface');
  const custSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/customers/page.tsx', 'utf-8');
  assert(custSrc.includes('Buscar cliente'), 'Page: "Buscar cliente"');
  assert(custSrc.includes('handleSearch'), 'Search by phone function');
  assert(custSrc.includes('Verificar identidad'), '"Verificar identidad" button');
  assert(custSrc.includes('cedula') || custSrc.includes('Cedula'), 'Cedula input field');
  assert(custSrc.includes('Vincular cedula'), '"Vincular cedula" submit button');
  assert(custSrc.includes('Shadow') || custSrc.includes('shadow'), 'Shows shadow status');
  assert(custSrc.includes('Verificada') || custSrc.includes('verificada'), 'Shows verified status');
  assert(custSrc.includes('history') || custSrc.includes('historial'), 'Shows invoice history');

  // ──────────────────────────────────
  // 9. DB constraints
  // ──────────────────────────────────
  console.log('\n9. DB constraints');
  const indexes = await prisma.$queryRaw<any[]>`
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'accounts'
    AND (indexdef LIKE '%cedula%' OR indexdef LIKE '%phone_number%')
  `;
  assert(indexes.some((i: any) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('phone_number')),
    '(tenant_id, phone_number) UNIQUE');
  assert(indexes.some((i: any) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('cedula')),
    '(tenant_id, cedula) UNIQUE');

  await app.close();
  console.log(`\n=== STEP 2.7: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
