import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from '../db/client.js';

const JWT_SECRET = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not configured');
  return s;
};

// ============================================================
// OTP
// ============================================================

export async function generateOTP(phoneNumber: string): Promise<string> {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  await prisma.otpSession.create({
    data: { phoneNumber, otpHash, expiresAt },
  });

  return otp;
}

export async function verifyOTP(phoneNumber: string, otp: string): Promise<boolean> {
  const session = await prisma.otpSession.findFirst({
    where: {
      phoneNumber,
      used: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!session) return false;

  const valid = await bcrypt.compare(otp, session.otpHash);
  if (!valid) return false;

  await prisma.otpSession.update({
    where: { id: session.id },
    data: { used: true },
  });

  return true;
}

// ============================================================
// JWT — Consumer
// ============================================================

export interface ConsumerTokenPayload {
  accountId: string;
  tenantId: string;
  phoneNumber: string;
  type: 'consumer';
}

export function issueConsumerTokens(payload: ConsumerTokenPayload) {
  const accessExpiry = process.env.JWT_ACCESS_EXPIRY || '15m';
  const refreshExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';

  const accessToken = jwt.sign(payload, JWT_SECRET(), { expiresIn: accessExpiry as any });
  const refreshToken = jwt.sign({ ...payload, refresh: true }, JWT_SECRET(), { expiresIn: refreshExpiry as any });

  return { accessToken, refreshToken };
}

export function verifyConsumerToken(token: string): ConsumerTokenPayload {
  return jwt.verify(token, JWT_SECRET()) as ConsumerTokenPayload;
}

// ============================================================
// JWT — Staff
// ============================================================

export interface StaffTokenPayload {
  staffId: string;
  tenantId: string;
  role: 'owner' | 'cashier';
  type: 'staff';
}

export function issueStaffTokens(payload: StaffTokenPayload) {
  const accessExpiry = process.env.JWT_ACCESS_EXPIRY || '15m';
  const refreshExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';

  const accessToken = jwt.sign(payload, JWT_SECRET(), { expiresIn: accessExpiry as any });
  const refreshToken = jwt.sign({ ...payload, refresh: true }, JWT_SECRET(), { expiresIn: refreshExpiry as any });

  return { accessToken, refreshToken };
}

export function verifyStaffToken(token: string): StaffTokenPayload {
  return jwt.verify(token, JWT_SECRET()) as StaffTokenPayload;
}

// ============================================================
// JWT — Admin
// ============================================================

export interface AdminTokenPayload {
  adminId: string;
  type: 'admin';
}

export function issueAdminTokens(payload: AdminTokenPayload) {
  const accessExpiry = process.env.JWT_ACCESS_EXPIRY || '15m';
  const refreshExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';

  const accessToken = jwt.sign(payload, JWT_SECRET(), { expiresIn: accessExpiry as any });
  const refreshToken = jwt.sign({ ...payload, refresh: true }, JWT_SECRET(), { expiresIn: refreshExpiry as any });

  return { accessToken, refreshToken };
}

// ============================================================
// Staff login
// ============================================================

export async function authenticateStaff(email: string, password: string, tenantId: string) {
  const staff = await prisma.staff.findUnique({
    where: { tenantId_email: { tenantId, email } },
  });

  if (!staff || !staff.active) return null;

  const valid = await bcrypt.compare(password, staff.passwordHash);
  if (!valid) return null;

  return staff;
}

// ============================================================
// Admin login
// ============================================================

export async function authenticateAdmin(email: string, password: string) {
  const admin = await prisma.adminUser.findUnique({ where: { email } });
  if (!admin || !admin.active) return null;

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) return null;

  return admin;
}
