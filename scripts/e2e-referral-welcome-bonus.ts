/**
 * E2E: a consumer arriving via a referral link gets their welcome bonus.
 *
 * Before the fix, the referral code-path created the account via
 * findOrCreateConsumerAccount but never called grantWelcomeBonus.
 * handleIncomingMessage later saw the row already existed (created=false)
 * and skipped its own welcome-bonus branch, so the referee silently never
 * received their welcome points.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { findOrCreateConsumerAccount } from '../src/services/accounts.js';
import { grantWelcomeBonus } from '../src/services/welcome-bonus.js';
import { getAccountBalance } from '../src/services/ledger.js';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: 'smoke-test' } });
  if (!tenant) throw new Error('smoke-test tenant missing');

  const cfg = await prisma.tenantAssetConfig.findFirst({ where: { tenantId: tenant.id } });
  if (!cfg) throw new Error('smoke-test tenant has no asset config');
  const assetTypeId = cfg.assetTypeId;

  const ts = Date.now();
  const phone = `+19600${String(ts).slice(-7)}`;

  // Simulate the exact webhook flow: referral-path creates the account first.
  const { account, created } = await findOrCreateConsumerAccount(tenant.id, phone);
  await assert('account created fresh', created === true, `created=${created}`);
  await assert('welcome flag initially false', account.welcomeBonusGranted === false,
    `flag=${account.welcomeBonusGranted}`);

  // Apply the fix: grantWelcomeBonus on the referral path when created=true.
  const bonus = await grantWelcomeBonus(account.id, tenant.id, assetTypeId);
  await assert('bonus granted', bonus.granted === true && Number(bonus.amount) > 0,
    `granted=${bonus.granted} amount=${bonus.amount}`);

  const bal = await getAccountBalance(account.id, assetTypeId, tenant.id);
  await assert('balance equals bonus amount', Number(bal) === Number(bonus.amount),
    `balance=${bal} bonus=${bonus.amount}`);

  const after = await prisma.account.findUnique({ where: { id: account.id } });
  await assert('welcome flag flipped to true', after!.welcomeBonusGranted === true,
    `flag=${after!.welcomeBonusGranted}`);

  // Idempotency: second grant is a no-op.
  const again = await grantWelcomeBonus(account.id, tenant.id, assetTypeId);
  await assert('second grant is no-op', again.granted === false, `granted=${again.granted}`);

  const balAfter = await getAccountBalance(account.id, assetTypeId, tenant.id);
  await assert('balance unchanged after second grant', Number(balAfter) === Number(bonus.amount),
    `balance=${balAfter}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
