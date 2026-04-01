import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { writeDoubleEntry, getAccountBalance, getAccountBalanceAtTime, getAccountHistory } from '../services/ledger.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';

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

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function test() {
  console.log('=== EVENT SOURCING: HISTORICAL STATE RECONSTRUCTION ===\n');
  await cleanAll();

  const tenant = await createTenant('ES Store', 'es-store', 'es@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const consumer = await prisma.account.create({
    data: { tenantId: tenant.id, phoneNumber: '+58412ES001', accountType: 'shadow' },
  });

  // Record timestamps between events
  const t0 = new Date(); // Before any event
  await sleep(50);

  // Event 1: +100
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.id,
    amount: '100.00000000', assetTypeId: asset.id,
    referenceId: 'ES-001', referenceType: 'invoice',
  });
  await sleep(50);
  const t1 = new Date(); // After event 1
  await sleep(50);

  // Event 2: +250
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sys.pool.id, creditAccountId: consumer.id,
    amount: '250.00000000', assetTypeId: asset.id,
    referenceId: 'ES-002', referenceType: 'invoice',
  });
  await sleep(50);
  const t2 = new Date(); // After event 2
  await sleep(50);

  // Event 3: -75 (reversal)
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'REVERSAL',
    debitAccountId: consumer.id, creditAccountId: sys.pool.id,
    amount: '75.00000000', assetTypeId: asset.id,
    referenceId: 'ES-REV-001', referenceType: 'invoice',
    metadata: { reason: 'Test reversal' },
  });
  await sleep(50);
  const t3 = new Date(); // After event 3
  await sleep(50);

  // Event 4: +50
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: sys.pool.id, creditAccountId: consumer.id,
    amount: '50.00000000', assetTypeId: asset.id,
    referenceId: 'ES-ADJ-001', referenceType: 'manual_adjustment',
    metadata: { reason: 'Goodwill credit' },
  });
  const t4 = new Date(); // After event 4

  // ──────────────────────────────────────────────
  // Reconstruct balance at each point in time
  // ──────────────────────────────────────────────

  console.log('Timeline: +100, +250, -75, +50\n');

  const balAtT0 = await getAccountBalanceAtTime(consumer.id, asset.id, tenant.id, t0);
  console.log(`  t0 (before everything)  → balance = ${balAtT0}`);
  assert(Number(balAtT0) === 0, 'Balance at t0 = 0 (before any event)');

  const balAtT1 = await getAccountBalanceAtTime(consumer.id, asset.id, tenant.id, t1);
  console.log(`  t1 (after +100)         → balance = ${balAtT1}`);
  assert(Number(balAtT1) === 100, 'Balance at t1 = 100 (after first claim)');

  const balAtT2 = await getAccountBalanceAtTime(consumer.id, asset.id, tenant.id, t2);
  console.log(`  t2 (after +100, +250)   → balance = ${balAtT2}`);
  assert(Number(balAtT2) === 350, 'Balance at t2 = 350 (after second claim)');

  const balAtT3 = await getAccountBalanceAtTime(consumer.id, asset.id, tenant.id, t3);
  console.log(`  t3 (after +100,+250,-75)→ balance = ${balAtT3}`);
  assert(Number(balAtT3) === 275, 'Balance at t3 = 275 (after reversal)');

  const balAtT4 = await getAccountBalanceAtTime(consumer.id, asset.id, tenant.id, t4);
  console.log(`  t4 (after all events)   → balance = ${balAtT4}`);
  assert(Number(balAtT4) === 325, 'Balance at t4 = 325 (final, after adjustment)');

  // Current balance matches t4
  const balNow = await getAccountBalance(consumer.id, asset.id, tenant.id);
  console.log(`  now                     → balance = ${balNow}`);
  assert(Number(balNow) === 325, 'Current balance = 325 (matches t4)');

  // ──────────────────────────────────────────────
  // Verify complete history is preserved and ordered
  // ──────────────────────────────────────────────
  console.log('\nFull event history (consumer credits + debits):');
  const history = await getAccountHistory(consumer.id, tenant.id, 100);
  assert(history.length === 4, `4 events in history (got ${history.length})`);

  // History is ordered newest first
  for (const e of history.reverse()) {
    const sign = e.entryType === 'CREDIT' ? '+' : '-';
    console.log(`  ${e.createdAt.toISOString()}  ${sign}${Number(e.amount)}  ${e.eventType}  ref=${e.referenceId}`);
  }

  // ──────────────────────────────────────────────
  // Verify no state is stored — only events
  // ──────────────────────────────────────────────
  console.log('\nNo stored state check:');
  const accountRow = await prisma.account.findUnique({ where: { id: consumer.id } });
  const accountCols = Object.keys(accountRow!);
  const hasBalanceCol = accountCols.some(c => c.toLowerCase().includes('balance'));
  assert(!hasBalanceCol, 'accounts table has no balance column');

  console.log(`\n=== EVENT SOURCING: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
