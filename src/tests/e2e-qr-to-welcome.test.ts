import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { parseMerchantIdentifier, handleIncomingMessage } from '../services/whatsapp-bot.js';
import { generateWhatsAppDeepLink } from '../services/merchant-qr.js';
import webhookRoutes from '../api/routes/webhook.js';

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

async function test() {
  console.log('=== QR SCAN → WHATSAPP → TENANT SCOPE → SHADOW ACCOUNT → WELCOME ===\n');
  await cleanAll();

  const tenant = await createTenant('Panaderia Luna', 'panaderia-luna', 'luna@t.com');
  await createSystemAccounts(tenant.id);

  // ──────────────────────────────────
  // 1. QR contains merchant slug as WhatsApp pre-filled message
  // ──────────────────────────────────
  console.log('1. QR deep link contains merchant identifier');
  const deepLink = await generateWhatsAppDeepLink('panaderia-luna');
  // The pre-filled message text is: MERCHANT:panaderia-luna
  const preFilledText = decodeURIComponent(deepLink.split('text=')[1]);
  assert(preFilledText === 'MERCHANT:panaderia-luna', `Pre-filled text: "${preFilledText}"`);

  // ──────────────────────────────────
  // 2. Bot parses MERCHANT:{slug} and resolves tenant
  // ──────────────────────────────────
  console.log('\n2. Bot parses merchant identifier from message');
  const parsed = await parseMerchantIdentifier('MERCHANT:panaderia-luna');
  assert(parsed !== null, 'Parsed successfully');
  assert(parsed!.tenantId === tenant.id, `Resolved to correct tenant ID`);
  assert(parsed!.tenantName === 'Panaderia Luna', `Tenant name: ${parsed!.tenantName}`);
  assert(parsed!.branchId === null, 'No branch (tenant-level QR)');

  // Parse with branch
  const branch = await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Sucursal Centro', active: true },
  });
  const parsedBranch = await parseMerchantIdentifier(`MERCHANT:panaderia-luna:BRANCH:${branch.id}`);
  assert(parsedBranch !== null, 'Parsed with branch');
  assert(parsedBranch!.branchId === branch.id, `Branch ID resolved: ${parsedBranch!.branchId?.slice(0,8)}...`);

  // Invalid slug returns null
  const invalid = await parseMerchantIdentifier('MERCHANT:nonexistent-shop');
  assert(invalid === null, 'Invalid slug returns null');

  // Random text is not a merchant identifier
  const random = await parseMerchantIdentifier('hola amigo');
  assert(random === null, 'Random text returns null');

  // ──────────────────────────────────
  // 3. Scoping to tenant + shadow account creation + welcome
  // ──────────────────────────────────
  console.log('\n3. Full flow: parse → scope → shadow account → welcome');

  // No account exists yet
  const before = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412LUNA01' } },
  });
  assert(before === null, 'No account exists before QR scan');

  // Simulate: consumer scans QR → WhatsApp sends "MERCHANT:panaderia-luna"
  // Bot receives message → parses tenant → creates account → sends welcome
  const merchantInfo = await parseMerchantIdentifier('MERCHANT:panaderia-luna');
  assert(merchantInfo !== null, 'Merchant identified from QR message');

  const responses = await handleIncomingMessage({
    phoneNumber: '+58412LUNA01',
    tenantId: merchantInfo!.tenantId,
    messageType: 'text',
    messageText: 'MERCHANT:panaderia-luna',
  });

  // Shadow account created silently
  const after = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+58412LUNA01' } },
  });
  assert(after !== null, 'Shadow account created on first contact');
  assert(after!.accountType === 'shadow', 'Account type: shadow');
  assert(after!.tenantId === tenant.id, 'Scoped to correct tenant');

  // Welcome message sent
  assert(responses.length > 0, `Welcome messages returned (${responses.length})`);

  // ──────────────────────────────────
  // 4. Second message from same consumer — no duplicate account
  // ──────────────────────────────────
  console.log('\n4. Second message — same account, no duplicate');
  const responses2 = await handleIncomingMessage({
    phoneNumber: '+58412LUNA01',
    tenantId: tenant.id,
    messageType: 'text',
    messageText: 'hola',
  });

  const accountCount = await prisma.account.count({
    where: { tenantId: tenant.id, phoneNumber: '+58412LUNA01' },
  });
  assert(accountCount === 1, `Still 1 account (got ${accountCount})`);
  assert(responses2.length > 0, 'Response sent on second message');

  // ──────────────────────────────────
  // 5. Webhook endpoint exists and processes messages
  // ──────────────────────────────────
  console.log('\n5. Webhook endpoint via HTTP');
  const app = Fastify();
  await app.register(webhookRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;

  // Simulate Evolution API webhook payload
  const webhookRes = await fetch(`http://127.0.0.1:${port}/api/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: {
        key: { remoteJid: '584125550099@s.whatsapp.net' },
        message: { conversation: 'MERCHANT:panaderia-luna' },
      },
    }),
  });
  const webhookData = await webhookRes.json() as any;
  assert(webhookRes.ok, `Webhook returns 200 (got ${webhookRes.status})`);
  assert(webhookData.status === 'ok', `Status: ok (got ${webhookData.status})`);
  assert(webhookData.responses > 0, `Responses sent: ${webhookData.responses}`);

  // Verify account created from webhook
  const webhookAccount = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550099' } },
  });
  assert(webhookAccount !== null, 'Account created from webhook');
  assert(webhookAccount!.accountType === 'shadow', 'Shadow account from webhook');

  await app.close();

  console.log(`\n=== QR → WELCOME: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
