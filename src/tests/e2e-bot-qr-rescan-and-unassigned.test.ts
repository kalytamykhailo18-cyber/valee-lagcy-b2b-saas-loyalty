import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { writeDoubleEntry } from '../services/ledger.js';
import { handleIncomingMessage } from '../services/whatsapp-bot.js';
import { getMerchantMetrics } from '../services/metrics.js';

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
  console.log('=== E2E: QR rescan greeting + unassigned-bucket metric ===\n');
  await cleanAll();

  const tenant = await createTenant('Farmatodo', 'farmatodo', 'f@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  await setTenantConversionRate(tenant.id, asset.id, '1.00000000');
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { welcomeBonusAmount: 2500, welcomeBonusActive: true },
  });

  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Genesis', email: 'g@f.com', passwordHash: '$2b$10$x',
      role: 'cashier', qrSlug: '4dcb1w43', active: true,
    },
  });

  // ──────────────────────────────────────────────────
  // 1. NEW user scans the QR — message body has the
  //    canonical "Valee Ref: <slug> Cjr: <cashierSlug>"
  //    that the WhatsApp deep link prefills.
  //    Bot must respond with the welcome greeting,
  //    NOT the "No entendi" fallback. (Eric 2026-04-25)
  // ──────────────────────────────────────────────────
  console.log('1. New user QR rescan → welcome greeting');
  const reply1 = await handleIncomingMessage({
    phoneNumber: '+584125550111',
    messageType: 'text',
    messageText: 'Hola! Quiero ganar puntos en farmatodo con Eric  Valee Ref: farmatodo Cjr: 4dcb1w43',
    tenantId: tenant.id,
  });
  const reply1Text = reply1.join(' ');
  assert(!reply1Text.includes('No entendí'), `No "No entendi" leak (got: ${reply1Text.slice(0, 80)}...)`);
  assert(/bienvenida|Bienvenido/i.test(reply1Text), 'Welcome copy returned');
  assert(reply1Text.includes('2500') || reply1Text.includes('2.500'), 'Welcome bonus amount mentioned (2500)');

  // ──────────────────────────────────────────────────
  // 2. RETURNING user (has history) rescans the same QR.
  //    Same regex must match → state-based greeting,
  //    not the support-intent fallback.
  // ──────────────────────────────────────────────────
  console.log('\n2. Returning user QR rescan → returning-with-history greeting');
  // Give the user some confirmed activity so the state engine sees
  // them as 'returning_with_history' instead of 'first_time'.
  const acct = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550111' } },
  });
  if (acct) {
    await writeDoubleEntry({
      tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
      debitAccountId: sys.pool.id, creditAccountId: acct.id,
      amount: '500.00000000', assetTypeId: asset.id,
      referenceId: 'INV-RET-001', referenceType: 'invoice',
    });
  }

  const reply2 = await handleIncomingMessage({
    phoneNumber: '+584125550111',
    messageType: 'text',
    messageText: 'Hola de nuevo Valee Ref: farmatodo Cjr: 4dcb1w43',
    tenantId: tenant.id,
  });
  const reply2Text = reply2.join(' ');
  assert(!reply2Text.includes('No entendí'), `Returning rescan has NO "No entendi" leak`);
  assert(/saldo|hola/i.test(reply2Text), 'Returning user gets greeting with balance');

  // ──────────────────────────────────────────────────
  // 3. Plain non-QR text from a returning user that
  //    isn't a greeting and isn't a recognised intent
  //    SHOULD still hit the support fallback. This is
  //    the regression baseline.
  // ──────────────────────────────────────────────────
  console.log('\n3. Random text → support intent fallback (regression baseline)');
  const reply3 = await handleIncomingMessage({
    phoneNumber: '+584125550111',
    messageType: 'text',
    messageText: 'asdfqwerty123',
    tenantId: tenant.id,
  });
  const reply3Text = reply3.join(' ');
  assert(/No entendí|opciones disponibles|saldo/i.test(reply3Text), 'Random gibberish gets support fallback');

  // ──────────────────────────────────────────────────
  // 4. unassigned-bucket metric: when ALL data has a
  //    branch attribution, valueIssuedUnassigned must
  //    be 0 so the dropdown drops the third option.
  // ──────────────────────────────────────────────────
  console.log('\n4. valueIssuedUnassigned == 0 when all data is branch-attributed');
  // Fresh tenant for a clean baseline
  const tenantB = await createTenant('Kozmo', 'kozmo', 'k@k.com');
  const sysB = await createSystemAccounts(tenantB.id);
  await setTenantConversionRate(tenantB.id, asset.id, '1.00000000');
  const branchK = await prisma.branch.create({
    data: { tenantId: tenantB.id, name: 'Kozmo Cuatricentenaria', address: 'Caracas', active: true },
  });
  const consumerK = await findOrCreateConsumerAccount(tenantB.id, '+584125550222');
  // All entries get a branchId → unassigned should be 0
  await writeDoubleEntry({
    tenantId: tenantB.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sysB.pool.id, creditAccountId: consumerK.account.id,
    amount: '1000.00000000', assetTypeId: asset.id,
    referenceId: 'KOZ-INV-001', referenceType: 'invoice',
    branchId: branchK.id,
  });
  const metricsClean = await getMerchantMetrics(tenantB.id, undefined);
  assert(
    metricsClean.valueIssuedUnassigned !== undefined,
    `valueIssuedUnassigned field exists (got ${metricsClean.valueIssuedUnassigned})`,
  );
  assert(
    parseFloat(metricsClean.valueIssuedUnassigned || '0') === 0,
    `valueIssuedUnassigned == 0 after fully-attributed tenant (got ${metricsClean.valueIssuedUnassigned}) — frontend will hide the "_unassigned" option`,
  );

  // ──────────────────────────────────────────────────
  // 5. unassigned-bucket metric: a tenant with one
  //    INVOICE_CLAIMED that has NO branchId should
  //    surface > 0, so the dropdown includes the option.
  // ──────────────────────────────────────────────────
  console.log('\n5. valueIssuedUnassigned > 0 when ledger has rows without branchId');
  await writeDoubleEntry({
    tenantId: tenantB.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: sysB.pool.id, creditAccountId: consumerK.account.id,
    amount: '250.00000000', assetTypeId: asset.id,
    referenceId: 'KOZ-INV-002-NOBRANCH', referenceType: 'invoice',
    // no branchId on purpose
  });
  const metricsMixed = await getMerchantMetrics(tenantB.id, undefined);
  assert(
    parseFloat(metricsMixed.valueIssuedUnassigned || '0') > 0,
    `valueIssuedUnassigned > 0 when there is unassigned data (got ${metricsMixed.valueIssuedUnassigned}) — dropdown will show "_unassigned" option`,
  );

  // ──────────────────────────────────────────────────
  // 6. Welcome bonus: when active=false, the bot's
  //    first_time greeting must NOT mention "te regalo
  //    X puntos" — fallback to clean welcome.
  // ──────────────────────────────────────────────────
  console.log('\n6. welcome bonus off → bot does not mention bonus on first-time');
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusActive: false } });
  const reply4 = await handleIncomingMessage({
    phoneNumber: '+584125550333',
    messageType: 'text',
    messageText: 'Hola! Quiero ganar puntos en farmatodo Valee Ref: farmatodo',
    tenantId: tenant.id,
  });
  const reply4Text = reply4.join(' ');
  assert(!/Ganaste \d+ puntos de bienvenida/i.test(reply4Text), `No "Ganaste X puntos" leak when bonus is off (got: ${reply4Text.slice(0, 100)}...)`);
  assert(/Bienvenido a/i.test(reply4Text), 'Clean Bienvenido fallback used');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
