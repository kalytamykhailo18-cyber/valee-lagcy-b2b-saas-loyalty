/**
 * Cloudinary image upload.
 * All config from .env — never hardcoded.
 */

import { createHash } from 'crypto';

function getConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
}

export async function uploadImage(
  imageBuffer: Buffer,
  folder: string = 'loyalty-platform'
): Promise<string | null> {
  const config = getConfig();
  if (!config) {
    console.log('[Cloudinary] Not configured — skipping upload');
    return null;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}${config.apiSecret}`;
  const signature = createHash('sha1').update(paramsToSign).digest('hex');

  const formData = new FormData();
  formData.append('file', new Blob([imageBuffer]));
  formData.append('folder', folder);
  formData.append('timestamp', timestamp);
  formData.append('api_key', config.apiKey);
  formData.append('signature', signature);

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`,
      { method: 'POST', body: formData }
    );

    if (!res.ok) {
      console.error('[Cloudinary] Upload failed:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return data.secure_url;
  } catch (err) {
    console.error('[Cloudinary] Upload error:', err);
    return null;
  }
}
