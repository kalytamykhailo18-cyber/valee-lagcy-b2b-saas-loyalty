// One-shot: regenerate every existing QR (merchant + branch + staff) so each
// picks up the persuasive prefix restored on 2026-04-25. Safe to re-run.
import dotenv from 'dotenv'; dotenv.config();
import prisma from '../src/db/client.js';
import { generateMerchantQR, generateBranchQR, generateStaffQR } from '../src/services/merchant-qr.js';

(async () => {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  for (const t of tenants) {
    try {
      await generateMerchantQR(t.id);
      console.log(`merchant QR refreshed: ${t.name}`);
    } catch (e: any) {
      console.error(`merchant QR fail: ${t.name}: ${e?.message}`);
    }
  }
  const branches = await prisma.branch.findMany({ select: { id: true, name: true } });
  for (const b of branches) {
    try {
      await generateBranchQR(b.id);
      console.log(`branch QR refreshed: ${b.name}`);
    } catch (e: any) {
      console.error(`branch QR fail: ${b.name}: ${e?.message}`);
    }
  }
  const staff = await prisma.staff.findMany({ where: { qrSlug: { not: null } }, select: { id: true, name: true } });
  for (const s of staff) {
    try {
      await generateStaffQR(s.id);
      console.log(`staff QR refreshed: ${s.name}`);
    } catch (e: any) {
      console.error(`staff QR fail: ${s.name}: ${e?.message}`);
    }
  }
  console.log('done.');
  await prisma.$disconnect();
})();
