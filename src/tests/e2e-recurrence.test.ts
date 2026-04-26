import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { getAccountBalance } from '../services/ledger.js';
import { runRecurrenceEngine } from '../services/recurrence.js';

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
  await prisma.recurrenceNotification.deleteMany();
  await prisma.recurrenceRule.deleteMany();
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
  console.log('=== RECURRENCE ENGINE: FULL E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('Recurrence Store', 'recurrence-store', 'rc@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@rc.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // Create 3 consumers with different visit patterns
  await processCSV(`invoice_number,total\nRC-001,100.00\nRC-002,100.00\nRC-003,100.00`, tenant.id, staff.id);

  // Consumer A: visited 20 days ago (should be notified for 14-day rule)
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'RC-001', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  // Consumer B: visited 5 days ago (should NOT be notified)
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550002', assetTypeId: asset.id,
    extractedData: { invoice_number: 'RC-002', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  // Consumer C: visited 16 days ago (should be notified)
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550003', assetTypeId: asset.id,
    extractedData: { invoice_number: 'RC-003', total_amount: 100, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });

  // Backdate Consumer A's ledger entries to 20 days ago
  const accA = await prisma.account.findUnique({ where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } } });
  const accC = await prisma.account.findUnique({ where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550003' } } });

  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_update`;
  await prisma.$executeRaw`UPDATE ledger_entries SET created_at = NOW() - INTERVAL '20 days' WHERE account_id = ${accA!.id}::uuid`;
  await prisma.$executeRaw`UPDATE ledger_entries SET created_at = NOW() - INTERVAL '16 days' WHERE account_id = ${accC!.id}::uuid`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_update`;

  // ──────────────────────────────────
  // 1. Create recurrence rule
  // ──────────────────────────────────
  console.log('1. Create recurrence rule (14 days, 50 pts bonus)');
  const rule = await prisma.recurrenceRule.create({
    data: {
      tenantId: tenant.id,
      name: 'Bi-weekly re-engagement',
      intervalDays: 14,
      graceDays: 1,
      messageTemplate: 'Hola {name}! Hace {days} dias que no te vemos. Te regalamos {bonus} puntos!',
      bonusAmount: '50.00000000',
      active: true,
    },
  });
  assert(!!rule.id, `Rule created: ${rule.name}`);

  // ──────────────────────────────────
  // 2. Run recurrence engine
  // ──────────────────────────────────
  console.log('\n2. Run recurrence engine');
  const result = await runRecurrenceEngine();
  assert(result.notified === 2, `2 consumers notified (A=20d, C=16d) (got ${result.notified})`);
  assert(result.bonusesGranted === 2, `2 bonuses granted (got ${result.bonusesGranted})`);
  assert(result.skipped === 0, `0 skipped (got ${result.skipped})`);

  // Consumer A got bonus
  const balA = await getAccountBalance(accA!.id, asset.id, tenant.id);
  assert(Number(balA) === 150, `Consumer A balance: 100 + 50 bonus = 150 (got ${balA})`);

  // Consumer C got bonus
  const balC = await getAccountBalance(accC!.id, asset.id, tenant.id);
  assert(Number(balC) === 150, `Consumer C balance: 100 + 50 bonus = 150 (got ${balC})`);

  // Consumer B NOT notified (5 days < 15 threshold)
  const accB = await prisma.account.findUnique({ where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550002' } } });
  const balB = await getAccountBalance(accB!.id, asset.id, tenant.id);
  assert(Number(balB) === 100, `Consumer B balance unchanged: 100 (got ${balB})`);

  // ──────────────────────────────────
  // 3. Notifications recorded
  // ──────────────────────────────────
  console.log('\n3. Notifications recorded');
  const notifications = await prisma.recurrenceNotification.findMany({ where: { tenantId: tenant.id } });
  assert(notifications.length === 2, `2 notifications recorded (got ${notifications.length})`);
  assert(notifications.every(n => n.bonusGranted === true), 'Both have bonusGranted=true');
  assert(notifications.every(n => n.ledgerEntryId !== null), 'Both linked to ledger entry');
  assert(notifications.some(n => n.daysSinceVisit === 20), 'Consumer A: 20 days');
  assert(notifications.some(n => n.daysSinceVisit === 16), 'Consumer C: 16 days');

  // ──────────────────────────────────
  // 4. Idempotent — running again sends nothing
  // ──────────────────────────────────
  console.log('\n4. Idempotent — second run sends nothing');
  const result2 = await runRecurrenceEngine();
  assert(result2.notified === 0, `0 new notifications (got ${result2.notified})`);
  assert(result2.skipped === 2, `2 skipped (already sent) (got ${result2.skipped})`);

  const notifications2 = await prisma.recurrenceNotification.findMany({ where: { tenantId: tenant.id } });
  assert(notifications2.length === 2, `Still 2 notifications (got ${notifications2.length})`);

  // ──────────────────────────────────
  // 5. Double-entry on bonus
  // ──────────────────────────────────
  console.log('\n5. Bonus is double-entry');
  const bonusEntries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL', metadata: { path: ['type'], equals: 'recurrence_bonus' } },
  });
  assert(bonusEntries.length === 4, `4 bonus entries (2 consumers × 2 double-entry) (got ${bonusEntries.length})`);

  // ──────────────────────────────────
  // 6. DB schema
  // ──────────────────────────────────
  console.log('\n6. DB schema');
  const tables = await prisma.$queryRaw<any[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('recurrence_rules', 'recurrence_notifications', 'invoices')
    ORDER BY table_name
  `;
  assert(tables.length === 3, `3 tables exist (got ${tables.length})`);

  const orderCol = await prisma.$queryRaw<any[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'order_details'
  `;
  assert(orderCol.length === 1, 'invoices.order_details column exists');

  console.log(`\n=== RECURRENCE ENGINE: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
