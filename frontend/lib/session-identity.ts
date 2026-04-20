/**
 * Read the phone number (and role/account-id) out of the current consumer
 * or staff JWT in localStorage. Used purely for display — the server
 * always re-verifies the token's signature; this helper doesn't.
 *
 * Eric hit a class of issues where opening valee.app on a shared browser
 * dropped him into someone else's session (Genesis, Victoria) without
 * any visible indication of which identity he was about to enter. The
 * auth was valid (an OTP had been verified from that browser at some
 * point and the session persisted); the gap was UX. Surfacing the phone
 * number next to the 'Mi cuenta' CTA and on the consumer home screen
 * makes the active session impossible to miss.
 */

interface JwtBody {
  phoneNumber?: string
  accountId?: string
  tenantId?: string
  type?: 'consumer' | 'staff' | 'admin'
  role?: 'owner' | 'cashier'
}

function decodeJwtBodyUnverified(token: string): JwtBody | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    // base64url → base64 → JSON. atob is fine for ASCII payloads.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(
      parts[1].length + ((4 - (parts[1].length % 4)) % 4), '='
    )
    return JSON.parse(atob(b64)) as JwtBody
  } catch {
    return null
  }
}

export interface SessionIdentity {
  phoneNumber: string | null
  role?: 'owner' | 'cashier'
  type?: 'consumer' | 'staff' | 'admin'
}

export function getCurrentSessionIdentity(): SessionIdentity | null {
  if (typeof window === 'undefined') return null
  const token = localStorage.getItem('accessToken')
  if (!token) return null
  const body = decodeJwtBodyUnverified(token)
  if (!body) return null
  return {
    phoneNumber: body.phoneNumber || null,
    role: body.role,
    type: body.type,
  }
}

/** Masks all but the last 4 digits of a phone: +58414****4569 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return ''
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return phone
  const tail = digits.slice(-4)
  const head = digits.slice(0, Math.max(0, digits.length - 4 - 4))
  return `+${head}****${tail}`
}
