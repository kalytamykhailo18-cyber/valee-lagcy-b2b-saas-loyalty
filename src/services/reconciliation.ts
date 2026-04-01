import prisma from '../db/client.js';
import { writeDoubleEntry, getAccountBalance } from './ledger.js';
import { getSystemAccount } from './accounts.js';
import { convertToLoyaltyValue } from './assets.js';

/**
 * Reconciliation worker: picks up all pending_validation invoices
 * and attempts to match them against uploaded CSV data.
 */
export async function runReconciliation(): Promise<{
  confirmed: number;
  reversed: number;
  stillPending: number;
}> {
  const windowHours = parseInt(process.env.RECONCILIATION_WINDOW_HOURS || '24');
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const pendingInvoices = await prisma.invoice.findMany({
    where: { status: 'pending_validation' },
  });

  let confirmed = 0;
  let reversed = 0;
  let stillPending = 0;

  for (const pending of pendingInvoices) {
    // Look for a matching CSV-uploaded invoice with the same invoice number.
    // The CSV upload may have skipped this invoice (ON CONFLICT DO NOTHING)
    // because the photo_submission record already exists. So we also check
    // if the invoice number appears in any completed upload batch's loaded invoices.
    let csvInvoice = await prisma.invoice.findFirst({
      where: {
        tenantId: pending.tenantId,
        invoiceNumber: pending.invoiceNumber,
        source: 'csv_upload',
        status: 'available',
      },
    });

    // If not found as a separate record, check if a completed upload batch
    // for this tenant was uploaded after the pending invoice and had skipped rows
    // (meaning the CSV contained this invoice but it was skipped because the
    // photo_submission record already holds the invoice_number).
    if (!csvInvoice) {
      const recentBatch = await prisma.uploadBatch.findFirst({
        where: {
          tenantId: pending.tenantId,
          status: 'completed',
          completedAt: { gte: pending.createdAt },
          rowsSkipped: { gt: 0 },
        },
        orderBy: { completedAt: 'desc' },
      });

      if (recentBatch) {
        // Verify: the batch skipped at least one row AND there's no separate
        // csv_upload invoice for this number (meaning our pending invoice was the skip)
        const existsSeparate = await prisma.invoice.findFirst({
          where: {
            tenantId: pending.tenantId,
            invoiceNumber: pending.invoiceNumber,
            source: 'csv_upload',
          },
        });
        // If no separate CSV record exists, the skip was our invoice
        if (!existsSeparate) {
          csvInvoice = pending as any;
        }
      }
    }

    if (csvInvoice) {
      // Match found — confirm
      const tolerance = parseFloat(process.env.INVOICE_AMOUNT_TOLERANCE || '0.05');
      const amountDiff = Math.abs(Number(csvInvoice.amount) - Number(pending.amount));

      if (amountDiff <= tolerance * Number(pending.amount)) {
        // Confirm: mark the pending invoice as claimed
        await prisma.invoice.update({
          where: { id: pending.id },
          data: { status: 'claimed' },
        });

        // If there's a separate CSV invoice record, mark it too
        if (csvInvoice && csvInvoice.id !== pending.id) {
          await prisma.invoice.update({
            where: { id: csvInvoice.id },
            data: {
              status: 'claimed',
              consumerAccountId: pending.consumerAccountId,
              ledgerEntryId: pending.ledgerEntryId,
            },
          });
        }

        confirmed++;
      } else {
        // Amount mismatch — flag for manual review
        await prisma.invoice.update({
          where: { id: pending.id },
          data: { status: 'manual_review', rejectionReason: `Amount mismatch: submitted $${pending.amount}, CSV has $${csvInvoice.amount}` },
        });
        stillPending++;
      }
    } else if (pending.createdAt < cutoff) {
      // Time window expired — reverse the provisional credit
      if (pending.consumerAccountId && pending.ledgerEntryId) {
        const poolAccount = await getSystemAccount(pending.tenantId, 'issued_value_pool');
        if (poolAccount) {
          // Get asset type from the original ledger entry
          const originalEntry = await prisma.ledgerEntry.findUnique({
            where: { id: pending.ledgerEntryId },
          });

          if (originalEntry) {
            await writeDoubleEntry({
              tenantId: pending.tenantId,
              eventType: 'REVERSAL',
              debitAccountId: pending.consumerAccountId,
              creditAccountId: poolAccount.id,
              amount: originalEntry.amount.toString(),
              assetTypeId: originalEntry.assetTypeId,
              referenceId: `REVERSAL-${pending.invoiceNumber}`,
              referenceType: 'invoice',
              status: 'confirmed',
              metadata: { originalInvoice: pending.invoiceNumber, reason: 'Reconciliation window expired' },
            });
          }
        }
      }

      await prisma.invoice.update({
        where: { id: pending.id },
        data: { status: 'rejected', rejectionReason: 'Invoice could not be verified within the allowed time window' },
      });

      reversed++;
    } else {
      // Still within window — keep waiting
      stillPending++;
    }
  }

  return { confirmed, reversed, stillPending };
}

/**
 * Manual review: approve or reject a pending invoice.
 */
export async function resolveManualReview(params: {
  invoiceId: string;
  action: 'approve' | 'reject';
  reason: string;
  resolverType: 'staff' | 'admin';
  resolverId: string;
}): Promise<{ success: boolean; message: string }> {
  const invoice = await prisma.invoice.findUnique({ where: { id: params.invoiceId } });

  if (!invoice) return { success: false, message: 'Invoice not found' };
  if (invoice.status !== 'manual_review' && invoice.status !== 'pending_validation') {
    return { success: false, message: `Invoice is in status '${invoice.status}', not reviewable` };
  }

  if (params.action === 'approve') {
    await prisma.invoice.update({
      where: { id: params.invoiceId },
      data: { status: 'claimed' },
    });
    return { success: true, message: 'Invoice approved and confirmed' };
  } else {
    // Reject: reverse any provisional credit
    if (invoice.consumerAccountId && invoice.ledgerEntryId) {
      const poolAccount = await getSystemAccount(invoice.tenantId, 'issued_value_pool');
      const originalEntry = await prisma.ledgerEntry.findUnique({
        where: { id: invoice.ledgerEntryId },
      });

      if (poolAccount && originalEntry) {
        await writeDoubleEntry({
          tenantId: invoice.tenantId,
          eventType: 'REVERSAL',
          debitAccountId: invoice.consumerAccountId,
          creditAccountId: poolAccount.id,
          amount: originalEntry.amount.toString(),
          assetTypeId: originalEntry.assetTypeId,
          referenceId: `REJECT-${invoice.invoiceNumber}`,
          referenceType: 'invoice',
          metadata: { reason: params.reason, resolvedBy: params.resolverId },
        });
      }
    }

    await prisma.invoice.update({
      where: { id: params.invoiceId },
      data: { status: 'rejected', rejectionReason: params.reason },
    });

    return { success: true, message: 'Invoice rejected and provisional credit reversed' };
  }
}
