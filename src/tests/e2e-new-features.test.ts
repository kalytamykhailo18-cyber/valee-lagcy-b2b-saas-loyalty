import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { grantWelcomeBonus } from '../services/welcome-bonus.js';
import { getAccountBalance } from '../services/ledger.js';
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
  console.log('=== NEW FEATURES: WELCOME BONUS + LEVELS + PWA LINK + MULTIPLIER ===\n');
  await cleanAll();

  const tenant = await createTenant('New Features Store', 'new-features', 'nf@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');

  // ──────────────────────────────────
  // 1. DB schema: new columns exist
  // ──────────────────────────────────
  console.log('1. Schema: level + welcome_bonus_granted columns exist');
  const cols = await prisma.$queryRaw<any[]>`
    SELECT column_name, data_type, column_default FROM information_schema.columns
    WHERE table_name = 'accounts' AND column_name IN ('level', 'welcome_bonus_granted')
    ORDER BY column_name
  `;
  assert(cols.length === 2, `2 new columns (got ${cols.length})`);
  assert(cols.some((c: any) => c.column_name === 'level' && c.column_default === '1'), 'level default 1');
  assert(cols.some((c: any) => c.column_name === 'welcome_bonus_granted' && c.column_default === 'false'), 'welcome_bonus_granted default false');

  // ──────────────────────────────────
  // 2. New account starts at level 1, bonus not granted
  // ──────────────────────────────────
  console.log('\n2. New account: level 1, bonus not granted');
  const { account } = await findOrCreateConsumerAccount(tenant.id, '+584125550001');
  assert(account.level === 1, `Level: ${account.level}`);
  assert(account.welcomeBonusGranted === false, `welcomeBonusGranted: ${account.welcomeBonusGranted}`);

  // ──────────────────────────────────
  // 3. Welcome bonus: credits points, marks as granted
  // ──────────────────────────────────
  console.log('\n3. Welcome bonus: grant once');
  const bonusAmount = process.env.WELCOME_BONUS_AMOUNT || '50';
  assert(bonusAmount === '50', `WELCOME_BONUS_AMOUNT from .env: ${bonusAmount}`);

  const bonus = await grantWelcomeBonus(account.id, tenant.id, asset.id);
  assert(bonus.granted === true, 'Bonus granted');
  assert(bonus.amount === '50.00000000', `Amount: ${bonus.amount}`);

  // Balance should be 50
  const balance = await getAccountBalance(account.id, asset.id, tenant.id);
  assert(Number(balance) === 50, `Balance after bonus: ${balance}`);

  // Account flagged
  const updated = await prisma.account.findUnique({ where: { id: account.id } });
  assert(updated!.welcomeBonusGranted === true, 'welcomeBonusGranted = true');

  // Double-entry exists
  const entries = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: `WELCOME-${account.id}` },
  });
  assert(entries.length === 2, '2 ledger entries for welcome bonus (double-entry)');

  // ──────────────────────────────────
  // 4. Welcome bonus: never granted twice
  // ──────────────────────────────────
  console.log('\n4. Welcome bonus: idempotent (never twice)');
  const bonus2 = await grantWelcomeBonus(account.id, tenant.id, asset.id);
  assert(bonus2.granted === false, 'Second grant returns false');

  const balance2 = await getAccountBalance(account.id, asset.id, tenant.id);
  assert(Number(balance2) === 50, `Balance unchanged: ${balance2}`);

  const entries2 = await prisma.ledgerEntry.findMany({
    where: { tenantId: tenant.id, referenceId: `WELCOME-${account.id}` },
  });
  assert(entries2.length === 2, 'Still only 2 entries (no duplicate)');

  // ──────────────────────────────────
  // 5. Bot welcomes with bonus message + PWA link
  // ──────────────────────────────────
  console.log('\n5. Bot welcome: bonus announcement + PWA link');
  const msgs = await handleIncomingMessage({
    phoneNumber: '+584125550099', tenantId: tenant.id,
    messageType: 'text', messageText: 'hola',
  });
  assert(msgs.some(m => m.includes('50') && m.includes('bienvenida')), 'Bot announces welcome bonus');
  assert(msgs.some(m => m.includes('valee.app/consumer/')), 'Bot sends merchant-specific PWA link');

  // Verify the new consumer got the bonus
  const newAcc = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550099' } },
  });
  assert(newAcc!.welcomeBonusGranted === true, 'New consumer got welcome bonus');
  const newBal = await getAccountBalance(newAcc!.id, asset.id, tenant.id);
  assert(Number(newBal) === 50, `New consumer balance: ${newBal}`);

  // ──────────────────────────────────
  // 6. Multiplier: merchant can change conversion rate
  // ──────────────────────────────────
  console.log('\n6. Multiplier: merchant can set 1x, 1.5x, 2x');

  // Default rate is 1.0
  const { getConversionRate, setTenantConversionRate, convertToLoyaltyValue } = await import('../services/assets.js');
  const defaultRate = await getConversionRate(tenant.id, asset.id);
  assert(Number(defaultRate) === 1, `Default rate: ${defaultRate}`);

  // Set 2x
  await setTenantConversionRate(tenant.id, asset.id, '2.00000000');
  const newRate = await getConversionRate(tenant.id, asset.id);
  assert(Number(newRate) === 2, `After 2x: ${newRate}`);

  const value2x = await convertToLoyaltyValue('100', tenant.id, asset.id);
  assert(value2x === '200.00000000', `$100 × 2x = ${value2x}`);

  // Set 1.5x
  await setTenantConversionRate(tenant.id, asset.id, '1.50000000');
  const value15x = await convertToLoyaltyValue('100', tenant.id, asset.id);
  assert(value15x === '150.00000000', `$100 × 1.5x = ${value15x}`);

  // API endpoint exists
  const fs = await import('fs');
  const merchantRoute = fs.readFileSync('/home/loyalty-platform/src/api/routes/merchant.ts', 'utf-8');
  assert(merchantRoute.includes("'/api/merchant/multiplier'"), 'GET /api/merchant/multiplier endpoint exists');
  assert(merchantRoute.includes("PUT") && merchantRoute.includes("multiplier"), 'PUT /api/merchant/multiplier endpoint exists');

  // ──────────────────────────────────
  // 7. Merchant-specific PWA route exists
  // ──────────────────────────────────
  console.log('\n7. Merchant-specific PWA route');
  const slugPage = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/[slug]/page.tsx', 'utf-8');
  assert(slugPage.includes('tenantSlug'), 'Stores slug in localStorage');
  assert(slugPage.includes('/consumer?merchant='), 'Redirects to consumer app with merchant context');

  // ──────────────────────────────────
  // 8. .env vars
  // ──────────────────────────────────
  console.log('\n8. .env variables');
  assert(typeof process.env.WELCOME_BONUS_AMOUNT === 'string', 'WELCOME_BONUS_AMOUNT in .env');

  const envExample = fs.readFileSync('/home/loyalty-platform/.env.example', 'utf-8');
  assert(envExample.includes('WELCOME_BONUS_AMOUNT'), 'WELCOME_BONUS_AMOUNT in .env.example');

  console.log(`\n=== NEW FEATURES: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
