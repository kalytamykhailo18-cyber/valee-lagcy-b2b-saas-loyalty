import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import prisma from '../db/client.js';
import merchantRoutes from '../api/routes/merchant.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { issueStaffTokens } from '../services/auth.js';
import bcrypt from 'bcryptjs';

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
  console.log('=== CSV UPLOAD: GAP TESTS ===\n');
  await cleanAll();

  // Setup
  const tenant = await createTenant('Gap Store', 'gap-store', 'g@t.com');
  await createSystemAccounts(tenant.id);
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@g.com', passwordHash: await bcrypt.hash('pass', 10), role: 'owner' },
  });
  const cashier = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Cashier', email: 'c@g.com', passwordHash: await bcrypt.hash('pass', 10), role: 'cashier' },
  });

  // Start a test Fastify server
  const app = Fastify();
  await app.register(cors);
  await app.register(cookie);
  await app.register(merchantRoutes);
  await app.listen({ port: 0 }); // random port
  const address = app.server.address();
  const port = typeof address === 'object' ? address!.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const ownerToken = issueStaffTokens({ staffId: staff.id, tenantId: tenant.id, role: 'owner', type: 'staff' }).accessToken;
  const cashierToken = issueStaffTokens({ staffId: cashier.id, tenantId: tenant.id, role: 'cashier', type: 'staff' }).accessToken;

  // ──────────────────────────────────
  // 1. Upload via HTTP API (not just service function)
  // ──────────────────────────────────
  console.log('1. Upload via HTTP API');
  const uploadRes = await fetch(`${base}/api/merchant/csv-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ csvContent: 'invoice_number,total\nGAP-001,100.00\nGAP-002,200.00' }),
  });
  const uploadData = await uploadRes.json();
  assert(uploadRes.ok, `HTTP 200 (got ${uploadRes.status})`);
  assert(uploadData.rowsLoaded === 2, `2 rows loaded via API (got ${uploadData.rowsLoaded})`);
  assert(!!uploadData.batchId, `batchId returned: ${uploadData.batchId?.slice(0,8)}...`);

  // ──────────────────────────────────
  // 2. Batch status endpoint works
  // ──────────────────────────────────
  console.log('\n2. Batch status endpoint');
  const statusRes = await fetch(`${base}/api/merchant/csv-upload/${uploadData.batchId}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const statusData = await statusRes.json();
  assert(statusRes.ok, `HTTP 200 (got ${statusRes.status})`);
  assert(statusData.status === 'completed', `Batch status: completed (got ${statusData.status})`);
  assert(statusData.rowsLoaded === 2, `rowsLoaded: 2 (got ${statusData.rowsLoaded})`);
  assert(statusData.rowsSkipped === 0, `rowsSkipped: 0 (got ${statusData.rowsSkipped})`);
  assert(statusData.rowsErrored === 0, `rowsErrored: 0 (got ${statusData.rowsErrored})`);
  assert(!!statusData.completedAt, `completedAt set`);

  // ──────────────────────────────────
  // 3. Audit log entry created for CSV_UPLOAD
  // ──────────────────────────────────
  console.log('\n3. Audit log entry for CSV_UPLOAD');
  const auditEntries = await prisma.$queryRaw<any[]>`
    SELECT * FROM audit_log WHERE tenant_id = ${tenant.id}::uuid AND action_type = 'CSV_UPLOAD'
  `;
  assert(auditEntries.length === 1, `1 CSV_UPLOAD audit entry (got ${auditEntries.length})`);
  assert(auditEntries[0].actor_id === staff.id, `Actor is the owner`);
  assert(auditEntries[0].outcome === 'success', `Outcome: success`);

  // ──────────────────────────────────
  // 4. Cashier CANNOT upload (403)
  // ──────────────────────────────────
  console.log('\n4. Cashier cannot upload CSV (role enforcement)');
  const cashierUpload = await fetch(`${base}/api/merchant/csv-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
    body: JSON.stringify({ csvContent: 'invoice_number,total\nHACK-001,999.00' }),
  });
  assert(cashierUpload.status === 403, `Cashier gets 403 (got ${cashierUpload.status})`);

  // Verify no data was created from cashier attempt
  const hackInvoice = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'HACK-001' } });
  assert(hackInvoice === null, `No invoice created from cashier attempt`);

  // ──────────────────────────────────
  // 5. Unauthenticated request rejected
  // ──────────────────────────────────
  console.log('\n5. Unauthenticated request rejected');
  const noAuth = await fetch(`${base}/api/merchant/csv-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csvContent: 'invoice_number,total\nX-001,100.00' }),
  });
  assert(noAuth.status === 401, `No auth gets 401 (got ${noAuth.status})`);

  await app.close();
  console.log(`\n=== CSV GAPS: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
