/**
 * E2E: Configuration form rejects empty RIF (Genesis M1 Re Do).
 *
 * Before: the /api/merchant/settings PUT accepted rif='' or rif=null
 * and silently cleared the DB column. Genesis reproduced it by saving
 * the form with empty RIF and seeing the 'Guardado' toast — the row
 * in the DB had rif=NULL after that.
 *
 * After: PUT rejects empty/blank rif with 400. Valid format still
 * works. Leaving the rif key out of the body doesn't touch it. The
 * settings page also requires the field at submit time.
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/db/client.js';
import { createTenant } from '../src/services/tenants.js';
import { createSystemAccounts } from '../src/services/accounts.js';
import { issueStaffTokens } from '../src/services/auth.js';
import bcrypt from 'bcryptjs';

const API      = process.env.SMOKE_API_BASE      || 'http://localhost:3000';
const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function main() {
  console.log('=== RIF required at form level E2E ===\n');

  const ts = Date.now();
  const tenant = await createTenant(`RifForm ${ts}`, `rf-${ts}`, `rf-${ts}@e2e.local`);
  await createSystemAccounts(tenant.id);
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { rif: 'J-12345678-9' },
  });

  const owner = await prisma.staff.create({
    data: {
      tenantId: tenant.id, name: 'Owner', email: `rf-owner-${ts}@e2e.local`,
      passwordHash: await bcrypt.hash('pw', 10), role: 'owner',
    },
  });
  const ownerToken = issueStaffTokens({
    staffId: owner.id, tenantId: tenant.id, role: 'owner', type: 'staff',
  }).accessToken;

  async function put(body: any) {
    return fetch(`${API}/api/merchant/settings`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  // Empty string → 400
  const r1 = await put({ rif: '' });
  await assert('PUT rif="" returns 400', r1.status === 400, `status=${r1.status}`);
  const b1: any = await r1.json();
  await assert('error mentions RIF is obligatorio',
    /obligatorio/i.test(b1.error || ''), `error=${b1.error}`);

  // Whitespace-only → 400
  const r2 = await put({ rif: '   ' });
  await assert('PUT rif="   " returns 400', r2.status === 400, `status=${r2.status}`);

  // null → 400
  const r3 = await put({ rif: null });
  await assert('PUT rif=null returns 400', r3.status === 400, `status=${r3.status}`);

  // RIF must still be present in DB after the rejected PUTs
  const still = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { rif: true } });
  await assert('rejected PUTs left the DB rif unchanged',
    still?.rif === 'J-12345678-9', `rif=${still?.rif}`);

  // Invalid format → 400
  const r4 = await put({ rif: 'Z999' });
  await assert('PUT rif with bad format returns 400',
    r4.status === 400, `status=${r4.status}`);

  // Valid RIF → 200
  const r5 = await put({ rif: 'V-87654321-0' });
  await assert('PUT rif with valid format returns 200',
    r5.status === 200, `status=${r5.status}`);
  const persisted = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { rif: true } });
  await assert('valid RIF actually persists',
    persisted?.rif === 'V-87654321-0', `rif=${persisted?.rif}`);

  // Omitting rif key entirely → 200 and doesn't touch rif
  const r6 = await put({ name: `RifForm ${ts} touched` });
  await assert('PUT without rif key returns 200',
    r6.status === 200, `status=${r6.status}`);
  const untouched = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { rif: true } });
  await assert('omitting rif key does not clear the RIF',
    untouched?.rif === 'V-87654321-0', `rif=${untouched?.rif}`);

  // Frontend chunk ships the required-field copy
  const html = await (await fetch(`${FRONTEND}/merchant/settings`)).text();
  const chunkUrls = Array.from(html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('/merchant/settings chunk ships the required copy',
    chunkBodies.some(js => js.includes('El RIF es obligatorio')),
    `scanned=${chunkUrls.length}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
