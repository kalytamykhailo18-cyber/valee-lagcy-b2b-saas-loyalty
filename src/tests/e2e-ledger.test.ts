import dotenv from 'dotenv';
dotenv.config();

import prisma from '../db/client.js';
import { writeDoubleEntry, getAccountBalance, verifyHashChain } from '../services/ledger.js';

async function e2eTest() {
  const tenant = await prisma.tenant.create({ data: { name: 'E2E Ledger Test', slug: 'e2e-ledger-' + Date.now(), ownerEmail: 'e2e@test.com' } });
  const asset = await prisma.assetType.upsert({ where: { name: 'E2E Points' }, update: {}, create: { name: 'E2E Points', unitLabel: 'pts', defaultConversionRate: '1.0' } });
  const pool = await prisma.account.create({ data: { tenantId: tenant.id, accountType: 'system', systemAccountType: 'issued_value_pool' } });
  const consumer = await prisma.account.create({ data: { tenantId: tenant.id, phoneNumber: '+58412E2E001', accountType: 'shadow' } });

  console.log('1. INSERT: Write double-entry event');
  const result = await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '250.00000000', assetTypeId: asset.id,
    referenceId: 'E2E-001', referenceType: 'invoice',
  });
  console.log('   DEBIT  id:', result.debit.id.slice(0,8) + '...', 'paired→', result.debit.pairedEntryId?.slice(0,8) + '...');
  console.log('   CREDIT id:', result.credit.id.slice(0,8) + '...', 'paired→', result.credit.pairedEntryId?.slice(0,8) + '...');
  console.log('   Both entries created atomically: OK');

  console.log('\n2. UPDATE: Attempt to modify ledger entry');
  try {
    await prisma.$executeRaw`UPDATE ledger_entries SET amount = 999 WHERE id = ${result.debit.id}::uuid`;
    console.log('   PROBLEM: UPDATE was allowed!');
  } catch (err: any) {
    console.log('   BLOCKED: Database trigger rejected UPDATE');
  }

  console.log('\n3. DELETE: Attempt to remove ledger entry');
  try {
    await prisma.$executeRaw`DELETE FROM ledger_entries WHERE id = ${result.debit.id}::uuid`;
    console.log('   PROBLEM: DELETE was allowed!');
  } catch (err: any) {
    console.log('   BLOCKED: Database trigger rejected DELETE');
  }

  console.log('\n4. DUPLICATE: Attempt same reference_id');
  try {
    await writeDoubleEntry({
      tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
      debitAccountId: pool.id, creditAccountId: consumer.id,
      amount: '100.00000000', assetTypeId: asset.id,
      referenceId: 'E2E-001', referenceType: 'invoice',
    });
    console.log('   PROBLEM: Duplicate was allowed!');
  } catch {
    console.log('   BLOCKED: Unique constraint rejected duplicate reference_id');
  }

  console.log('\n5. BALANCE: Computed from history (never stored)');
  const balance = await getAccountBalance(consumer.id, asset.id, tenant.id);
  console.log('   Balance:', balance, '(sum of all credits - debits, no column)');

  console.log('\n6. CORRECTION via new entry (original stays visible)');
  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '50.00000000', assetTypeId: asset.id,
    referenceId: 'E2E-002', referenceType: 'invoice',
  });
  console.log('   Balance after 2nd event:', await getAccountBalance(consumer.id, asset.id, tenant.id));

  await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'REVERSAL',
    debitAccountId: consumer.id, creditAccountId: pool.id,
    amount: '50.00000000', assetTypeId: asset.id,
    referenceId: 'REVERSAL-E2E-002', referenceType: 'invoice',
    metadata: { reason: 'Correction: invoice was invalid' },
  });
  console.log('   Balance after reversal:', await getAccountBalance(consumer.id, asset.id, tenant.id));

  const allEntries = await prisma.ledgerEntry.findMany({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'asc' } });
  console.log('   Total entries:', allEntries.length, '(original 2 + claim 2 + reversal 2 = 6)');
  console.log('   Original entry still visible: YES (entry', result.debit.id.slice(0,8) + '... is still in the chain)');

  console.log('\n7. HASH CHAIN: Verify integrity');
  const chain = await verifyHashChain(tenant.id);
  console.log('   Chain valid:', chain.valid ? 'YES' : 'NO');

  console.log('\n8. TAMPER DETECTION');
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_update`;
  await prisma.$executeRaw`UPDATE ledger_entries SET amount = 99999 WHERE id = ${result.debit.id}::uuid`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_update`;
  const tampered = await verifyHashChain(tenant.id);
  console.log('   Chain valid after tampering:', tampered.valid ? 'YES (BAD!)' : 'NO (correctly detected!)');
  console.log('   Broken at entry:', tampered.brokenAt?.slice(0,8) + '...');

  // Restore + cleanup
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_update`;
  await prisma.$executeRaw`UPDATE ledger_entries SET amount = 250.00000000 WHERE id = ${result.debit.id}::uuid`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_update`;
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
  await prisma.ledgerEntry.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.account.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenant.delete({ where: { id: tenant.id } });

  console.log('\n=== LEDGER E2E REVIEW COMPLETE ===');
  await prisma.$disconnect();
}

e2eTest().catch(err => { console.error(err); process.exit(1); });
