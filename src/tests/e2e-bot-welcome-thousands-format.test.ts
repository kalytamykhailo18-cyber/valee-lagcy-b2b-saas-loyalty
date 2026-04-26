import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate } from '../services/assets.js';
import { handleIncomingMessage } from '../services/whatsapp-bot.js';

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
  console.log('=== E2E: bot welcome message uses dot thousand separators (es-VE) ===\n');
  await cleanAll();

  // Default tenant defaults: welcomeBonusAmount=5000, active=true. Eric wants
  // the bot to render this as "5.000" to match the panel formatting.
  const tenant = await createTenant('Granja', 'granja-fmt', 'g@g.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '100');
  await setTenantConversionRate(tenant.id, asset.id, '100');

  // 1. First-time user → bonus 5000 must render as "5.000"
  console.log('1. Welcome bonus 5000 → "5.000"');
  const r1 = await handleIncomingMessage({
    phoneNumber: '+584125557011',
    tenantId: tenant.id,
    messageType: 'text',
    messageText: 'Hola Valee Ref: granja-fmt',
  });
  const text1 = r1.join(' ');
  assert(text1.includes('5.000'), `Bonus shows "5.000" (got: "${text1.slice(0, 100)}...")`);
  assert(!/¡Ganaste 5000 puntos/i.test(text1), 'No raw "5000" without separator');

  // 2. Bumping the welcome bonus to 10000 should render "10.000".
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusAmount: 10000 } });
  console.log('\n2. Welcome bonus 10000 → "10.000"');
  const r2 = await handleIncomingMessage({
    phoneNumber: '+584125557012',
    tenantId: tenant.id,
    messageType: 'text',
    messageText: 'Hola Valee Ref: granja-fmt',
  });
  const text2 = r2.join(' ');
  assert(text2.includes('10.000'), `Bonus shows "10.000" (got: "${text2.slice(0, 100)}...")`);

  // 3. Smaller numbers (under 1000) shouldn't gain a fake separator.
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusAmount: 750 } });
  console.log('\n3. Welcome bonus 750 → "750" (no separator)');
  const r3 = await handleIncomingMessage({
    phoneNumber: '+584125557013',
    tenantId: tenant.id,
    messageType: 'text',
    messageText: 'Hola Valee Ref: granja-fmt',
  });
  const text3 = r3.join(' ');
  assert(/Ganaste 750 puntos/i.test(text3), `Bonus shows "750" intact (got: "${text3.slice(0, 100)}...")`);

  // 4. Bonus disabled → message must NOT mention the bonus at all (regression).
  await prisma.tenant.update({ where: { id: tenant.id }, data: { welcomeBonusActive: false } });
  console.log('\n4. Bonus disabled → no bonus line at all');
  const r4 = await handleIncomingMessage({
    phoneNumber: '+584125557014',
    tenantId: tenant.id,
    messageType: 'text',
    messageText: 'Hola Valee Ref: granja-fmt',
  });
  const text4 = r4.join(' ');
  assert(!/Ganaste/i.test(text4), `No "Ganaste" leak when bonus off (got: "${text4.slice(0, 80)}...")`);
  assert(/Bienvenido a Granja/i.test(text4), 'Clean welcome shown');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
