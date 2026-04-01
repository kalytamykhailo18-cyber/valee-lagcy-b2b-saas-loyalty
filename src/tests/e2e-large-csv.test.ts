import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { processCSV } from '../services/csv-upload.js';

async function test() {
  // Generate 1000-row CSV
  let csv = 'invoice_number,total,date,phone\n';
  for (let i = 1; i <= 1000; i++) {
    csv += `LARGE-${String(i).padStart(4,'0')},${(Math.random()*500+10).toFixed(2)},2024-03-01,+58412${String(i).padStart(6,'0')}\n`;
  }

  const tenant = await prisma.tenant.create({ data: { name: 'Large CSV', slug: 'large-csv-' + Date.now(), ownerEmail: 'l@t.com' } });
  const staff = await prisma.staff.create({ data: { tenantId: tenant.id, name: 'O', email: 'o@l.com', passwordHash: 'x', role: 'owner' } });

  const start = Date.now();
  const result = await processCSV(csv, tenant.id, staff.id);
  const elapsed = Date.now() - start;

  console.log(`  Rows: ${result.rowsLoaded} loaded, ${result.rowsSkipped} skipped, ${result.rowsErrored} errors`);
  console.log(`  Time: ${elapsed}ms`);
  console.log(result.rowsLoaded === 1000 ? '  OK  1000 rows processed' : '  FAIL');
  console.log(elapsed < 30000 ? '  OK  Under 30s' : '  FAIL  Exceeded 30s');

  await prisma.$disconnect();
  process.exit(result.rowsLoaded === 1000 && elapsed < 30000 ? 0 : 1);
}
test();
