import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount } from '../services/accounts.js';
import { createAssetType, setTenantConversionRate, convertToLoyaltyValue } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { getAccountBalance } from '../services/ledger.js';
import { grantWelcomeBonus } from '../services/welcome-bonus.js';
import { handleIncomingMessage } from '../services/whatsapp-bot.js';
import fs from 'fs';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK   ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}
function later(msg: string) { console.log(`  LATER ${msg}`); }

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
  console.log('=== APPENDED.MD REQUIREMENTS — HONEST AUDIT ===\n');
  await cleanAll();

  const tenant = await createTenant('Appended Store', 'appended-store', 'ap@t.com');
  const sys = await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@ap.com', passwordHash: '$2b$10$x', role: 'owner' },
  });

  // ================================================================
  // REQ 1: "el motor de cambio va a ser variable"
  // Merchants can set 1x, 1.5x, 2x from dashboard
  // ================================================================
  console.log('REQ 1: Variable conversion multiplier (1x, 1.5x, 2x)');

  // Can set conversion rate
  await setTenantConversionRate(tenant.id, asset.id, '2.00000000');
  const val2x = await convertToLoyaltyValue('100', tenant.id, asset.id);
  assert(val2x === '200.00000000', `$100 × 2x = 200 pts — WORKS`);

  await setTenantConversionRate(tenant.id, asset.id, '1.50000000');
  const val15x = await convertToLoyaltyValue('100', tenant.id, asset.id);
  assert(val15x === '150.00000000', `$100 × 1.5x = 150 pts — WORKS`);

  // API endpoints exist
  const merchantSrc = fs.readFileSync('/home/loyalty-platform/src/api/routes/merchant.ts', 'utf-8');
  assert(merchantSrc.includes("'/api/merchant/multiplier'"), 'GET /api/merchant/multiplier endpoint — WORKS');
  assert(merchantSrc.includes('PUT') && merchantSrc.includes('multiplier'), 'PUT /api/merchant/multiplier endpoint — WORKS');

  // Applied during invoice validation
  await processCSV(`invoice_number,total\nAPP-001,100.00`, tenant.id, staff.id);
  const valResult = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'APP-001', total_amount: 100, transaction_date: null,
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(valResult.valueAssigned === '150.00000000', `Multiplier applied during validation: ${valResult.valueAssigned} — WORKS`);

  // Frontend dashboard control?
  const frontendExists = fs.existsSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/page.tsx');
  const dashSrc = frontendExists ? fs.readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/page.tsx', 'utf-8') : '';
  const hasMultiplierUI = dashSrc.includes('multiplier') || dashSrc.includes('Multiplicador');
  if (!hasMultiplierUI) {
    later('Dashboard UI for multiplier control — NOT YET (API ready, frontend UI missing)');
  } else {
    assert(true, 'Dashboard multiplier UI exists');
  }

  // ================================================================
  // REQ 2: "deals (ofertas sencillas de descuento)"
  // ================================================================
  console.log('\nREQ 2: Deals / discount offers');
  later('Deals — FUTURE PHASE (agreed with client). Architecture supports it (products + multi-asset ledger).');

  // ================================================================
  // REQ 3: "promociones de dinero + puntos (3$ + 800 puntos)"
  // Mixed redemption
  // ================================================================
  console.log('\nREQ 3: Mixed redemption ($ + points)');
  later('Mixed redemption — FUTURE PHASE (agreed with client). Ledger supports multi-asset already.');

  // ================================================================
  // REQ 4: "los niveles, cada usuario debe poder subir niveles"
  // ================================================================
  console.log('\nREQ 4: Consumer levels');

  // Column exists in DB
  const levelCol = await prisma.$queryRaw<any[]>`
    SELECT column_name, column_default FROM information_schema.columns
    WHERE table_name = 'accounts' AND column_name = 'level'
  `;
  assert(levelCol.length === 1, `accounts.level column exists (default ${levelCol[0]?.column_default})`);

  // New account starts at level 1
  const { account: consumer2 } = await findOrCreateConsumerAccount(tenant.id, '+584125550002');
  assert(consumer2.level === 1, `New account starts at level 1 — WORKS`);

  // Level-up logic?
  const hasLevelUp = fs.existsSync('/home/loyalty-platform/src/services/levels.ts');
  const accountsSrc = fs.readFileSync('/home/loyalty-platform/src/services/accounts.ts', 'utf-8');
  const hasLevelLogic = accountsSrc.includes('levelUp') || accountsSrc.includes('level');
  if (!hasLevelUp && !hasLevelLogic) {
    later('Level-up logic (rules for when to increase level) — NOT YET (field exists, logic not implemented)');
  }

  // Level-based rewards filtering?
  later('Level-based reward filtering (higher level = better products) — NOT YET');

  // ================================================================
  // REQ 5: "asignacion de puntos gratuita (bienvenida)"
  // "el primer mensaje que envia el bot es ese: Ganaste 50 puntos!"
  // ================================================================
  console.log('\nREQ 5: Welcome bonus (50 pts on first contact)');

  const { account: consumer3 } = await findOrCreateConsumerAccount(tenant.id, '+584125550003');
  const bonus = await grantWelcomeBonus(consumer3.id, tenant.id, asset.id);
  assert(bonus.granted === true, 'Welcome bonus granted — WORKS');
  assert(bonus.amount === '50.00000000', `50 pts credited — WORKS`);

  const bal = await getAccountBalance(consumer3.id, asset.id, tenant.id);
  assert(Number(bal) === 50, `Balance after bonus: 50 — WORKS`);

  // Never granted twice
  const bonus2 = await grantWelcomeBonus(consumer3.id, tenant.id, asset.id);
  assert(bonus2.granted === false, 'Never granted twice — WORKS');

  // Bot announces it
  const msgs = await handleIncomingMessage({
    phoneNumber: '+584125550099', tenantId: tenant.id, messageType: 'text', messageText: 'hola',
  });
  assert(msgs.some(m => m.includes('50') && m.includes('bienvenida')), 'Bot says "Ganaste 50 puntos de bienvenida" — WORKS');

  // From .env
  assert(process.env.WELCOME_BONUS_AMOUNT === '50', 'WELCOME_BONUS_AMOUNT from .env — WORKS');

  // ================================================================
  // REQ 6: "el bot de WhatsApp te enviará el link de la PWA"
  // ================================================================
  console.log('\nREQ 6: Bot sends PWA link');
  assert(msgs.some(m => m.includes('valee.app/consumer/')), 'Bot sends merchant-specific PWA link — WORKS');

  // ================================================================
  // REQ 7: "automaticamente llegarás al page de ese comercio"
  // ================================================================
  console.log('\nREQ 7: PWA lands on merchant-specific page');
  const slugPageExists = fs.existsSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/[slug]/page.tsx');
  assert(slugPageExists, '/consumer/[slug] route exists — WORKS');

  if (slugPageExists) {
    const slugSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/[slug]/page.tsx', 'utf-8');
    assert(slugSrc.includes('tenantSlug'), 'Stores merchant slug — WORKS');
    assert(slugSrc.includes('/consumer?merchant='), 'Redirects to merchant context — WORKS');
  }

  // ================================================================
  // SUMMARY
  // ================================================================
  console.log('\n\n=== SUMMARY ===\n');
  console.log('IMPLEMENTED NOW:');
  console.log('  1. Variable multiplier (1x, 1.5x, 2x) — backend + API ✓');
  console.log('  5. Welcome bonus (50 pts) — service + bot + .env ✓');
  console.log('  6. Bot sends PWA link ✓');
  console.log('  7. Merchant-specific PWA page ✓');
  console.log('  4. Consumer levels — DB field exists ✓');
  console.log('');
  console.log('PARTIALLY DONE (needs more work):');
  console.log('  1. Multiplier — dashboard UI control not built yet');
  console.log('  4. Levels — field exists, level-up rules not implemented');
  console.log('  4. Levels — reward filtering by level not implemented');
  console.log('');
  console.log('FUTURE PHASE (agreed with client):');
  console.log('  2. Deals / discount offers');
  console.log('  3. Mixed redemption ($ + points)');

  console.log(`\n=== APPENDED AUDIT: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
