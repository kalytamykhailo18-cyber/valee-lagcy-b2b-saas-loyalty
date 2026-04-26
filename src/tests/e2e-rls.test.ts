import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { withTenantContext } from '../db/tenant-context.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';

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
  console.log('=== ROW-LEVEL SECURITY: STRUCTURAL TENANT ISOLATION ===\n');
  await cleanAll();

  // Create two tenants with data
  const tenantA = await createTenant('Shop A', 'shop-a', 'a@shop.com');
  const tenantB = await createTenant('Shop B', 'shop-b', 'b@shop.com');
  await createSystemAccounts(tenantA.id);
  await createSystemAccounts(tenantB.id);
  await findOrCreateConsumerAccount(tenantA.id, '+58412RLS01');
  await findOrCreateConsumerAccount(tenantA.id, '+58412RLS02');
  await findOrCreateConsumerAccount(tenantB.id, '+58412RLS03');
  await prisma.staff.create({ data: { tenantId: tenantA.id, name: 'Staff A', email: 's@a.com', passwordHash: 'x', role: 'owner' } });
  await prisma.staff.create({ data: { tenantId: tenantB.id, name: 'Staff B', email: 's@b.com', passwordHash: 'x', role: 'owner' } });

  // ──────────────────────────────────
  // 1. Admin context: sees everything
  // ──────────────────────────────────
  console.log('1. ADMIN CONTEXT (loyalty_admin): sees all tenants');
  const allTenants = await prisma.tenant.findMany();
  const allAccounts = await prisma.account.findMany();
  const allStaff = await prisma.staff.findMany();
  assert(allTenants.length === 2, `Sees 2 tenants (got ${allTenants.length})`);
  assert(allAccounts.length >= 5, `Sees all accounts (got ${allAccounts.length})`); // 2 system + 2 consumer A + 1 consumer B
  assert(allStaff.length === 2, `Sees 2 staff (got ${allStaff.length})`);

  // ──────────────────────────────────
  // 2. Tenant A context: sees ONLY tenant A data
  // ──────────────────────────────────
  console.log('\n2. TENANT A CONTEXT (RLS enforced): sees only Tenant A');
  await withTenantContext(tenantA.id, async (tx) => {
    const tenants = await tx.tenant.findMany();
    assert(tenants.length === 1, `Sees 1 tenant (got ${tenants.length})`);
    assert(tenants[0].id === tenantA.id, `Sees only Shop A`);

    const accounts = await tx.account.findMany();
    assert(accounts.every(a => a.tenantId === tenantA.id), `All accounts belong to Tenant A`);
    const consumerAccounts = accounts.filter(a => a.accountType !== 'system');
    assert(consumerAccounts.length === 2, `Sees 2 consumer accounts (got ${consumerAccounts.length})`);

    const staffList = await tx.staff.findMany();
    assert(staffList.length === 1 && staffList[0].name === 'Staff A', `Sees only Staff A`);

    // Cannot see Tenant B data at all
    const tenantBdata = await tx.account.findMany({ where: { tenantId: tenantB.id } });
    assert(tenantBdata.length === 0, `Cannot see Tenant B accounts (got ${tenantBdata.length})`);

    return null;
  });

  // ──────────────────────────────────
  // 3. Tenant B context: sees ONLY tenant B data
  // ──────────────────────────────────
  console.log('\n3. TENANT B CONTEXT (RLS enforced): sees only Tenant B');
  await withTenantContext(tenantB.id, async (tx) => {
    const tenants = await tx.tenant.findMany();
    assert(tenants.length === 1, `Sees 1 tenant (got ${tenants.length})`);
    assert(tenants[0].id === tenantB.id, `Sees only Shop B`);

    const accounts = await tx.account.findMany();
    assert(accounts.every(a => a.tenantId === tenantB.id), `All accounts belong to Tenant B`);

    const staffList = await tx.staff.findMany();
    assert(staffList.length === 1 && staffList[0].name === 'Staff B', `Sees only Staff B`);

    // Cannot see Tenant A data
    const tenantAdata = await tx.account.findMany({ where: { tenantId: tenantA.id } });
    assert(tenantAdata.length === 0, `Cannot see Tenant A accounts (got ${tenantAdata.length})`);

    return null;
  });

  // ──────────────────────────────────
  // 4. No tenant context: sees NOTHING
  // ──────────────────────────────────
  console.log('\n4. NO TENANT CONTEXT (empty): sees nothing');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE loyalty_tenant');
    // No app.current_tenant_id set

    const tenants = await tx.tenant.findMany();
    assert(tenants.length === 0, `Sees 0 tenants (got ${tenants.length})`);

    const accounts = await tx.account.findMany();
    assert(accounts.length === 0, `Sees 0 accounts (got ${accounts.length})`);
  });

  console.log(`\n=== RLS ENFORCEMENT: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
