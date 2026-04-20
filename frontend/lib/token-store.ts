/**
 * Role-scoped token storage.
 *
 * Consumer, staff (merchant), and admin each keep their own access+refresh
 * token in distinct localStorage keys so that opening /consumer and
 * /merchant in two tabs doesn't clobber each other (Genesis H2). Before
 * this split, both roles wrote to the shared "accessToken" key, and the
 * last login won — producing 401s, phantom renders, and reload loops.
 *
 * Migration: on first read, if the legacy generic keys exist and the
 * role-specific key does not, we copy the legacy value in and delete it.
 * The role is inferred from window.location.pathname at migration time —
 * imperfect, but it only runs once per user and only until the tokens
 * are rotated on next login.
 */

export type Role = 'consumer' | 'staff' | 'admin';

const KEYS: Record<Role, { access: string; refresh: string }> = {
  consumer: { access: 'consumerAccessToken', refresh: 'consumerRefreshToken' },
  staff:    { access: 'staffAccessToken',    refresh: 'staffRefreshToken'    },
  admin:    { access: 'adminAccessToken',    refresh: 'adminRefreshToken'    },
};

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function roleForPath(path: string): Role {
  if (path.startsWith('/merchant')) return 'staff';
  if (path.startsWith('/admin')) return 'admin';
  return 'consumer';
}

export function roleForApiPath(apiPath: string): Role {
  if (apiPath.startsWith('/api/merchant')) return 'staff';
  if (apiPath.startsWith('/api/admin')) return 'admin';
  return 'consumer';
}

function migrateLegacy(role: Role) {
  if (!isBrowser()) return;
  const { access, refresh } = KEYS[role];
  if (!localStorage.getItem(access)) {
    const legacyAccess = localStorage.getItem('accessToken');
    if (legacyAccess) localStorage.setItem(access, legacyAccess);
  }
  if (!localStorage.getItem(refresh)) {
    const legacyRefresh = localStorage.getItem('refreshToken');
    if (legacyRefresh) localStorage.setItem(refresh, legacyRefresh);
  }
}

export function getAccess(role: Role): string | null {
  if (!isBrowser()) return null;
  migrateLegacy(role);
  return localStorage.getItem(KEYS[role].access);
}

export function getRefresh(role: Role): string | null {
  if (!isBrowser()) return null;
  migrateLegacy(role);
  return localStorage.getItem(KEYS[role].refresh);
}

export function setTokens(role: Role, accessToken: string, refreshToken?: string) {
  if (!isBrowser()) return;
  localStorage.setItem(KEYS[role].access, accessToken);
  if (refreshToken) localStorage.setItem(KEYS[role].refresh, refreshToken);
  // Clean up legacy keys whenever we rotate a new token — prevents the
  // generic accessToken from leaking into a different role's requests
  // after an upgrade.
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

export function clearTokens(role: Role) {
  if (!isBrowser()) return;
  localStorage.removeItem(KEYS[role].access);
  localStorage.removeItem(KEYS[role].refresh);
  // Also sweep legacy keys during logout — old tabs may still be holding them.
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

export function accessKeyFor(role: Role): string {
  return KEYS[role].access;
}
