import prisma from '../db/client.js';
import { normalizeVenezuelanPhone } from './accounts.js';

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

  let lines = csvContent.split(/\r?\n/).filter(l => l.trim() !== '');

  // Recover from the 'pasted from WhatsApp' case where newlines got
  // collapsed to spaces: 'header,cols value1,value2 value3,value4'.
  // If there's only one 'line' but it has way more commas than a
  // single-row CSV should have, treat the whole thing as one big stream
  // of comma-separated tokens and batch them into rows of N where N is
  // the header column count (detected after this step). Without this
  // the frontend showed a generic 'client-side exception' because the
  // upload returned rowsLoaded=0 with an unhelpful 'no data rows'.
  if (lines.length === 1) {
    const raw = lines[0];
    const allTokens = raw.split(/\s+/).filter(t => t.length > 0);
    if (allTokens.length >= 2 && allTokens[0].includes(',')) {
      // First whitespace-separated chunk is the header; rest are rows.
      const header = allTokens[0];
      const rows = allTokens.slice(1);
      // Each non-empty row should have the same comma count as the header.
      const headerCols = header.split(',').length;
      const rowCommaCountsOk = rows.every(r => r.split(',').length === headerCols);
      if (rowCommaCountsOk && rows.length > 0) {
        lines = [header, ...rows];
      }
    }
  }

  // Header-less paste recovery (Genesis H5 Re Do). A merchant who pastes
  // just data rows without the header line — e.g.
  //   12345, 50, 2026-04-20, 584161972695
  // — used to get a cryptic "CSV has no data rows" error. If the first row
  // doesn't contain any recognized column header, assume the canonical
  // column order (invoice_number, total, date, phone) and synthesize a
  // header line. The merchant documentation uses this order.
  const DEFAULT_HEADER = 'invoice_number,total,date,phone';
  if (lines.length >= 1) {
    const firstRow = parseCSVLine(lines[0]);
    const looksLikeHeader =
      findColumnKey(firstRow, INVOICE_NUMBER_KEYS) !== -1
      || findColumnKey(firstRow, AMOUNT_KEYS) !== -1;
    const allRowsSameWidth = lines.every(l => parseCSVLine(l).length === firstRow.length);
    if (!looksLikeHeader && allRowsSameWidth && firstRow.length >= 2 && firstRow.length <= 4) {
      lines = [DEFAULT_HEADER, ...lines];
    }
  }

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
  // No asset/pool lookup here — the CSV no longer writes ledger entries.
  // Points credit exclusively via the consumer photo flow (Genesis H6).

  // Per-row caps. AMOUNT_MAX defaults to the equivalent of 10M Bs at a
  // reasonable exchange rate; anything above is almost certainly a bad row
  // (missing decimal, extra zero). Can be raised by the tenant via env if a
  // merchant legitimately sells high-ticket items.
  const AMOUNT_MAX = parseFloat(process.env.CSV_AMOUNT_MAX || '50000000');
  const INVOICE_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{2,63}$/;
  // Minimum digit count per invoice number. Venezuelan fiscal invoice
  // numbers (Control numbers) are typically 8 digits; foreign formats can
  // be shorter. 4 is a conservative floor that rejects obvious garbage
  // like '13245' (5 chars / 5 digits — marginal but allowed) while still
  // letting international formats through. Genesis called out the fact
  // that bogus numbers like G12345610, o123456789, 12345610 were all
  // passing the previous regex (items image 4 on Notion).
  const INVOICE_MIN_DIGITS = parseInt(process.env.CSV_INVOICE_MIN_DIGITS || '4');

  /** Detect obvious ascending/descending sequential digit patterns.
   *  Matches the full digit string directly (0123456789, 9876543210).
   *  Doesn't scan sub-windows because short embedded sequential runs
   *  are common in legit phone numbers (e.g. +34612345678). */
  const isSequentialPlaceholder = (s: string): boolean => {
    const digits = s.replace(/\D/g, '');
    if (digits.length < 4) return false;
    const ascending = '01234567890123456789';
    const descending = '98765432109876543210';
    return ascending.includes(digits) || descending.includes(digits);
  };

  /** Detect repeated-digit placeholders. Whole-string (11111111) or a
   *  long embedded run (5811111111111 has '1'x10 after country prefix). */
  const isRepeatedDigitPlaceholder = (s: string): boolean => {
    const digits = s.replace(/\D/g, '');
    if (digits.length < 5) return false;
    if (/^(\d)\1+$/.test(digits)) return true;
    if (/(\d)\1{6,}/.test(digits)) return true;
    return false;
  };

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    try {
      const invoiceNumber = (fields[invoiceCol] || '').trim();
      const amountStr = (fields[amountCol] || '').trim();

      if (!invoiceNumber || !amountStr) {
        rowsErrored++;
        errorDetails.push({ row: i + 1, reason: 'Missing invoice number or amount' });
        continue;
      }

      // Invoice number: reject garbage like 'XX' or '12' or values with
      // suspicious characters. Pattern: starts alphanumeric, 3-64 chars
      // total, only A-Z/0-9/._-/ in body. Genesis showed CSVs with
      // '123456789' and similar trivially-typeable values that still
      // passed — at least enforce it's non-trivial.
      if (!INVOICE_NUMBER_RE.test(invoiceNumber)) {
        rowsErrored++;
        errorDetails.push({
          row: i + 1,
          reason: `Invoice number invalid: must be 3-64 alphanumeric characters (got '${invoiceNumber.slice(0, 40)}')`,
        });
        continue;
      }
      // Digit-count minimum. A real invoice number has enough digits to
      // be unique; anything with fewer than INVOICE_MIN_DIGITS digits is
      // almost certainly a test string.
      const invoiceDigitCount = (invoiceNumber.match(/\d/g) || []).length;
      if (invoiceDigitCount < INVOICE_MIN_DIGITS) {
        rowsErrored++;
        errorDetails.push({
          row: i + 1,
          reason: `Invoice number '${invoiceNumber}' has too few digits (minimum ${INVOICE_MIN_DIGITS}).`,
        });
        continue;
      }
      if (isSequentialPlaceholder(invoiceNumber)) {
        rowsErrored++;
        errorDetails.push({
          row: i + 1,
          reason: `Invoice number '${invoiceNumber}' looks like a sequential placeholder (0123456789, etc).`,
        });
        continue;
      }
      if (isRepeatedDigitPlaceholder(invoiceNumber)) {
        rowsErrored++;
        errorDetails.push({
          row: i + 1,
          reason: `Invoice number '${invoiceNumber}' is a repeated-digit placeholder (1111111, etc).`,
        });
        continue;
      }

      const amount = parseFloat(amountStr.replace(/[^0-9.\-]/g, ''));
      if (isNaN(amount)) {
        rowsErrored++;
        errorDetails.push({ row: i + 1, reason: `Invalid amount: ${amountStr}` });
        continue;
      }
      if (amount <= 0) {
        rowsErrored++;
        errorDetails.push({ row: i + 1, reason: `Amount must be positive (got ${amount})` });
        continue;
      }
      if (amount > AMOUNT_MAX) {
        rowsErrored++;
        errorDetails.push({
          row: i + 1,
          reason: `Amount exceeds per-row cap (${amount} > ${AMOUNT_MAX}). Check for misplaced decimal.`,
        });
        continue;
      }

      let transactionDate: Date | null = null;
      if (dateCol !== -1 && fields[dateCol]) {
        const raw = fields[dateCol].trim();
        const parsed = new Date(raw);
        if (isNaN(parsed.getTime())) {
          rowsErrored++;
          errorDetails.push({ row: i + 1, reason: `Unparseable date: '${raw}'` });
          continue;
        }
        transactionDate = parsed;
      }

      let customerPhone: string | null = null;
      if (phoneCol !== -1 && fields[phoneCol]) {
        const raw = fields[phoneCol].trim();
        const rawDigits = raw.replace(/\D/g, '');
        const normalized = normalizeVenezuelanPhone(raw);
        const digits = normalized.replace(/\D/g, '');
        // 10-15 digit range covers Venezuelan local (10) through any
        // international format (up to 15 per E.164 max). Shorter = not
        // a phone; longer = malformed input.
        if (digits.length < 10 || digits.length > 15) {
          rowsErrored++;
          errorDetails.push({
            row: i + 1,
            reason: `Invalid phone number: '${raw}' (need 10-15 digits)`,
          });
          continue;
        }
        // Reject obvious placeholder phones. Check the RAW digit string
        // too because normalization may prepend country codes that break
        // the pattern detection (e.g. '0123456789' becomes '+10123456789'
        // and the whole-string sequential check stops matching).
        if (isRepeatedDigitPlaceholder(digits) || isRepeatedDigitPlaceholder(rawDigits)) {
          rowsErrored++;
          errorDetails.push({
            row: i + 1,
            reason: `Phone '${raw}' looks like a placeholder (repeated digits).`,
          });
          continue;
        }
        if (isSequentialPlaceholder(digits) || isSequentialPlaceholder(rawDigits)) {
          rowsErrored++;
          errorDetails.push({
            row: i + 1,
            reason: `Phone '${raw}' looks like a placeholder (sequential digits).`,
          });
          continue;
        }
        customerPhone = raw;
      }

      // Guard: a transaction dated in the future is always wrong (bulk CSVs
      // from POS systems can leak bad dates, or a malicious merchant could
      // pre-load "future" facturas to farm points). Allow a 24h grace window
      // so timezone edges don't reject same-day uploads.
      if (transactionDate) {
        const graceMs = 24 * 60 * 60 * 1000;
        if (transactionDate.getTime() > Date.now() + graceMs) {
          rowsErrored++;
          errorDetails.push({
            row: i + 1,
            reason: `Transaction date is in the future: ${transactionDate.toISOString().slice(0, 10)}`,
          });
          continue;
        }
      }

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
          // Referral bonus: the referee's first confirmed transaction is the
          // trigger to credit the referrer. Stage D handles this for direct
          // INVOICE_CLAIMED; the pending → CSV reconciliation path was missing
          // it, so referrals stayed pending forever when the factura was
          // submitted before the CSV.
          if (existingPending.consumerAccountId && existingPending.ledgerEntryId) {
            const originalEntry = await prisma.ledgerEntry.findUnique({
              where: { id: existingPending.ledgerEntryId },
              select: { assetTypeId: true },
            });
            if (originalEntry) {
              try {
                const { tryCreditReferral } = await import('./referrals.js');
                await tryCreditReferral({
                  tenantId: existingPending.tenantId,
                  refereeAccountId: existingPending.consumerAccountId,
                  assetTypeId: originalEntry.assetTypeId,
                });
              } catch (err) {
                console.error('[Referral] credit failed on CSV reconcile', err);
              }
            }
          }
        }
        rowsSkipped++; // Still count as skipped (no new record created)
        continue;
      }

      // CSV rows always land as 'available'. Points credit ONLY when the
      // consumer sends the invoice photo and Stage C of the validation
      // pipeline matches it against this row (Genesis H6). The previous
      // auto-credit path let merchants invent an invoice_number + phone,
      // hit upload, and silently credit points to a stranger — which is
      // exactly what Genesis pasted into the CSV test (bogus factura
      // '12323131231' for Bs 10.5M credited on the spot). The CSV is a
      // ledger of 'expected' receipts, not a crediting mechanism.
      const result = await prisma.$executeRaw`
        INSERT INTO invoices (id, tenant_id, invoice_number, amount, transaction_date, customer_phone, status, source, upload_batch_id, created_at, updated_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${invoiceNumber}, ${amount}, ${transactionDate}::timestamptz, ${customerPhone}, 'available'::"InvoiceStatus", 'csv_upload', ${batch.id}::uuid, now(), now())
        ON CONFLICT (tenant_id, invoice_number) DO NOTHING
      `;

      if (result > 0) {
        rowsLoaded++;
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
