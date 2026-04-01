import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyConsumerToken, verifyStaffToken, type ConsumerTokenPayload, type StaffTokenPayload } from '../../services/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    consumer?: ConsumerTokenPayload;
    staff?: StaffTokenPayload;
  }
}

export async function requireConsumerAuth(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Authentication required' });
  }
  try {
    request.consumer = verifyConsumerToken(authHeader.slice(7));
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export async function requireStaffAuth(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Authentication required' });
  }
  try {
    request.staff = verifyStaffToken(authHeader.slice(7));
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
