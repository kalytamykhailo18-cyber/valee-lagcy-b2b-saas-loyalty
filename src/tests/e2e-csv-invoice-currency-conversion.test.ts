import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import bcrypt from 'bcryptjs';
import { createTenant } from '../services/tenants.js';
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
  await prisma.exchangeRate.deleteMany().catch(() => {});
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_truncate`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_update`;
}

async function test() {
  console.log('=== E2E: CSV invoice list returns Bs + ref-currency equivalent ===\n');
  await cleanAll();

  const tenant = await createTenant('Kozmo', 'kozmo-csv', 'k@k.com');
  // Configure USD reference + bcv source so the conversion runs.
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { preferredExchangeSource: 'bcv', referenceCurrency: 'usd' },
  });

  // Seed an exchange rate: 50 Bs = 1 USD on 2026-04-20.
  await prisma.exchangeRate.create({
    data: {
      source: 'bcv',
      currency: 'usd',
      rateBs: 50,
      fetchedAt: new Date('2026-04-20T12:00:00Z'),
      reportedAt: new Date('2026-04-20T00:00:00Z'),
    },
  });

  const owner = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@k.com', passwordHash: await bcrypt.hash('x', 10), role: 'owner' },
  });

  // Insert two invoices: one with transactionDate that has a rate, one without.
  await prisma.invoice.create({
    data: {
      tenantId: tenant.id, invoiceNumber: 'CSV-001', amount: '1000', // Bs 1000 → $20
      transactionDate: new Date('2026-04-20T10:00:00Z'),
      status: 'available', source: 'csv_upload',
    },
  });
  await prisma.invoice.create({
    data: {
      tenantId: tenant.id, invoiceNumber: 'CSV-002', amount: '500',
      transactionDate: new Date('2026-04-20T10:00:00Z'),
      status: 'available', source: 'csv_upload',
    },
  });

  const app = Fastify();
  await app.register(cors); await app.register(cookie);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const ownerToken = issueStaffTokens({ staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;

  const res = await fetch(`http://127.0.0.1:${port}/api/merchant/invoices`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const body: any = await res.json();
  assert(res.status === 200, `GET /invoices → 200 (got ${res.status})`);
  assert(body.invoices.length === 2, `2 invoices returned (got ${body.invoices.length})`);

  const byNum: Record<string, any> = {};
  for (const inv of body.invoices) byNum[inv.invoiceNumber] = inv;

  assert(byNum['CSV-001'].currencySymbol === '$', `Currency symbol = $ for USD ref (got ${byNum['CSV-001'].currencySymbol})`);
  assert(byNum['CSV-001'].amountInReference === '20.00', `Bs 1000 ÷ 50 = $20.00 (got ${byNum['CSV-001'].amountInReference})`);
  assert(byNum['CSV-002'].amountInReference === '10.00', `Bs 500 ÷ 50 = $10.00 (got ${byNum['CSV-002'].amountInReference})`);
  assert(byNum['CSV-001'].amount === '1000', 'Raw Bs amount preserved');

  // Switch the tenant to EUR and verify the symbol flips. Without a EUR rate
  // seeded, amountInReference is null but currencySymbol still reflects EUR.
  await prisma.tenant.update({ where: { id: tenant.id }, data: { referenceCurrency: 'eur' } });
  const res2 = await fetch(`http://127.0.0.1:${port}/api/merchant/invoices`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const body2: any = await res2.json();
  assert(body2.invoices[0].currencySymbol === '€', `EUR symbol applied (got ${body2.invoices[0].currencySymbol})`);

  // Switch to BS reference (no conversion needed) → amountInReference null,
  // symbol = "Bs" so the frontend hides the duplicate line.
  await prisma.tenant.update({ where: { id: tenant.id }, data: { referenceCurrency: 'bs' } });
  const res3 = await fetch(`http://127.0.0.1:${port}/api/merchant/invoices`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const body3: any = await res3.json();
  assert(body3.invoices[0].currencySymbol === 'Bs', `BS reference returns symbol=Bs (got ${body3.invoices[0].currencySymbol})`);
  assert(body3.invoices[0].amountInReference === null, `BS reference returns amountInReference=null (got ${body3.invoices[0].amountInReference})`);

  await app.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
