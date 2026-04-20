/**
 * E2E: self-service merchant onboarding wizard flow.
 *
 * Drives the endpoints the frontend /merchant/onboarding wizard uses:
 *   1. POST /api/merchant/signup — tenant + owner + QR + auto-login
 *   2. GET  /api/merchant/settings — wizard reads qrCodeUrl, productCount,
 *      welcomeBonusAmount, referralBonusAmount, referenceCurrency
 *   3. PUT  /api/merchant/settings — step 2 saves bonus + currency
 *   4. POST /api/merchant/products — step 3 creates first product
 *   5. GET  /api/merchant/settings — confirms productCount++
 */

import dotenv from 'dotenv';
dotenv.config();

const API = process.env.SMOKE_API_BASE || 'http://localhost:3000';

async function assert(label: string, cond: boolean, detail: string) {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${label} — ${detail}`);
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

async function authedFetch(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

async function main() {
  const ts = Date.now();

  // Step 1: signup. Spoof a unique X-Forwarded-For so repeated CI runs on
  // the same host don't collide with the per-IP signup rate limiter
  // (5 per 10 minutes).
  const fakeIp = `10.20.${(ts >> 8) & 0xff}.${ts & 0xff}`;
  const signupRes = await fetch(`${API}/api/merchant/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': fakeIp },
    body: JSON.stringify({
      businessName: `Onboarding E2E ${ts}`,
      ownerName: 'E2E Owner',
      ownerEmail: `e2e-${ts}@example.com`,
      password: 'passw0rd-e2e',
      rif: `J-${String(ts).slice(-9).padStart(9, '0')}-1`,
    }),
  });
  const signup: any = await signupRes.json();
  await assert('signup returns 200 + tokens', signupRes.status === 200 && !!signup.accessToken,
    `status=${signupRes.status} token=${signup.accessToken ? 'yes' : 'no'}`);
  await assert('signup returns tenant', !!signup.tenant?.id && !!signup.tenant?.slug,
    `slug=${signup.tenant?.slug}`);
  await assert('signup returns owner staff', signup.staff?.role === 'owner',
    `role=${signup.staff?.role}`);

  const token = signup.accessToken as string;

  // Step 2: wizard loads settings
  const settingsRes = await authedFetch('/api/merchant/settings', token);
  const settings: any = await settingsRes.json();
  await assert('settings endpoint returns 200', settingsRes.status === 200, `status=${settingsRes.status}`);
  await assert('settings returns productCount=0', settings.productCount === 0,
    `productCount=${settings.productCount}`);
  await assert('settings returns slug', typeof settings.slug === 'string' && settings.slug.length > 0,
    `slug=${settings.slug}`);
  // qrCodeUrl may be null if Cloudinary was unavailable during signup; the
  // wizard handles both cases. Just assert the field is present.
  await assert('settings exposes qrCodeUrl field', 'qrCodeUrl' in settings,
    `qrCodeUrl=${settings.qrCodeUrl ? 'set' : 'null'}`);
  await assert('settings returns default welcomeBonus 50', Number(settings.welcomeBonusAmount) === 50,
    `welcomeBonus=${settings.welcomeBonusAmount}`);

  // Step 3: wizard saves bonus + currency
  const putRes = await authedFetch('/api/merchant/settings', token, {
    method: 'PUT',
    body: JSON.stringify({
      welcomeBonusAmount: 75,
      referralBonusAmount: 150,
      referenceCurrency: 'eur',
    }),
  });
  await assert('settings PUT 200', putRes.status === 200, `status=${putRes.status}`);

  const reloadRes = await authedFetch('/api/merchant/settings', token);
  const reload: any = await reloadRes.json();
  await assert('welcomeBonus persisted', Number(reload.welcomeBonusAmount) === 75,
    `welcomeBonus=${reload.welcomeBonusAmount}`);
  await assert('referralBonus persisted', Number(reload.referralBonusAmount) === 150,
    `referralBonus=${reload.referralBonusAmount}`);
  await assert('referenceCurrency persisted', reload.referenceCurrency === 'eur',
    `currency=${reload.referenceCurrency}`);

  // Step 4: wizard creates first product — needs assetTypeId from settings
  await assert('settings exposes assetTypeId', typeof reload.assetTypeId === 'string' && reload.assetTypeId.length > 0,
    `assetTypeId=${reload.assetTypeId}`);
  const productRes = await authedFetch('/api/merchant/products', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `Cafe gratis ${ts}`,
      redemptionCost: '100',
      assetTypeId: reload.assetTypeId,
      stock: 10,
      active: true,
    }),
  });
  await assert('product create 200', productRes.status === 200, `status=${productRes.status}`);

  // Step 5: wizard re-reads settings to reflect productCount
  const finalRes = await authedFetch('/api/merchant/settings', token);
  const final: any = await finalRes.json();
  await assert('productCount increments to 1', final.productCount === 1,
    `productCount=${final.productCount}`);

  // Step 6: wizard page JS chunk exposes the Download + Copy-link actions
  // so the QR step isn't just a dead-end open-in-new-tab.
  const FRONTEND = process.env.SMOKE_FRONTEND_BASE || 'http://localhost:3001';
  const pageHtml = await (await fetch(`${FRONTEND}/merchant/onboarding`)).text();
  const chunkUrls = Array.from(pageHtml.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)).map(m => m[0]);
  const chunkBodies = await Promise.all(chunkUrls.map(u => fetch(`${FRONTEND}${u}`).then(r => r.text())));
  await assert('onboarding chunk exposes "Descargar PNG"',
    chunkBodies.some(js => js.includes('Descargar PNG')),
    `scanned=${chunkUrls.length}`);
  await assert('onboarding chunk exposes "Copiar enlace"',
    chunkBodies.some(js => js.includes('Copiar enlace')),
    `scanned=${chunkUrls.length}`);
  await assert('onboarding chunk uses valee-qr-* download filename',
    chunkBodies.some(js => js.includes('valee-qr-')),
    `scanned=${chunkUrls.length}`);

  console.log('\n=== ALL ASSERTIONS PASSED ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
