/**
 * Test login helper — generates a consumer JWT for any phone number,
 * bypassing the OTP step. For local testing only.
 *
 * Usage:
 *   npx tsx scripts/test-login.ts                    # uses default test consumer
 *   npx tsx scripts/test-login.ts +584140446569      # specify a phone
 */

import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const { issueConsumerTokens } = await import('../src/services/auth.js');

  const phone = process.argv[2] || '+584140446569';

  // Find or create the test account
  let account = await prisma.account.findFirst({
    where: { phoneNumber: phone, accountType: { in: ['shadow', 'verified'] } },
  });

  if (!account) {
    // Create under valee-demo tenant
    const tenant = await prisma.tenant.findFirst({ where: { slug: 'valee-demo' } });
    if (!tenant) {
      console.error('No valee-demo tenant found. Run the setup first.');
      process.exit(1);
    }
    account = await prisma.account.create({
      data: {
        tenantId: tenant.id,
        phoneNumber: phone,
        accountType: 'shadow',
      },
    });
    console.log(`Created new test account for ${phone}`);
  }

  const tokens = issueConsumerTokens({
    accountId: account.id,
    tenantId: account.tenantId,
    phoneNumber: account.phoneNumber!,
    type: 'consumer',
  });

  console.log('\n========================================');
  console.log('TEST CONSUMER SESSION');
  console.log('========================================');
  console.log('Phone:      ', account.phoneNumber);
  console.log('Account ID: ', account.id);
  console.log('Tenant ID:  ', account.tenantId);
  console.log('\n--- Inject into browser localStorage ---');
  console.log('1. Open https://valee.app in your browser');
  console.log('2. Open DevTools → Console');
  console.log('3. Paste this and hit Enter:');
  console.log('');
  console.log(`localStorage.setItem('accessToken', '${tokens.accessToken}'); localStorage.setItem('refreshToken', '${tokens.refreshToken}'); location.reload();`);
  console.log('');
  console.log('4. The page reloads logged in.');
  console.log('========================================\n');

  await prisma.$disconnect();
}

main().catch(e => { console.error(e.message); process.exit(1); });
