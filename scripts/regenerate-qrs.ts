/**
 * One-shot migration for Genesis's 2026-04-24 ask:
 *
 *   "Debemos cambiar todos los QRs del formato viejo (el que tiene mas
 *    pixels) al nuevo porque no estan agarrando correctamente."
 *
 * The QR payload used to carry a long pre-filled WhatsApp message
 * ("Hola! Quiero ganar puntos en <Tenant> ✨ Ref: <slug>..." — ~150
 * URL-encoded chars, pushing the QR to version ~10 with tiny modules).
 * merchant-qr.ts now produces a much shorter "Valee Ref: <slug> ..."
 * payload (~40 chars → version ~3). This script re-renders every
 * EXISTING stored QR (tenant.qrCodeUrl, branch.qrCodeUrl, staff.qrCodeUrl)
 * so already-active merchants get the new, easier-to-scan image without
 * having to click "regenerate" per card.
 *
 * Usage:
 *   npx tsx scripts/regenerate-qrs.ts               → dry-run, prints counts
 *   npx tsx scripts/regenerate-qrs.ts --apply       → actually regenerates
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import {
  generateMerchantQR,
  generateStaffQR,
  generateBranchQR,
} from '../src/services/merchant-qr.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`=== QR regeneration ${APPLY ? '(APPLY)' : '(dry-run)'} ===\n`);

  const tenants = await prisma.tenant.findMany({
    where: { qrCodeUrl: { not: null } },
    select: { id: true, slug: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  const staff = await prisma.staff.findMany({
    where: { qrCodeUrl: { not: null }, active: true },
    select: { id: true, name: true, tenantId: true },
    orderBy: { createdAt: 'asc' },
  });
  const branches = await prisma.branch.findMany({
    where: { qrCodeUrl: { not: null } },
    select: { id: true, name: true, tenantId: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Tenants with QRs:  ${tenants.length}`);
  console.log(`Staff with QRs:    ${staff.length}`);
  console.log(`Branches with QRs: ${branches.length}`);
  console.log('');

  if (!APPLY) {
    console.log('Dry-run only. Re-run with --apply to regenerate.');
    process.exit(0);
  }

  let ok = 0; let fail = 0;
  async function step(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      ok++;
      console.log(`  ✓ ${label}`);
    } catch (e: any) {
      fail++;
      console.log(`  ✗ ${label} — ${e?.message || e}`);
    }
  }

  console.log(`-- Regenerating ${tenants.length} tenant QR(s) --`);
  for (const t of tenants) {
    await step(`tenant ${t.slug}`, () => generateMerchantQR(t.id));
  }
  console.log(`\n-- Regenerating ${staff.length} staff QR(s) --`);
  for (const s of staff) {
    await step(`staff ${s.name} (${s.id.slice(0, 8)})`, () => generateStaffQR(s.id));
  }
  console.log(`\n-- Regenerating ${branches.length} branch QR(s) --`);
  for (const b of branches) {
    await step(`branch ${b.name} (${b.id.slice(0, 8)})`, () => generateBranchQR(b.id));
  }

  console.log(`\nDone. ok=${ok} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
