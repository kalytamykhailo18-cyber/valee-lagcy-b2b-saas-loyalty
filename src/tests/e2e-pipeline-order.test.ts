import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { getAccountBalance } from '../services/ledger.js';

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
  console.log('=== VALIDATION PIPELINE: STAGE ORDER VERIFICATION ===\n');
  await cleanAll();

  const tenant = await createTenant('Pipeline Store', 'pipeline-store', 'p@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@p.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total,phone\nPIPE-001,100.00,+584125550001`, tenant.id, staff.id);
  // Add branch for geofence
  await prisma.branch.create({ data: { tenantId: tenant.id, name: 'Main', latitude: 10.15, longitude: -67.99, active: true } });

  // ──────────────────────────────────
  // Stage A fails first (low confidence) — no further stages run
  // ──────────────────────────────────
  console.log('Stage A fails → stops at extraction');
  const rA = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'PIPE-001', total_amount: 100, transaction_date: null,
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.1 },
  });
  assert(rA.stage === 'extraction', `Stopped at Stage A (got: ${rA.stage})`);

  // No account created (Stage D never reached)
  const accA = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });
  assert(accA === null, 'No account created when Stage A fails');

  // No ledger entries
  const entriesA = await prisma.ledgerEntry.count({ where: { tenantId: tenant.id } });
  assert(entriesA === 0, 'No ledger entries when Stage A fails');

  // ──────────────────────────────────
  // Stage B fails (phone mismatch) — A passed, C/D/E not reached
  // ──────────────────────────────────
  console.log('\nStage B fails → stops at identity_check');
  const rB = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125559999', assetTypeId: asset.id,
    extractedData: { invoice_number: 'PIPE-001', total_amount: 100, transaction_date: null,
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(rB.stage === 'identity_check', `Stopped at Stage B (got: ${rB.stage})`);

  const entriesB = await prisma.ledgerEntry.count({ where: { tenantId: tenant.id } });
  assert(entriesB === 0, 'No ledger entries when Stage B fails');

  // ──────────────────────────────────
  // Stage C fails (not found) — A+B passed, D/E not reached
  // ──────────────────────────────────
  console.log('\nStage C fails → stops at cross_reference');
  const rC = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'NONEXISTENT', total_amount: 100, transaction_date: null,
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(rC.stage === 'cross_reference', `Stopped at Stage C (got: ${rC.stage})`);

  const entriesC = await prisma.ledgerEntry.count({ where: { tenantId: tenant.id } });
  assert(entriesC === 0, 'No ledger entries when Stage C fails');

  // ──────────────────────────────────
  // Geofence fails → stops at geofence (between C and D)
  // ──────────────────────────────────
  console.log('\nGeofence fails → stops at geofence');
  const rG = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    latitude: '4.5981', longitude: '-74.0758', // Bogota, 800km away
    extractedData: { invoice_number: 'PIPE-001', total_amount: 100,
      transaction_date: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(rG.stage === 'geofence', `Stopped at geofence (got: ${rG.stage})`);
  assert(rG.status === 'manual_review', 'Flagged for manual review');

  // Reset invoice for final test
  await prisma.invoice.updateMany({ where: { tenantId: tenant.id, invoiceNumber: 'PIPE-001' }, data: { status: 'available' } });

  // ──────────────────────────────────
  // All stages pass → full success (A → B → C → Geo → D → E)
  // ──────────────────────────────────
  console.log('\nAll stages pass → full pipeline success');
  const rOK = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    latitude: '10.16', longitude: '-68.00', // Near merchant
    extractedData: { invoice_number: 'PIPE-001', total_amount: 100,
      transaction_date: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      customer_phone: '+584125550001', merchant_name: null, confidence_score: 0.95 },
  });
  assert(rOK.success === true, 'Pipeline succeeded');
  assert(rOK.stage === 'complete', 'Reached stage: complete');
  assert(rOK.valueAssigned === '100.00000000', `Value assigned: ${rOK.valueAssigned}`);
  assert(rOK.newBalance === '100.00000000', `Balance: ${rOK.newBalance}`);

  // Verify all stages ran: account created (D), invoice claimed (D), entries exist (D), balance computed (E)
  const inv = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'PIPE-001' } });
  assert(inv!.status === 'claimed', 'Invoice claimed (Stage D ran)');

  const entries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id } });
  assert(entries.length === 2, '2 ledger entries (Stage D double-entry)');

  const acc = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });
  assert(acc !== null, 'Account created (Stage D)');

  const bal = await getAccountBalance(acc!.id, asset.id, tenant.id);
  assert(Number(bal) === 100, `Balance computed from history: 100 (Stage E)`);

  // ──────────────────────────────────
  // Pipeline order: A → B → C → Geofence → D → E
  // ──────────────────────────────────
  console.log('\nPipeline order verified:');
  console.log('  A (extraction) → B (identity) → C (cross-ref) → Geofence → D (value assignment) → E (notification)');

  console.log(`\n=== PIPELINE ORDER: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
