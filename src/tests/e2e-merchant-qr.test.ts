import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { generateWhatsAppDeepLink, generateQRImage, generateMerchantQR, generateBranchQR } from '../services/merchant-qr.js';
import { createBranch } from '../services/branches.js';

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
  console.log('=== MERCHANT QR CODE (STATIC) — FULL E2E ===\n');
  await cleanAll();

  const tenant = await createTenant('QR Shop', 'qr-shop', 'qr@t.com');

  // ──────────────────────────────────
  // 1. Deep link generation
  // ──────────────────────────────────
  console.log('1. WhatsApp deep link generation');
  const deepLink = await generateWhatsAppDeepLink('qr-shop');
  assert(deepLink.startsWith('https://wa.me/'), `Starts with wa.me (got: ${deepLink.slice(0, 30)}...)`);
  assert(deepLink.includes('MERCHANT'), 'Contains MERCHANT identifier');
  assert(deepLink.includes('qr-shop'), 'Contains merchant slug');

  // Uses EVOLUTION_INSTANCE_NAME from .env
  const botPhone = process.env.EVOLUTION_INSTANCE_NAME || '0000000000';
  assert(deepLink.includes(botPhone), `Uses bot phone from .env: ${botPhone}`);

  // Contains nothing sensitive — just slug
  assert(!deepLink.includes('secret'), 'No secrets in deep link');
  assert(!deepLink.includes('password'), 'No passwords in deep link');
  assert(!deepLink.includes('key'), 'No keys in deep link');

  // ──────────────────────────────────
  // 2. QR image generation
  // ──────────────────────────────────
  console.log('\n2. QR image generation');
  const qrBuffer = await generateQRImage(deepLink);
  assert(qrBuffer instanceof Buffer, 'QR image is a Buffer');
  assert(qrBuffer.length > 100, `QR image has content (${qrBuffer.length} bytes)`);

  // PNG header check
  const pngHeader = qrBuffer.slice(0, 4).toString('hex');
  assert(pngHeader === '89504e47', `Valid PNG format (header: ${pngHeader})`);

  // ──────────────────────────────────
  // 3. Full merchant QR generation + storage
  // ──────────────────────────────────
  console.log('\n3. Full generateMerchantQR() — generates + stores');
  const result = await generateMerchantQR(tenant.id);
  assert(result.deepLink.includes('qr-shop'), 'Deep link contains slug');
  assert(result.qrCodeUrl !== null, 'QR code URL generated');
  assert(result.qrCodeUrl!.length > 0, 'QR code URL is non-empty');

  // Verify stored in tenant record
  const updatedTenant = await prisma.tenant.findUnique({ where: { id: tenant.id } });
  assert(updatedTenant!.qrCodeUrl !== null, 'qr_code_url stored in tenants table');
  assert(updatedTenant!.qrCodeUrl === result.qrCodeUrl, 'Stored URL matches returned URL');

  // ──────────────────────────────────
  // 4. QR is static — regenerating gives same deep link
  // ──────────────────────────────────
  console.log('\n4. QR is static — same deep link every time');
  const deepLink2 = await generateWhatsAppDeepLink('qr-shop');
  assert(deepLink2 === deepLink, 'Same slug → same deep link (static, never changes)');

  // ──────────────────────────────────
  // 5. Different merchants get different QRs
  // ──────────────────────────────────
  console.log('\n5. Different merchants → different QR codes');
  const tenant2 = await createTenant('Other Shop', 'other-shop', 'os@t.com');
  const result2 = await generateMerchantQR(tenant2.id);
  assert(result2.deepLink !== result.deepLink, 'Different merchants have different deep links');
  assert(result2.deepLink.includes('other-shop'), 'Second QR contains correct slug');

  // ──────────────────────────────────
  // 6. Branch QR generation
  // ──────────────────────────────────
  console.log('\n6. Branch QR code generation');
  const branch = await createBranch({ tenantId: tenant.id, name: 'Downtown', latitude: 10.15, longitude: -67.99 });
  const branchResult = await generateBranchQR(branch.id);
  assert(branchResult.deepLink.includes('qr-shop'), 'Branch QR contains tenant slug');
  assert(branchResult.deepLink.includes(branch.id), 'Branch QR contains branch ID');

  const updatedBranch = await prisma.branch.findUnique({ where: { id: branch.id } });
  assert(updatedBranch!.qrCodeUrl !== null, 'Branch qr_code_url stored');

  // ──────────────────────────────────
  // 7. DB schema: qr_code_url columns exist
  // ──────────────────────────────────
  console.log('\n7. Schema verification');
  const tenantCols = await prisma.$queryRaw<any[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'qr_code_url'
  `;
  assert(tenantCols.length === 1, 'tenants.qr_code_url column exists');

  const branchCols = await prisma.$queryRaw<any[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'branches' AND column_name = 'qr_code_url'
  `;
  assert(branchCols.length === 1, 'branches.qr_code_url column exists');

  console.log(`\n=== MERCHANT QR: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
