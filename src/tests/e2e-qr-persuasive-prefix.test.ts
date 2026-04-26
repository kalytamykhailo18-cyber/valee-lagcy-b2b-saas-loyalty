import dotenv from 'dotenv'; dotenv.config();
import { assertTestDatabase } from './_test-guard.js';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import {
  generateWhatsAppDeepLink,
  generateStaffQR,
  generateBranchQR,
  generateReferralQR,
} from '../services/merchant-qr.js';
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

function decoded(deepLink: string): string {
  const m = deepLink.match(/[?&]text=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function test() {
  console.log('=== E2E: persuasive QR prefix + bot still parses markers ===\n');
  await cleanAll();

  const tenant = await createTenant('Kozmo', 'kozmo', 'k@k.com');
  await createSystemAccounts(tenant.id);
  const branch = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Cuatricentenaria', address: 'Caracas', active: true },
  });
  const cashier = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Genesis', email: 'g@k.com', passwordHash: '$2b$10$x',
      role: 'cashier', active: true,
    },
  });

  // ──────────────────────────────
  // 1. Plain merchant QR — persuasive prefix is in the deep link.
  // ──────────────────────────────
  console.log('1. Merchant QR carries persuasive prefix');
  const merchantLink = await generateWhatsAppDeepLink(tenant.slug, tenant.name);
  const merchantText = decoded(merchantLink);
  assert(merchantText.startsWith('Hola! Quiero ganar puntos en Kozmo'), `Starts with persuasive copy (got: "${merchantText}")`);
  assert(merchantText.includes('Valee Ref: kozmo'), `Marker preserved at the end`);

  // ──────────────────────────────
  // 2. Branch QR carries the tenant + branch name.
  // ──────────────────────────────
  console.log('\n2. Branch QR names the sucursal');
  const branchOut = await generateBranchQR(branch.id);
  const branchText = decoded(branchOut.deepLink);
  assert(branchText.startsWith('Hola! Quiero ganar puntos en Kozmo - Cuatricentenaria'), `Branch label inline (got: "${branchText.slice(0, 70)}...")`);
  assert(branchText.includes(`Valee Ref: kozmo/${branch.id}`), `Branch marker preserved`);

  // ──────────────────────────────
  // 3. Staff/cajero QR carries cashier name.
  // ──────────────────────────────
  console.log('\n3. Cajero QR names the cashier');
  const staffOut = await generateStaffQR(cashier.id);
  const staffText = decoded(staffOut.deepLink);
  assert(staffText.startsWith('Hola! Quiero ganar puntos en Kozmo con Genesis'), `Cashier name inline (got: "${staffText.slice(0, 70)}...")`);
  assert(/Valee Ref: kozmo Cjr: [a-z0-9]{4,}/i.test(staffText), `Cjr marker preserved`);

  // ──────────────────────────────
  // 4. Referral QR carries the merchant name.
  // ──────────────────────────────
  console.log('\n4. Referral QR carries merchant name');
  const refOut = await generateReferralQR({ merchantSlug: tenant.slug, merchantName: tenant.name, referralSlug: 'r4nd0m' });
  const refText = decoded(refOut.deepLink);
  assert(refText.startsWith('Hola! Quiero ganar puntos en Kozmo'), `Referral persuasive`);
  assert(refText.includes('Valee Ref: kozmo Ref2U: r4nd0m'), `Ref2U marker preserved`);

  // ──────────────────────────────
  // 5. The bot still recognises the new persuasive body — must respond
  //    with a state greeting, NOT "No entendí". This is the regression
  //    guard so we never lose markup detection again.
  // ──────────────────────────────
  console.log('\n5. Bot greeting on persuasive scan — new user');
  const reply1 = await handleIncomingMessage({
    phoneNumber: '+584125557000',
    tenantId: tenant.id,
    messageType: 'text',
    messageText: merchantText,
  });
  const reply1Joined = reply1.join(' ');
  assert(!/No entendí/i.test(reply1Joined), `No fallback (got: "${reply1Joined.slice(0, 80)}...")`);
  assert(/Bienvenida|Bienvenido|bienvenida|saldo/i.test(reply1Joined), `State greeting returned`);

  console.log('\n6. Bot greeting on persuasive cajero scan');
  const reply2 = await handleIncomingMessage({
    phoneNumber: '+584125557001',
    tenantId: tenant.id,
    messageType: 'text',
    messageText: staffText,
  });
  const reply2Joined = reply2.join(' ');
  assert(!/No entendí/i.test(reply2Joined), `Cajero scan: no fallback`);
  assert(/Bienvenida|Bienvenido|bienvenida|saldo/i.test(reply2Joined), `Cajero scan: greeting`);

  console.log('\n7. Bot greeting on persuasive branch scan');
  const reply3 = await handleIncomingMessage({
    phoneNumber: '+584125557002',
    tenantId: tenant.id,
    messageType: 'text',
    messageText: branchText,
  });
  const reply3Joined = reply3.join(' ');
  assert(!/No entendí/i.test(reply3Joined), `Branch scan: no fallback`);
  assert(/Bienvenida|Bienvenido|bienvenida|saldo/i.test(reply3Joined), `Branch scan: greeting`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

test().catch(e => { console.error(e); process.exit(1); });
