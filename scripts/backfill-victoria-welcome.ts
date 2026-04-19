/**
 * One-off backfill: grant Victoria's missing welcome bonus on valee-demo.
 * She arrived via Eric's referral link before the welcome-bonus-on-referral
 * fix landed, so her account exists with welcome_bonus_granted=false and
 * no WELCOME ledger entry.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { grantWelcomeBonus } from '../src/services/welcome-bonus.js';

async function main() {
  const account = await prisma.account.findFirst({
    where: { phoneNumber: '+584244183100', tenant: { slug: 'valee-demo' } },
    include: { tenant: true },
  });
  if (!account) { console.log('account not found'); process.exit(1); }

  console.log(`Victoria: ${account.id} welcomeGranted=${account.welcomeBonusGranted}`);

  const cfg = await prisma.tenantAssetConfig.findFirst({ where: { tenantId: account.tenantId } });
  if (!cfg) { console.log('no asset config'); process.exit(1); }

  const result = await grantWelcomeBonus(account.id, account.tenantId, cfg.assetTypeId);
  console.log(`grant result:`, result);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
