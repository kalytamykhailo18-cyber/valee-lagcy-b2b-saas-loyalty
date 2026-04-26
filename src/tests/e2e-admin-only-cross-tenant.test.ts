import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { withTenantContext, withAdminContext } from '../db/tenant-context.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { writeDoubleEntry } from '../services/ledger.js';

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
  console.log('=== ADMIN-ONLY CROSS-TENANT VISIBILITY ===\n');
  await cleanAll();

  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const tenantA = await createTenant('Market A', 'market-a', 'a@m.com');
  const tenantB = await createTenant('Market B', 'market-b', 'b@m.com');
  const tenantC = await createTenant('Market C', 'market-c', 'c@m.com');
  const sysA = await createSystemAccounts(tenantA.id);
  const sysB = await createSystemAccounts(tenantB.id);
  const sysC = await createSystemAccounts(tenantC.id);

  // Populate data across all three tenants
  const { account: consA } = await findOrCreateConsumerAccount(tenantA.id, '+58412XA001');
  const { account: consB } = await findOrCreateConsumerAccount(tenantB.id, '+58412XB001');
  const { account: consC } = await findOrCreateConsumerAccount(tenantC.id, '+58412XC001');

  await writeDoubleEntry({ tenantId: tenantA.id, eventType: 'INVOICE_CLAIMED', debitAccountId: sysA.pool.id, creditAccountId: consA.id, amount: '100.00000000', assetTypeId: asset.id, referenceId: 'XA-001', referenceType: 'invoice' });
  await writeDoubleEntry({ tenantId: tenantB.id, eventType: 'INVOICE_CLAIMED', debitAccountId: sysB.pool.id, creditAccountId: consB.id, amount: '200.00000000', assetTypeId: asset.id, referenceId: 'XB-001', referenceType: 'invoice' });
  await writeDoubleEntry({ tenantId: tenantC.id, eventType: 'INVOICE_CLAIMED', debitAccountId: sysC.pool.id, creditAccountId: consC.id, amount: '300.00000000', assetTypeId: asset.id, referenceId: 'XC-001', referenceType: 'invoice' });

  // ──────────────────────────────────
  // 1. ADMIN (withAdminContext): sees ALL 3 tenants
  // ──────────────────────────────────
  console.log('1. ADMIN CONTEXT: full cross-tenant visibility');
  await withAdminContext(async (db) => {
    const tenants = await db.tenant.findMany();
    const ledger = await db.ledgerEntry.findMany();
    const accounts = await db.account.findMany({ where: { accountType: { not: 'system' } } });

    assert(tenants.length === 3, `Sees 3 tenants (got ${tenants.length})`);
    assert(ledger.length === 6, `Sees 6 ledger entries (got ${ledger.length})`);
    assert(accounts.length === 3, `Sees 3 consumer accounts (got ${accounts.length})`);

    const tenantIds = new Set(ledger.map(e => e.tenantId));
    assert(tenantIds.size === 3, `Ledger spans 3 tenants (got ${tenantIds.size})`);
  });

  // ──────────────────────────────────
  // 2. TENANT A: sees ONLY its own data
  // ──────────────────────────────────
  console.log('\n2. TENANT A CONTEXT: cannot see B or C');
  await withTenantContext(tenantA.id, async (db) => {
    const tenants = await db.tenant.findMany();
    const ledger = await db.ledgerEntry.findMany();
    const accounts = await db.account.findMany({ where: { accountType: { not: 'system' } } });

    assert(tenants.length === 1 && tenants[0].name === 'Market A', `Sees only Market A`);
    assert(ledger.length === 2, `Sees 2 ledger entries (got ${ledger.length})`);
    assert(ledger.every(e => e.tenantId === tenantA.id), `All entries belong to Tenant A`);
    assert(accounts.length === 1 && accounts[0].phoneNumber === '+58412XA001', `Sees only its consumer`);
    return null;
  });

  // ──────────────────────────────────
  // 3. TENANT B: sees ONLY its own data
  // ──────────────────────────────────
  console.log('\n3. TENANT B CONTEXT: cannot see A or C');
  await withTenantContext(tenantB.id, async (db) => {
    const tenants = await db.tenant.findMany();
    const ledger = await db.ledgerEntry.findMany();

    assert(tenants.length === 1 && tenants[0].name === 'Market B', `Sees only Market B`);
    assert(ledger.length === 2, `Sees 2 ledger entries (got ${ledger.length})`);
    assert(ledger.every(e => e.tenantId === tenantB.id), `All entries belong to Tenant B`);
    return null;
  });

  // ──────────────────────────────────
  // 4. TENANT C: sees ONLY its own data
  // ──────────────────────────────────
  console.log('\n4. TENANT C CONTEXT: cannot see A or B');
  await withTenantContext(tenantC.id, async (db) => {
    const tenants = await db.tenant.findMany();
    const ledger = await db.ledgerEntry.findMany();

    assert(tenants.length === 1 && tenants[0].name === 'Market C', `Sees only Market C`);
    assert(ledger.length === 2, `Sees 2 ledger entries (got ${ledger.length})`);
    assert(ledger.every(e => e.tenantId === tenantC.id), `All entries belong to Tenant C`);
    return null;
  });

  // ──────────────────────────────────
  // 5. NO CONTEXT: sees NOTHING (not even with a query for all)
  // ──────────────────────────────────
  console.log('\n5. NO TENANT CONTEXT: structurally sees nothing');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE loyalty_tenant');
    const tenants = await tx.tenant.findMany();
    const ledger = await tx.ledgerEntry.findMany();
    assert(tenants.length === 0, `Sees 0 tenants (got ${tenants.length})`);
    assert(ledger.length === 0, `Sees 0 ledger entries (got ${ledger.length})`);
  });

  console.log(`\n=== ADMIN-ONLY CROSS-TENANT: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
