/**
 * Admin auth middleware shared across every submodule under this folder.
 * Not exported from a non-underscored filename so it reads as "internal"
 * when browsing the admin routes directory.
 */
export async function requireAdminAuth(request: any, reply: any) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Authentication required' });
  }
  try {
    const jwt = await import('jsonwebtoken');
    const payload = jwt.default.verify(authHeader.slice(7), process.env.JWT_SECRET!) as any;
    if (payload.type !== 'admin') return reply.status(403).send({ error: 'Admin access required' });
    request.admin = payload;
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}
