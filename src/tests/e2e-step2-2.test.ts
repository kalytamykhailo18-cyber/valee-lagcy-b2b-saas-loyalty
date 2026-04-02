import dotenv from 'dotenv'; dotenv.config();
import Fastify from 'fastify';
import cors from '@fastify/cors';
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { issueConsumerTokens } from '../services/auth.js';
import consumerRoutes from '../api/routes/consumer.js';
import fs from 'fs';

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
  console.log('=== STEP 2.2: PWA INVOICE SCANNING ===\n');
  await cleanAll();

  const tenant = await createTenant('Scan Store', 'scan-store', 'sc@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@sc.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  await processCSV(`invoice_number,total\nSCAN-001,175.00\nSCAN-002,50.00`, tenant.id, staff.id);

  // Create consumer via direct validation (simulating prior WhatsApp contact)
  await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    extractedData: { invoice_number: 'SCAN-001', total_amount: 175, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  const account = await prisma.account.findUnique({
    where: { tenantId_phoneNumber: { tenantId: tenant.id, phoneNumber: '+584125550001' } },
  });

  // Start server
  const app = Fastify();
  await app.register(cors);
  await app.register(consumerRoutes);
  await app.listen({ port: 0 });
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const token = issueConsumerTokens({
    accountId: account!.id, tenantId: tenant.id, phoneNumber: '+584125550001', type: 'consumer',
  }).accessToken;

  // ──────────────────────────────────
  // 1. "Scan Invoice" button visible on main screen
  // ──────────────────────────────────
  console.log('1. "Scan Invoice" button on main screen');
  const mainSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/consumer/page.tsx', 'utf-8');
  assert(mainSrc.includes('Escanear factura'), 'Button labeled "Escanear factura" on main screen');
  assert(mainSrc.includes('href="/scan"'), 'Links to /scan page');

  // ──────────────────────────────────
  // 2. Two options: camera or gallery
  // ──────────────────────────────────
  console.log('\n2. Camera and gallery options');
  const scanSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/scan/page.tsx', 'utf-8');
  assert(scanSrc.includes('capture="environment"'), 'Camera option with capture="environment"');
  assert(scanSrc.includes('accept="image/*"'), 'Accepts all image types');
  assert(scanSrc.includes("removeAttribute('capture')"), 'Gallery option removes capture attribute');
  assert(scanSrc.includes('Tomar foto'), 'Camera button: "Tomar foto"');
  assert(scanSrc.includes('Seleccionar de galeria'), 'Gallery button: "Seleccionar de galeria"');

  // ──────────────────────────────────
  // 3. Sends to same backend validation pipeline (Step 1.6)
  // ──────────────────────────────────
  console.log('\n3. Same backend pipeline via API');

  // POST /api/consumer/validate-invoice — same pipeline as WhatsApp
  const valRes = await fetch(`${base}/api/consumer/validate-invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      extractedData: { invoice_number: 'SCAN-002', total_amount: 50, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
      assetTypeId: asset.id,
    }),
  });
  const valData = await valRes.json() as any;

  assert(valRes.ok, `validate-invoice endpoint: ${valRes.status}`);
  assert(valData.success === true, 'Validation succeeded');
  assert(valData.valueAssigned === '50.00000000', `Value earned: ${valData.valueAssigned}`);
  assert(valData.newBalance === '225.00000000', `New balance: ${valData.newBalance}`);

  // Same anti-fraud checks apply — test duplicate
  const dupRes = await fetch(`${base}/api/consumer/validate-invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      extractedData: { invoice_number: 'SCAN-002', total_amount: 50, transaction_date: null, customer_phone: null, merchant_name: null, confidence_score: 0.95 },
      assetTypeId: asset.id,
    }),
  });
  const dupData = await dupRes.json() as any;
  assert(dupData.success === false, 'Duplicate rejected (same anti-fraud as WhatsApp)');
  assert(dupData.message.includes('already'), 'Message says already used');

  // ──────────────────────────────────
  // 4. Loading state while processing
  // ──────────────────────────────────
  console.log('\n4. Loading state during processing');
  assert(scanSrc.includes("stage === 'processing'"), 'Processing stage state exists');
  assert(scanSrc.includes('Leyendo tu factura'), 'Animation step 1: "Leyendo tu factura"');
  assert(scanSrc.includes('Verificando con el comercio'), 'Animation step 2: "Verificando con el comercio"');
  assert(scanSrc.includes('Agregando tus puntos'), 'Animation step 3: "Agregando tus puntos"');

  // ──────────────────────────────────
  // 5. Result screen: success or rejection
  // ──────────────────────────────────
  console.log('\n5. In-app result screen');
  assert(scanSrc.includes("stage === 'result'"), 'Result stage state exists');
  assert(scanSrc.includes('Factura validada'), 'Success: "Factura validada!"');
  assert(scanSrc.includes('No se pudo validar'), 'Failure: "No se pudo validar"');
  assert(scanSrc.includes('valueAssigned'), 'Shows value earned');
  assert(scanSrc.includes('newBalance'), 'Shows new balance');
  assert(scanSrc.includes('Volver al inicio'), 'Link back to main screen');

  // ──────────────────────────────────
  // 6. Balance updates on success (verify via API)
  // ──────────────────────────────────
  console.log('\n6. Balance updates after successful scan');
  const balRes = await fetch(`${base}/api/consumer/balance`, { headers: { Authorization: `Bearer ${token}` } });
  const balData = await balRes.json() as any;
  assert(Number(balData.balance) === 225, `Balance: 225 after scanning (got ${balData.balance})`);

  // ──────────────────────────────────
  // 7. No redirect to WhatsApp
  // ──────────────────────────────────
  console.log('\n7. No redirect to WhatsApp');
  assert(!scanSrc.includes('wa.me') && !scanSrc.includes('whatsapp'), 'No WhatsApp redirect in scan page');

  await app.close();
  console.log(`\n=== STEP 2.2: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
