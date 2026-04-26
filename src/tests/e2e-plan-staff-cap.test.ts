import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { getUsage, getLimit, checkLimit } from '../services/plan-limits.js';

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
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_truncate`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_delete`;
  await prisma.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_no_update`;
}

async function test() {
  console.log('=== E2E: basic plan staff cap = 10, owner excluded ===\n');
  await cleanAll();

  const tenant = await createTenant('Kozmo', 'kozmo-cap', 'k@k.com');
  // Default tenant.plan = 'basic'

  // 1. Limit is now 10 (was 3).
  const limit = await getLimit(tenant.id, 'staff_members');
  assert(limit === 10, `Basic plan staff_members limit = 10 (got ${limit})`);

  // 2. With just an owner present, usage is 0 (owner doesn't count).
  await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@k.com', passwordHash: '$2b$10$x', role: 'owner', active: true },
  });
  const usage1 = await getUsage(tenant.id, 'staff_members');
  assert(usage1 === 0, `Usage = 0 with only owner present (got ${usage1}) — Eric 2026-04-25 owner-not-counted rule`);

  // 3. Add 5 cashiers — usage should be 5 (still ignoring owner).
  for (let i = 1; i <= 5; i++) {
    await prisma.staff.create({
      data: { tenantId: tenant.id, name: `Cajero ${i}`, email: `c${i}@k.com`, passwordHash: '$2b$10$x', role: 'cashier', active: true },
    });
  }
  const usage2 = await getUsage(tenant.id, 'staff_members');
  assert(usage2 === 5, `Usage = 5 cashiers (got ${usage2})`);

  // 4. checkLimit at 5/10 → still allowed.
  const check5 = await checkLimit(tenant.id, 'staff_members');
  assert(check5.allowed === true, `checkLimit allowed at 5/10 (got ${check5.allowed})`);
  assert(check5.current === 5 && check5.limit === 10, `current=5 limit=10 (got ${check5.current}/${check5.limit})`);

  // 5. Add 5 more cashiers (total 10) → at the cap.
  for (let i = 6; i <= 10; i++) {
    await prisma.staff.create({
      data: { tenantId: tenant.id, name: `Cajero ${i}`, email: `c${i}@k.com`, passwordHash: '$2b$10$x', role: 'cashier', active: true },
    });
  }
  const check10 = await checkLimit(tenant.id, 'staff_members');
  assert(check10.allowed === false, `checkLimit BLOCKED at 10/10 (got ${check10.allowed})`);
  assert(check10.current === 10 && check10.limit === 10, `current=10 limit=10 (got ${check10.current}/${check10.limit})`);

  // 6. Inactive cashiers don't count.
  await prisma.staff.update({
    where: { id: (await prisma.staff.findFirst({ where: { tenantId: tenant.id, role: 'cashier' } }))!.id },
    data: { active: false },
  });
  const usageInactive = await getUsage(tenant.id, 'staff_members');
  assert(usageInactive === 9, `Inactive cashier excluded (got ${usageInactive})`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
