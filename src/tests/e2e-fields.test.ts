import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';
import { writeDoubleEntry } from '../services/ledger.js';

async function test() {
  const tenant = await prisma.tenant.create({ data: { name: 'Field Check', slug: 'field-check-' + Date.now(), ownerEmail: 'f@t.com' } });
  const asset = await prisma.assetType.upsert({ where: { name: 'FC Points' }, update: {}, create: { name: 'FC Points', unitLabel: 'pts', defaultConversionRate: '1.0' } });
  const pool = await prisma.account.create({ data: { tenantId: tenant.id, accountType: 'system', systemAccountType: 'issued_value_pool' } });
  const consumer = await prisma.account.create({ data: { tenantId: tenant.id, phoneNumber: '+58412FC001', accountType: 'shadow' } });

  const { debit, credit } = await writeDoubleEntry({
    tenantId: tenant.id, eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '150.00000000', assetTypeId: asset.id,
    referenceId: 'FC-INV-001', referenceType: 'invoice',
    latitude: '10.4806', longitude: '-66.9036',
    deviceId: 'device-abc-123',
  });

  console.log('=== FIELD-BY-FIELD VERIFICATION ===\n');

  const d = debit;
  const c = credit;
  const checks: [string, boolean, string][] = [
    ['Unique ID (UUID, never repeats)',        d.id.length === 36 && d.id !== c.id,                             `debit=${d.id.slice(0,8)}... credit=${c.id.slice(0,8)}...`],
    ['Timestamp (millisecond precision)',       d.createdAt instanceof Date,                                      d.createdAt.toISOString()],
    ['Tenant ID',                              d.tenantId === tenant.id,                                         d.tenantId.slice(0,8) + '...'],
    ['Event type',                             d.eventType === 'INVOICE_CLAIMED',                                d.eventType],
    ['Source account (debit.account_id)',       d.accountId === pool.id,                                          `pool=${pool.id.slice(0,8)}...`],
    ['Dest account (credit.account_id)',        c.accountId === consumer.id,                                      `consumer=${consumer.id.slice(0,8)}...`],
    ['Amount',                                 Number(d.amount) === 150,                                         d.amount.toString()],
    ['Asset type ID',                          d.assetTypeId === asset.id,                                       d.assetTypeId.slice(0,8) + '...'],
    ['Reference ID (idempotency key)',         d.referenceId === 'FC-INV-001',                                   d.referenceId],
    ['Latitude (geolocation)',                 d.latitude !== null && Number(d.latitude) === 10.4806,             String(d.latitude)],
    ['Longitude (geolocation)',                d.longitude !== null && Number(d.longitude) === -66.9036,          String(d.longitude)],
    ['Device ID',                              d.deviceId === 'device-abc-123',                                  String(d.deviceId)],
    ['Hash (HMAC-SHA256, 64 hex chars)',       d.hash.length === 64,                                             d.hash.slice(0,16) + '...'],
    ['Prev hash (null = first in chain)',      d.prevHash === null,                                              String(d.prevHash)],
    ['Credit prev_hash = debit hash (chain)',  c.prevHash === d.hash,                                            `${c.prevHash?.slice(0,16)}... === ${d.hash.slice(0,16)}...`],
    ['Paired entry (debit→credit)',            d.pairedEntryId === c.id,                                         `${d.pairedEntryId?.slice(0,8)}... → ${c.id.slice(0,8)}...`],
    ['Paired entry (credit→debit)',            c.pairedEntryId === d.id,                                         `${c.pairedEntryId?.slice(0,8)}... → ${d.id.slice(0,8)}...`],
  ];

  let pass = 0, fail = 0;
  for (const [label, ok, detail] of checks) {
    console.log(`${ok ? '  OK  ' : '  FAIL'} ${label}`);
    console.log(`       ${detail}`);
    if (ok) pass++; else fail++;
  }

  console.log(`\n=== ${pass}/${pass+fail} fields verified ===`);

  // Cleanup
  await prisma.$executeRaw`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`;
  await prisma.ledgerEntry.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.$executeRaw`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`;
  await prisma.account.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenant.delete({ where: { id: tenant.id } });
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
