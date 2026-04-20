import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { verifyConsumerToken, verifyStaffToken, type ConsumerTokenPayload, type StaffTokenPayload } from '../../services/auth.js';
import prisma from '../../db/client.js';

declare module 'fastify' {
  interface FastifyRequest {
    consumer?: ConsumerTokenPayload;
    staff?: StaffTokenPayload;
  }
}

/**
 * Returns the token's `iat` as a JS Date. jsonwebtoken stores it as epoch
 * seconds; convert to ms for comparison against tokens_invalidated_at.
 */
function tokenIssuedAt(token: string): Date | null {
  const decoded = jwt.decode(token) as { iat?: number } | null;
  if (!decoded?.iat) return null;
  return new Date(decoded.iat * 1000);
}

export async function requireConsumerAuth(request: FastifyRequest, reply: FastifyReply) {
  // Accept token from Authorization header OR HTTP-only cookie
  const authHeader = request.headers.authorization;
  const cookieToken = (request.cookies as any)?.accessToken;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : cookieToken;

  if (!token) {
    console.log(`[Auth][401] No token | url=${request.url}`);
    return reply.status(401).send({ error: 'Authentication required' });
  }
  try {
    const payload = verifyConsumerToken(token);
    // Per-subject logout: if the account's tokens_invalidated_at is set and
    // this token was issued before that moment, the user explicitly logged
    // out (or an admin force-logged them out) — reject even though the JWT
    // signature is still valid.
    if (payload.accountId) {
      const acc = await prisma.account.findUnique({
        where: { id: payload.accountId },
        select: { tokensInvalidatedAt: true },
      });
      const iat = tokenIssuedAt(token);
      if (acc?.tokensInvalidatedAt && iat && iat <= acc.tokensInvalidatedAt) {
        console.log(`[Auth][401] Token revoked by logout | accountId=${payload.accountId.slice(0,8)} iat=${iat.toISOString()} cutoff=${acc.tokensInvalidatedAt.toISOString()}`);
        return reply.status(401).send({ error: 'Session expired' });
      }
    }
    request.consumer = payload;
  } catch (err: any) {
    const reason = err?.message || 'unknown';
    console.log(`[Auth][401] Token rejected | url=${request.url} reason=${reason}`);
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export async function requireStaffAuth(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Authentication required' });
  }
  try {
    const token = authHeader.slice(7);
    const payload = verifyStaffToken(token);
    const st = await prisma.staff.findUnique({
      where: { id: payload.staffId },
      select: { tokensInvalidatedAt: true, active: true },
    });
    if (!st?.active) {
      return reply.status(401).send({ error: 'Account deactivated' });
    }
    const iat = tokenIssuedAt(token);
    if (st.tokensInvalidatedAt && iat && iat <= st.tokensInvalidatedAt) {
      console.log(`[Auth][401] Staff token revoked | staffId=${payload.staffId.slice(0,8)}`);
      return reply.status(401).send({ error: 'Session expired' });
    }
    request.staff = payload;
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export async function requireOwnerRole(request: FastifyRequest, reply: FastifyReply) {
  if (!request.staff || request.staff.role !== 'owner') {
    return reply.status(403).send({ error: 'Owner access required' });
  }
}

export async function requireCashierOrOwner(request: FastifyRequest, reply: FastifyReply) {
  if (!request.staff) {
    return reply.status(403).send({ error: 'Staff access required' });
  }
}
