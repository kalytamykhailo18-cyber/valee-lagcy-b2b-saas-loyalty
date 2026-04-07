/**
 * POS Webhook Service
 *
 * The "platform as API" approach: any merchant POS system can push transactions
 * directly to Valee at order-close time, eliminating the need for CSV uploads
 * or manual reconciliation.
 *
 * Two endpoints supported:
 * 1. Generic POS webhook — uses Valee's standard JSON schema. Any POS adapts to this.
 * 2. Fudo-specific connector — translates Fudo's ORDER-CLOSED webhook payload
 *    into Valee's internal format. Fudo is a popular cloud POS in LATAM.
 *
 * Both endpoints validate an HMAC signature against the per-tenant secret stored
 * on the tenant record (pos_webhook_secret or fudo_webhook_secret).
 */

import crypto from 'crypto';
import prisma from '../db/client.js';
import type { InvoiceSource } from '@prisma/client';

// ============================================================
// Standard Valee POS payload (the "platform as API" contract)
// ============================================================

export interface ValeePosPayload {
  invoice_number: string;
  amount: number;
  currency?: 'bs' | 'usd' | 'eur';
  transaction_date: string; // ISO 8601
  customer_phone?: string | null;
  branch_id?: string | null;
  items?: Array<{ name: string; quantity: number; unit_price: number }>;
}

// ============================================================
// Fudo's ORDER-CLOSED webhook payload (subset we care about)
// ============================================================

export interface FudoOrderClosedPayload {
  event: 'order.closed' | 'ORDER_CLOSED' | string;
  data: {
    id: string | number;
    code?: string;            // Fudo's customer-facing order code
    total: number;
    closedAt?: string;
    customer?: {
      phone?: string;
      cellphone?: string;
    };
    items?: Array<{
      name: string;
      quantity: number;
      price: number;
    }>;
    branch?: {
      id?: string;
      name?: string;
    };
  };
}

/**
 * Verify an HMAC-SHA256 signature on a webhook body.
 * Most POS providers send the signature in the X-Signature or X-Hub-Signature header.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  // Strip optional "sha256=" prefix
  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Insert a webhook-sourced invoice into the system. Returns the created
 * invoice record or null if it was a duplicate (silently skipped).
 */
export async function ingestWebhookInvoice(params: {
  tenantId: string;
  source: InvoiceSource;
  invoiceNumber: string;
  amount: number;
  customerPhone: string | null;
  transactionDate: Date | null;
  branchId: string | null;
  items?: Array<{ name: string; quantity: number; unit_price: number }>;
  rawPayload: any;
}): Promise<{ created: boolean; invoiceId: string | null }> {
  // Idempotency: skip if (tenantId, invoiceNumber) already exists
  const existing = await prisma.invoice.findUnique({
    where: { tenantId_invoiceNumber: { tenantId: params.tenantId, invoiceNumber: params.invoiceNumber } },
  });
  if (existing) {
    return { created: false, invoiceId: existing.id };
  }

  const created = await prisma.invoice.create({
    data: {
      tenantId: params.tenantId,
      invoiceNumber: params.invoiceNumber,
      amount: params.amount.toString(),
      customerPhone: params.customerPhone,
      transactionDate: params.transactionDate,
      branchId: params.branchId,
      status: 'available',
      source: params.source,
      orderDetails: params.items ? { items: params.items, ingestedAt: new Date().toISOString() } : undefined,
      extractedData: { source_payload: params.rawPayload },
    },
  });

  return { created: true, invoiceId: created.id };
}

/**
 * Translate a Fudo ORDER-CLOSED payload into Valee's internal format.
 */
export function translateFudoPayload(payload: FudoOrderClosedPayload): {
  invoiceNumber: string;
  amount: number;
  customerPhone: string | null;
  transactionDate: Date | null;
  items: Array<{ name: string; quantity: number; unit_price: number }>;
  externalBranchId: string | null;
} {
  const data = payload.data || ({} as FudoOrderClosedPayload['data']);
  const invoiceNumber = String(data.code || data.id || '');
  const amount = Number(data.total || 0);
  const phone = data.customer?.phone || data.customer?.cellphone || null;
  const date = data.closedAt ? new Date(data.closedAt) : null;
  const items = (data.items || []).map((it) => ({
    name: it.name,
    quantity: it.quantity,
    unit_price: it.price,
  }));
  return {
    invoiceNumber,
    amount,
    customerPhone: phone,
    transactionDate: date,
    items,
    externalBranchId: data.branch?.id || null,
  };
}
