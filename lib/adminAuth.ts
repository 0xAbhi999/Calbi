// Admin dashboard authentication — a tiny server-side session built on an
// HMAC-signed HttpOnly cookie. It is intentionally independent of the student
// auth (Supabase Auth / local JSON store) so the admin login works identically
// in demo mode and in production, on any domain.
//
// Credentials are fixed by the product owner: username `admin`, password
// `CalibiAdmin@777`. The cookie token expires after ADMIN_SESSION_HOURS and is
// re-verified on every /api/admin/* request — there is no client-side "trust
// me" flag, so the data API stays closed to anyone who did not log in.
import { createHmac, timingSafeEqual } from 'crypto'

export const ADMIN_USERNAME = 'admin'
export const ADMIN_PASSWORD = 'CalibiAdmin@777'
export const ADMIN_COOKIE = 'calibiai_admin_session'
const ADMIN_SESSION_HOURS = 8
/** Override in production via env ADMIN_SECRET (any long random string). */
const SECRET = process.env.ADMIN_SECRET || 'calibiai-admin-local-secret-change-me'

function hmac(data: string): string {
  return createHmac('sha256', SECRET).update(data).digest('hex')
}

/** Constant-time string comparison (used for the password check too). */
export function safeEqual(a: string, b: string): boolean {
  const ah = createHmac('sha256', SECRET).update(a).digest()
  const bh = createHmac('sha256', SECRET).update(b).digest()
  return timingSafeEqual(ah, bh)
}

export function signSession(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ADMIN_SESSION_HOURS * 3600_000 })).toString('base64url')
  return `v1.${payload}.${hmac(payload)}`
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false
  const parts = String(token).split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return false
  const [, payload, sig] = parts
  const expectBuf = Buffer.from(hmac(payload), 'hex')
  let sigBuf: Buffer
  try {
    sigBuf = Buffer.from(sig, 'hex')
  } catch {
    return false
  }
  if (sigBuf.length !== expectBuf.length) return false
  if (!timingSafeEqual(sigBuf, expectBuf)) return false
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
    return typeof data.exp === 'number' && data.exp > Date.now()
  } catch {
    return false
  }
}

/** Read the admin cookie from a Request (plain JS object on the server). */
export function cookieFromRequest(req: Request): string | undefined {
  const raw = req.headers.get('cookie') || ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === ADMIN_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

export function isAdminRequest(req: Request): boolean {
  return verifySessionToken(cookieFromRequest(req))
}
