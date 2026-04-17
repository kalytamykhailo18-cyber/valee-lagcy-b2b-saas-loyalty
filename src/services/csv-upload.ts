import prisma from '../db/client.js';
import { findOrCreateConsumerAccount, normalizeVenezuelanPhone } from './accounts.js';
import { writeDoubleEntry } from './ledger.js';
import { getSystemAccount } from './accounts.js';
import { convertToLoyaltyValue } from './assets.js';

export interface UploadResult {
  batchId: string;
  status: string;
  rowsLoaded: number;
  rowsSkipped: number;
  rowsErrored: number;
  rowsAutoCredited: number;
  errorDetails: Array<{ row: number; reason: string }>;
}

const INVOICE_NUMBER_KEYS = [
  'invoice_number', 'invoice_id', 'order_id', 'order_number',
  'factura_id', 'factura_numero', 'numero_factura', 'num_factura',
  'receipt_id', 'receipt_number', 'id', 'numero', 'nro',
];
const AMOUNT_KEYS = [
  'amount', 'total', 'total_amount', 'monto', 'monto_total',
  'valor', 'price', 'subtotal', 'grand_total',
];
const DATE_KEYS = [
  'date', 'transaction_date', 'fecha', 'fecha_transaccion',
  'created_at', 'timestamp', 'order_date',
];
const PHONE_KEYS = [
  'phone', 'phone_number', 'customer_phone', 'telefono',
  'tel', 'celular', 'mobile', 'numero_telefono',
];

function findColumnKey(headers: string[], candidates: string[]): number {
  const normalized = headers.map(h => h.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_'));
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

export async function processCSV(
  csvContent: string,
  tenantId: string,
  staffId: string
): Promise<UploadResult> {
  const batch = await prisma.uploadBatch.create({
    data: { tenantId, filename: 'csv_upload', status: 'processing', uploadedByStaffId: staffId },
  });

  const lines = csvContent.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) {
    const errorDetails = [{ row: 0, reason: 'CSV has no data rows' }];
    await prisma.uploadBatch.update({
      where: { id: batch.id },
      data: { status: 'failed', rowsLoaded: 0, rowsSkipped: 0, rowsErrored: 0, errorDetails, completedAt: new Date() },
    });
    return { batchId: batch.id, status: 'failed', rowsLoaded: 0, rowsSkipped: 0, rowsErrored: 0, rowsAutoCredited: 0, errorDetails };
  }

  const headers = parseCSVLine(lines[0]);
  const invoiceCol = findColumnKey(headers, INVOICE_NUMBER_KEYS);
  const amountCol = findColumnKey(headers, AMOUNT_KEYS);
  const dateCol = findColumnKey(headers, DATE_KEYS);
  const phoneCol = findColumnKey(headers, PHONE_KEYS);

  if (invoiceCol === -1 || amountCol === -1) {
    const errorDetails = [{ row: 0, reason: 'Required columns not found: need invoice number and amount columns' }];
    await prisma.uploadBatch.update({
      where: { id: batch.id },
      data: { status: 'failed', rowsLoaded: 0, rowsSkipped: 0, rowsErrored: 0, errorDetails, completedAt: new Date() },
    });
    return { batchId: batch.id, status: 'failed', rowsLoaded: 0, rowsSkipped: 0, rowsErrored: 0, rowsAutoCredited: 0, errorDetails };
  }

  let rowsLoaded = 0;
  let rowsSkipped = 0;
  let rowsErrored = 0;
  let rowsAutoCredited = 0;
  const errorDetails: Array<{ row: number; reason: string }> = [];

  // Look up the merchant's primary asset type once — we'll reuse it to credit
  // consumers whose phone is attached to a CSV row.
  const assetConfig = await prisma.tenantAssetConfig.findFirst({ where: { tenantId } });
  const assetType = assetConfig
    ? await prisma.assetType.findUnique({ where: { id: assetConfig.assetTypeId } })
    : await prisma.assetType.findFirst();
  const poolAccount = assetType ? await getSystemAccount(tenantId, 'issued_value_pool') : null;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    try {
      const invoiceNumber = fields[invoiceCol];
      const amountStr = fields[amountCol];

      if (!invoiceNumber || !amountStr) {
        rowsErrored++;
        errorDetails.push({ row: i + 1, reason: 'Missing invoice number or amount' });
        continue;
      }

      const amount = parseFloat(amountStr.replace(/[^0-9.\-]/g, ''));
      if (isNaN(amount)) {
        rowsErrored++;
        errorDetails.push({ row: i + 1, reason: `Invalid amount: ${amountStr}` });
        continue;
      }

      const transactionDate = dateCol !== -1 && fields[dateCol] ? new Date(fields[dateCol]) : null;
      const customerPhone = phoneCol !== -1 && fields[phoneCol] ? fields[phoneCol] : null;

      // Check if a pending_validation invoice already exists for this number
      // (consumer submitted photo before CSV was uploaded — reconciliation case)
      const existingPending = await prisma.invoice.findFirst({
        where: { tenantId, invoiceNumber, status: 'pending_validation' },
      });

      if (existingPending) {
        // Confirm the pending invoice — the CSV proves it's real
        const tolerance = parseFloat(process.env.INVOICE_AMOUNT_TOLERANCE || '0.05');
        const amountDiff = Math.abs(Number(existingPending.amount) - amount);
        if (amountDiff <= tolerance * amount) {
          await prisma.invoice.update({
            where: { id: existingPending.id },
            data: { status: 'claimed' },
          });
        }
        rowsSkipped++; // Still count as skipped (no new record created)
        continue;
      }

      // When the CSV row carries the customer's phone, the merchant is
      // attesting the purchase belongs to that customer. Credit the points
      // immediately as CONFIRMED (status 'claimed') instead of waiting for the
      // consumer to submit a photo — that's what the merchant expects when
      // they put a phone in the row.
      const initialStatus = customerPhone ? 'claimed' : 'available';

      const result = await prisma.$executeRaw`
        INSERT INTO invoices (id, tenant_id, invoice_number, amount, transaction_date, customer_phone, status, source, upload_batch_id, created_at, updated_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${invoiceNumber}, ${amount}, ${transactionDate}::timestamptz, ${customerPhone}, ${initialStatus}::"InvoiceStatus", 'csv_upload', ${batch.id}::uuid, now(), now())
        ON CONFLICT (tenant_id, invoice_number) DO NOTHING
      `;

      if (result > 0) {
        rowsLoaded++;

        // Auto-credit the consumer for this invoice.
        if (customerPhone && assetType && poolAccount) {
          try {
            const normalized = normalizeVenezuelanPhone(customerPhone);
            const { account } = await findOrCreateConsumerAccount(tenantId, normalized);
            const loyaltyValue = await convertToLoyaltyValue(
              String(amount),
              tenantId,
              assetType.id,
              transactionDate || undefined,
              'bs', // CSV amounts are raw Bs — normalize through exchange rate
            );
            await writeDoubleEntry({
              tenantId,
              eventType: 'INVOICE_CLAIMED',
              debitAccountId: poolAccount.id,
              creditAccountId: account.id,
              amount: loyaltyValue,
              assetTypeId: assetType.id,
              referenceId: `CSV-${batch.id}:${invoiceNumber}`,
              referenceType: 'invoice',
              metadata: {
                invoiceNumber,
                invoiceAmount: amount,
                source: 'csv_auto_credit',
                uploadBatchId: batch.id,
              },
            });
            // Link the invoice row to the consumer account so the customer
            // lookup can find it under Facturas. Without this the invoice is
            // loaded but appears orphaned in the merchant dashboard.
            await prisma.$executeRaw`
              UPDATE invoices SET consumer_account_id=${account.id}::uuid
              WHERE tenant_id=${tenantId}::uuid AND invoice_number=${invoiceNumber}
            `;
            rowsAutoCredited++;
          } catch (creditErr) {
            // Don't fail the whole row if credit fails — the invoice is still
            // loaded, just revert its status so the consumer can submit manually.
            await prisma.$executeRaw`
              UPDATE invoices SET status='available' WHERE tenant_id=${tenantId}::uuid AND invoice_number=${invoiceNumber}
            `;
            errorDetails.push({ row: i + 1, reason: `Auto-credit failed: ${(creditErr as Error).message}` });
          }
        }
      } else {
        rowsSkipped++;
      }
    } catch (err) {
      rowsErrored++;
      errorDetails.push({ row: i + 1, reason: `Parse error: ${(err as Error).message}` });
    }
  }

  await prisma.uploadBatch.update({
    where: { id: batch.id },
    data: { status: 'completed', rowsLoaded, rowsSkipped, rowsErrored, errorDetails, completedAt: new Date() },
  });

  return { batchId: batch.id, status: 'completed', rowsLoaded, rowsSkipped, rowsErrored, rowsAutoCredited, errorDetails };
}
