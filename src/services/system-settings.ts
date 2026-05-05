/**
 * Single-row global config the admin flips at runtime. Backed by the
 * system_settings table (key/jsonb-value). First use case (Eric
 * 2026-05-04): auth_channel = 'whatsapp' | 'sms' to switch consumer
 * OTP delivery between WhatsApp and Twilio Verify.
 */
import prisma from '../db/client.js';

export type AuthChannel = 'whatsapp' | 'sms';

const KEY_AUTH_CHANNEL = 'auth_channel';
const DEFAULT_AUTH_CHANNEL: AuthChannel = 'whatsapp';

export async function getAuthChannel(): Promise<AuthChannel> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY_AUTH_CHANNEL } });
  const raw = row?.value as string | undefined;
  if (raw === 'sms' || raw === 'whatsapp') return raw;
  return DEFAULT_AUTH_CHANNEL;
}

export async function setAuthChannel(channel: AuthChannel, adminId: string | null): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: KEY_AUTH_CHANNEL },
    create: { key: KEY_AUTH_CHANNEL, value: channel, updatedBy: adminId },
    update: { value: channel, updatedBy: adminId },
  });
}

export async function getAuthChannelMeta(): Promise<{ channel: AuthChannel; updatedAt: Date | null; updatedBy: string | null }> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY_AUTH_CHANNEL } });
  if (!row) return { channel: DEFAULT_AUTH_CHANNEL, updatedAt: null, updatedBy: null };
  const raw = row.value as string;
  const channel: AuthChannel = (raw === 'sms' || raw === 'whatsapp') ? raw : DEFAULT_AUTH_CHANNEL;
  return { channel, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}
