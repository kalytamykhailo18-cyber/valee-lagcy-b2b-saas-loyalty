/**
 * E2E: /api/merchant/transactions derives effective_status=confirmed
 * for INVOICE_CLAIMED rows whose invoice was reconciled via CSV.
 *
 * Eric 2026-04-22: "En la parte del CSV si hace el cambio automatico
 * despues de que se valida con el CSV (pasa a Canjeada). Pero en
 * movimientos desde el dashboard siguen quedando en provisional."
 * The ledger is append-only so the row stays raw status=provisional
 * forever. We already derive the effective status in the consumer
 * history and balance breakdown; this test locks in the same
 * derivation on the merchant /transactions endpoint so a reconciled
 * invoice shows "Confirmado" in the dashboard movimientos.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry } from '../src/services/ledger.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function http(path: string, token: string) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function main() {
  console.log('=== Merchant movements effective-status E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Movs ${ts}`, `movs-${ts}`, `movs-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const token = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  const phone = `+58414${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;

  // Simulate the photo-first flow: consumer submits an invoice photo,
  // service writes a provisional INVOICE_CLAIMED linked via PENDING-<invNum>.
  const invNum = `INV-${ts}`;
  await prisma.invoice.create({
    data: {
      tenantId: tenant.id, invoiceNumber: invNum, amount: '500',
      status: 'pending_validation', source: 'photo_submission',
      consumerAccountId: consumer.id,
    },
  });
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '500', assetTypeId: asset.id,
    referenceId: `PENDING-${invNum}`,
    referenceType: 'invoice',
    status: 'provisional',
    metadata: { invoiceNumber: invNum, type: 'photo_pending' },
  });

  // BEFORE reconciliation — transactions endpoint should report provisional.
  const preRes = await http(`/api/merchant/transactions?eventType=INVOICE_CLAIMED&limit=20`, token);
  const preRow = preRes.entries.find((e: any) => e.referenceId === `PENDING-${invNum}`);
  await assert('before reconcile: invoice shows as provisional',
    preRow?.status === 'provisional',
    `status=${preRow?.status}`);

  // Simulate CSV reconciliation: invoice flips to claimed.
  await prisma.invoice.update({
    where: { tenantId_invoiceNumber: { tenantId: tenant.id, invoiceNumber: invNum } },
    data: { status: 'claimed' },
  });

  // AFTER reconciliation — same row now shows effective status=confirmed
  // even though the raw ledger row is still provisional.
  const postRes = await http(`/api/merchant/transactions?eventType=INVOICE_CLAIMED&limit=20`, token);
  const postRow = postRes.entries.find((e: any) => e.referenceId === `PENDING-${invNum}`);
  await assert('after reconcile: invoice shows as confirmed',
    postRow?.status === 'confirmed',
    `status=${postRow?.status}`);

  // Raw DB row is still provisional (ledger is append-only).
  const rawRow = await prisma.ledgerEntry.findFirst({
    where: { tenantId: tenant.id, referenceId: `PENDING-${invNum}`, entryType: 'CREDIT' },
    select: { status: true },
  });
  await assert('raw ledger row stays provisional (immutability)',
    rawRow?.status === 'provisional',
    `status=${rawRow?.status}`);

  // An unrelated provisional row with no claimed invoice stays provisional
  const otherInvNum = `INV-OTHER-${ts}`;
  await prisma.invoice.create({
    data: {
      tenantId: tenant.id, invoiceNumber: otherInvNum, amount: '300',
      status: 'pending_validation', source: 'photo_submission',
      consumerAccountId: consumer.id,
    },
  });
  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'INVOICE_CLAIMED',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '300', assetTypeId: asset.id,
    referenceId: `PENDING-${otherInvNum}`,
    referenceType: 'invoice',
    status: 'provisional',
    metadata: { invoiceNumber: otherInvNum, type: 'photo_pending' },
  });
  const mixRes = await http(`/api/merchant/transactions?eventType=INVOICE_CLAIMED&limit=20`, token);
  const mixRow = mixRes.entries.find((e: any) => e.referenceId === `PENDING-${otherInvNum}`);
  await assert('unreconciled invoice still shows as provisional',
    mixRow?.status === 'provisional',
    `status=${mixRow?.status}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
