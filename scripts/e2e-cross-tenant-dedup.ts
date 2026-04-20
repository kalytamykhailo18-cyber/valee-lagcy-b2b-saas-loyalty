/**
 * E2E: the same invoice photo cannot be credited to two different tenants.
 *
 * Before the fix, the image-hash dedup was scoped to tenantId. A user who
 * sent the same receipt image to Merchant A and then Merchant B got points
 * credited twice — one physical receipt, double credit. Real example:
 * PENDING-00004332 credited to both recon-store and valee-demo.
 *
 * Expected behavior after the fix:
 *   - First submission to tenant A → SUCCESS (pending_validation or claimed)
 *   - Same image to tenant B (different merchant) → REJECT cross-tenant
 *   - Same image to tenant A (same user) → REJECT "already submitted"
 *   - Same image to tenant A (different user) → REJECT "claimed by other"
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { validateInvoice } from '../src/services/invoice-validation.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function ensureTenant(slug: string, name: string) {
  let t = await prisma.tenant.findUnique({ where: { slug } });
  if (t) return t;
  t = await createTenant(name, slug, `${slug}@e2e.local`);
  await createSystemAccounts(t.id);
  const asset = await prisma.assetType.findFirst();
  if (asset) {
    await prisma.tenantAssetConfig.upsert({
      where: { tenantId_assetTypeId: { tenantId: t.id, assetTypeId: asset.id } },
      create: { tenantId: t.id, assetTypeId: asset.id, conversionRate: '1' },
      update: {},
    });
  }
  return t;
}

async function main() {
  const ts = Date.now();
  const tA = await ensureTenant(`dedup-a-${ts}`, `Dedup Test A ${ts}`);
  const tB = await ensureTenant(`dedup-b-${ts}`, `Dedup Test B ${ts}`);

  const asset = await prisma.assetType.findFirst();
  if (!asset) throw new Error('no asset type');

  const phoneAlice = `+19400${String(ts).slice(-7)}`;
  const phoneBob = `+19500${String(ts).slice(-7)}`;

  // Same receipt photo → same image buffer → same SHA-256 hash.
  const imageBuffer = Buffer.from(`fake-receipt-bytes-${ts}-AAAAAAAAAA`);

  // The extractedData short-circuits OCR/AI so the test doesn't depend on
  // external APIs. Each tenant sees the same synthetic invoice details.
  const invoiceNumber = `DEDUPE-${ts}`;
  const extractedData = {
    invoice_number: invoiceNumber,
    total_amount: 100,
    transaction_date: new Date().toISOString(),
    customer_phone: null,
    merchant_name: 'Dedup Test',
    merchant_rif: null,
    currency: 'USD' as const,
    document_type: 'fiscal_invoice' as const,
    confidence_score: 0.99,
  };
  const commonOcrText = `FACTURA\nTOTAL 100.00 USD\n${invoiceNumber}\n${ts}`;

  // Step 1: Alice submits to tenant A — expect success (pending_validation
  // because no CSV uploaded; status=success regardless).
  const r1 = await validateInvoice({
    tenantId: tA.id,
    senderPhone: phoneAlice,
    assetTypeId: asset.id,
    extractedData,
    ocrRawText: commonOcrText,
    imageBuffer,
  });
  await assert('first submit to tenant A succeeds', r1.success === true,
    `stage=${r1.stage} message="${r1.message?.slice(0, 60)}"`);

  // Step 2: Alice submits SAME image to tenant B — should reject cross-tenant.
  const r2 = await validateInvoice({
    tenantId: tB.id,
    senderPhone: phoneAlice,
    assetTypeId: asset.id,
    extractedData: { ...extractedData, invoice_number: `${invoiceNumber}-B` },
    ocrRawText: commonOcrText + '-B',
    imageBuffer,
  });
  await assert('cross-tenant submit rejected', r2.success === false && /otro comercio/i.test(r2.message),
    `stage=${r2.stage} message="${r2.message}"`);

  // Step 3: Alice re-submits SAME image to tenant A — "already submitted".
  const r3 = await validateInvoice({
    tenantId: tA.id,
    senderPhone: phoneAlice,
    assetTypeId: asset.id,
    extractedData,
    ocrRawText: commonOcrText,
    imageBuffer,
  });
  await assert('same-user same-tenant resubmit rejected', r3.success === false && /ya enviaste esta foto/i.test(r3.message),
    `message="${r3.message}"`);

  // Step 4: Bob (different user) submits same image to tenant A —
  // "claimed by other".
  await findOrCreateConsumerAccount(tA.id, phoneBob);
  const r4 = await validateInvoice({
    tenantId: tA.id,
    senderPhone: phoneBob,
    assetTypeId: asset.id,
    extractedData,
    ocrRawText: commonOcrText,
    imageBuffer,
  });
  await assert('different-user same-tenant rejected', r4.success === false && /otro cliente/i.test(r4.message),
    `message="${r4.message}"`);

  // Verify exactly ONE ledger INVOICE_CLAIMED credit exists for this hash globally.
  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
  const all = await prisma.ledgerEntry.findMany({
    where: {
      eventType: 'INVOICE_CLAIMED',
      entryType: 'CREDIT',
      metadata: { path: ['imageHash'], equals: hash },
    },
    select: { id: true, tenantId: true },
  });
  await assert('exactly one global credit for this image hash', all.length === 1,
    `found=${all.length} tenants=${[...new Set(all.map(e => e.tenantId))].length}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
