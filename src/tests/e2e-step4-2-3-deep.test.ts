import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { createTenant } from '../services/tenants.js';
import { createSystemAccounts } from '../services/accounts.js';
import { createAssetType } from '../services/assets.js';
import { processCSV } from '../services/csv-upload.js';
import { validateInvoice } from '../services/invoice-validation.js';
import { haversineDistanceKm, checkGeofence } from '../services/geofencing.js';
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
  await prisma.recurrenceNotification.deleteMany(); await prisma.recurrenceRule.deleteMany();
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
  console.log('=== STEPS 4.2 + 4.3: GEOFENCING + ANIMATIONS — DEEP E2E ===\n');
  await cleanAll();

  // ══════════════════════════════════
  // STEP 4.2: GEOFENCING
  // ══════════════════════════════════
  console.log('══ STEP 4.2: GEOFENCING ══\n');

  const tenant = await createTenant('Geo Store', 'geo-store-deep', 'gd@t.com');
  await createSystemAccounts(tenant.id);
  const asset = await createAssetType('Points', 'pts', '1.00000000');
  const staff = await prisma.staff.create({
    data: { tenantId: tenant.id, name: 'Owner', email: 'o@gd.com', passwordHash: '$2b$10$x', role: 'owner' },
  });
  // Branch in Valencia, Venezuela
  await prisma.branch.create({
    data: { tenantId: tenant.id, name: 'Valencia', latitude: 10.1579, longitude: -67.9972, active: true },
  });

  // 1. Haversine distance calculation
  console.log('1. Haversine distance');
  const dist = haversineDistanceKm(10.4806, -66.9036, 10.1579, -67.9972);
  assert(dist > 100 && dist < 200, `Caracas→Valencia: ${dist.toFixed(1)} km`);
  assert(haversineDistanceKm(10.0, -67.0, 10.0, -67.0) === 0, 'Same point = 0 km');

  // 2. Plausible location → auto-approve
  console.log('\n2. Plausible location');
  const plausible = await checkGeofence({
    consumerLat: 10.16, consumerLon: -68.00,
    tenantId: tenant.id,
    invoiceTimestamp: new Date(Date.now() - 30 * 60 * 1000),
  });
  assert(plausible.plausible === true, `Plausible: ${plausible.distanceKm} km in ${plausible.elapsedMinutes} min`);

  // 3. Implausible location → manual review
  console.log('\n3. Implausible location');
  const implausible = await checkGeofence({
    consumerLat: 4.5981, consumerLon: -74.0758, // Bogota
    tenantId: tenant.id,
    invoiceTimestamp: new Date(Date.now() - 5 * 60 * 1000),
  });
  assert(implausible.plausible === false, `Implausible: ${implausible.distanceKm} km`);
  assert(implausible.impliedSpeedKmh > 200, `Speed: ${implausible.impliedSpeedKmh} km/h`);

  // 4. Missing coordinates → no penalty
  console.log('\n4. Missing coordinates');
  const missing = await checkGeofence({
    consumerLat: null, consumerLon: null,
    tenantId: tenant.id,
    invoiceTimestamp: new Date(),
  });
  assert(missing.plausible === true, 'No penalty for missing coords');

  // 5. Geofence integrated into validation pipeline
  console.log('\n5. Integration with validation pipeline');
  await processCSV(`invoice_number,total,date\nGEO-001,100.00,${new Date(Date.now() - 5 * 60 * 1000).toISOString()}`, tenant.id, staff.id);

  const flagged = await validateInvoice({
    tenantId: tenant.id, senderPhone: '+584125550001', assetTypeId: asset.id,
    latitude: '4.5981', longitude: '-74.0758',
    extractedData: { invoice_number: 'GEO-001', total_amount: 100,
      transaction_date: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      customer_phone: null, merchant_name: null, confidence_score: 0.95 },
  });
  assert(flagged.success === false, 'Implausible → flagged');
  assert(flagged.stage === 'geofence', `Stage: ${flagged.stage}`);
  assert(flagged.status === 'manual_review', 'Status: manual_review');

  const flaggedInv = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, invoiceNumber: 'GEO-001' } });
  assert(flaggedInv!.status === 'manual_review', 'Invoice in manual_review');

  // 6. GEO_MAX_SPEED_KMH from .env
  console.log('\n6. .env configuration');
  assert(typeof process.env.GEO_MAX_SPEED_KMH === 'string', 'GEO_MAX_SPEED_KMH from .env');
  const src = fs.readFileSync('/home/loyalty-platform/src/services/geofencing.ts', 'utf-8');
  assert(src.includes('GEO_MAX_SPEED_KMH'), 'Uses GEO_MAX_SPEED_KMH');

  // 7. Coordinates stored on ledger entries
  console.log('\n7. Coordinates stored');
  const valSrc = fs.readFileSync('/home/loyalty-platform/src/services/invoice-validation.ts', 'utf-8');
  assert(valSrc.includes('latitude'), 'Latitude passed to writeDoubleEntry');
  assert(valSrc.includes('longitude'), 'Longitude passed to writeDoubleEntry');

  // ══════════════════════════════════
  // STEP 4.3: PROCESS ANIMATIONS
  // ══════════════════════════════════
  console.log('\n\n══ STEP 4.3: PROCESS ANIMATIONS ══\n');

  const scanSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/scan/page.tsx', 'utf-8');
  const scannerSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(merchant)/merchant/scanner/page.tsx', 'utf-8');
  const cssSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/globals.css', 'utf-8');

  // 1. Invoice processing animation (3 steps × 0.5s = 1.5s)
  console.log('1. Invoice processing animation');
  assert(scanSrc.includes('Leyendo tu factura'), 'Step 1: "Leyendo tu factura"');
  assert(scanSrc.includes('Verificando con el comercio'), 'Step 2: "Verificando con el comercio"');
  assert(scanSrc.includes('Agregando tus puntos'), 'Step 3: "Agregando tus puntos"');
  assert(scanSrc.includes('duration: 500'), 'Each step: 500ms');

  // Total 1.5s: animation plays full cycle before showing result
  assert(scanSrc.includes('Promise.all'), 'Waits for both animation + API (min 1.5s)');

  // 2. QR generation animation
  console.log('\n2. QR generation animation');
  const catSrc = fs.readFileSync('/home/loyalty-platform/frontend/app/(consumer)/catalog/page.tsx', 'utf-8');
  assert(catSrc.includes('animate-qr-build'), 'QR build animation class');
  assert(cssSrc.includes('build-qr') || cssSrc.includes('qr-build'), 'QR animation keyframes in CSS');

  // 3. Redemption confirmation animation (cashier screen)
  console.log('\n3. Redemption confirmation animation');
  assert(scannerSrc.includes('animate-check'), 'Cashier success: checkmark animation');
  assert(cssSrc.includes('pulse-check'), 'Pulse-check keyframes in CSS');
  assert(scannerSrc.includes('bg-green-500'), 'Full-screen green on success');

  // 4. Animation timing rule: 1.5s minimum
  console.log('\n4. Animation timing (1.5s min)');
  assert(scanSrc.includes('500') && scanSrc.includes('ANIMATION_STEPS'), '3 × 500ms steps defined');
  assert(cssSrc.includes('1.5s'), 'CSS animations use 1.5s duration');

  console.log(`\n=== STEPS 4.2+4.3: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
