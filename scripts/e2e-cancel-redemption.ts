/**
 * E2E: consumer can cancel a pending redemption QR and get their
 * points back instantly (Genesis L2).
 *
 * Flow:
 *  1. Fund a consumer, create a product, redeem it → PENDING -10.
 *  2. POST /api/consumer/redemption/:tokenId/cancel
 *  3. Assert: token.status = 'expired', a REDEMPTION_EXPIRED credit
 *     lands on the consumer with metadata.cancelledByConsumer=true,
 *     and the consumer's balance is restored.
 *  4. Cancel twice → second call 409 (already cancelled).
 *  5. Chunk-grep /my-codes for the new button text.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts, findOrCreateConsumerAccount, getSystemAccount } from '../src/services/accounts.js';
import { writeDoubleEntry, getAccountBalance } from '../src/services/ledger.js';
import { issueConsumerTokens } from '../src/services/auth.js';

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== Consumer redemption cancel E2E ===\n');

  const ts = Date.now();
  const asset = await prisma.assetType.findFirstOrThrow();
  const tenant = await createTenant(`Cancel Redemption ${ts}`, `cancel-${ts}`, `cancel-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenantAssetConfig.create({
    data: { tenantId: tenant.id, assetTypeId: asset.id, conversionRate: 1 },
  });
  const pool = (await getSystemAccount(tenant.id, 'issued_value_pool'))!;

  const phone = `+19000${String(ts).slice(-7)}`;
  const { account: consumer } = await findOrCreateConsumerAccount(tenant.id, phone);

  await writeDoubleEntry({
    tenantId: tenant.id,
    eventType: 'ADJUSTMENT_MANUAL',
    debitAccountId: pool.id, creditAccountId: consumer.id,
    amount: '100', assetTypeId: asset.id,
    referenceId: `SEED-${ts}`, referenceType: 'manual_adjustment',
    metadata: { type: 'test_fund' },
  });

  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id, name: `Cancel Prize ${ts}`, redemptionCost: 10,
      assetTypeId: asset.id, stock: 3, active: true, minLevel: 1,
    },
  });

  const consumerToken = issueConsumerTokens({
    accountId: consumer.id, tenantId: tenant.id, phoneNumber: phone, type: 'consumer',
  }).accessToken;

  const redRes = await fetch(`${API}/api/consumer/redeem`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${consumerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      productId: product.id,
      assetTypeId: asset.id,
      requestId: `cancel-req-${ts}`,
    }),
  });
  const redBody: any = await redRes.json();
  await assert('/api/consumer/redeem 200', redRes.status === 200, `status=${redRes.status}`);
  const tokenId: string = redBody.tokenId;
  await assert('got a tokenId', typeof tokenId === 'string' && tokenId.length === 36, `tokenId=${tokenId}`);

  const balBefore = await getAccountBalance(consumer.id, asset.id, tenant.id);
  await assert('balance after PENDING is 90', Number(balBefore) === 90, `balance=${balBefore}`);

  // Cancel
  const cancelRes = await fetch(`${API}/api/consumer/redemption/${tokenId}/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${consumerToken}` },
  });
  const cancelBody: any = await cancelRes.json();
  await assert('cancel returns 200', cancelRes.status === 200, `status=${cancelRes.status}`);
  await assert('cancel payload carries cancelled=true', cancelBody.cancelled === true,
    `cancelled=${cancelBody.cancelled}`);

  // Token status
  const tokenRow = await prisma.redemptionToken.findUnique({ where: { id: tokenId } });
  await assert('token status is expired', tokenRow?.status === 'expired', `status=${tokenRow?.status}`);

  // Reversal ledger entry with cancelledByConsumer flag
  const reversal = await prisma.ledgerEntry.findFirst({
    where: {
      tenantId: tenant.id,
      eventType: 'REDEMPTION_EXPIRED',
      accountId: consumer.id,
      entryType: 'CREDIT',
      referenceId: `EXPIRED-${tokenId}`,
    },
  });
  await assert('REDEMPTION_EXPIRED credit landed on consumer', !!reversal,
    `found=${!!reversal} amount=${reversal?.amount}`);
  await assert('reversal metadata marks cancelledByConsumer=true',
    (reversal?.metadata as any)?.cancelledByConsumer === true,
    `meta=${JSON.stringify(reversal?.metadata)}`);

  // Balance fully restored
  const balAfter = await getAccountBalance(consumer.id, asset.id, tenant.id);
  await assert('balance after cancel is back to 100', Number(balAfter) === 100, `balance=${balAfter}`);

  // Cancelling again returns 409
  const cancel2 = await fetch(`${API}/api/consumer/redemption/${tokenId}/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${consumerToken}` },
  });
  await assert('second cancel returns 409 (not pending anymore)',
    cancel2.status === 409, `status=${cancel2.status}`);

  // Cancelling a non-existent token returns 404
  const cancel3 = await fetch(`${API}/api/consumer/redemption/00000000-0000-0000-0000-000000000000/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${consumerToken}` },
  });
  await assert('cancel on unknown tokenId returns 404',
    cancel3.status === 404, `status=${cancel3.status}`);

  // Invalid tokenId format returns 400
  const cancel4 = await fetch(`${API}/api/consumer/redemption/not-a-uuid/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${consumerToken}` },
  });
  await assert('cancel on invalid tokenId returns 400',
    cancel4.status === 400, `status=${cancel4.status}`);

  // Frontend ships the new button
  const html = await (await fetch(`${FRONTEND}/my-codes`)).text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('/my-codes chunk carries "Cancelar canje y recuperar puntos"',
    chunkBodies.some(js => js.includes('Cancelar canje y recuperar puntos')),
    `scanned=${chunkUrls.length}`);
  await assert('/my-codes chunk carries the confirmation modal body',
    chunkBodies.some(js => js.includes('vuelven a tu saldo al instante')),
    'verified');

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
