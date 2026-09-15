// Server-side Supabase client for API routes.
//
// Two client flavours exist, and picking the wrong one is the difference
// between "the row is in Postgres" and "the row silently vanished":
//
//   1. `getServerClient()`      — anon key (or service-role key when set), with
//                                 NO auth session. `auth.uid()` is NULL in
//                                 Postgres, so every RLS policy of the shape
//                                 `auth.uid() = id` rejects the write.
//   2. `getClientForRequest()`  — anon key + the CALLER'S access token. Postgres
//                                 then sees `auth.uid() = <that user>` and the
//                                 self-scoped policies pass, so profile /
//                                 resume / tracking / session rows are written
//                                 without needing a service-role key at all.
//
// Writes to a student's own rows must therefore go through
// `getClientForRequest(req)` (or `getClientForToken(token)` when the token came
// from a sign-up/sign-in response rather than a request header). `getServerClient()`
// stays for the admin/seed paths, which legitimately need the service-role key.
//
// Returns null when Supabase is not configured (or the package is the
// compile-time stub) so callers fall back to the local JSON demo store.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isSupabaseConfigured } from './supabase.ts'

let cached: SupabaseClient | null | undefined

export function getServerClient(): SupabaseClient | null {
  if (cached !== undefined) return cached
  cached = null
  if (!isSupabaseConfigured()) return null
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim()
  if (!url || !key) return null
  try {
    cached = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  } catch (e) {
    console.warn('[supabase] server client unavailable:', (e as Error)?.message, '— using local demo store.')
    cached = null
  }
  return cached
}

export function isSupabaseBackend(): boolean {
  return !!getServerClient()
}

/** True when writes can bypass RLS entirely (trusted server-side key). */
export function hasServiceRoleKey(): boolean {
  return !!(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
}

type HeadersLike = { get?(name: string): string | null } | Record<string, unknown> | null | undefined

/**
 * The caller's Supabase access token, if the request carries one. Accepts both
 * a Web `Request` (Headers with `.get`) and a plain header object, so the same
 * helper works from route handlers and from tests.
 */
export function bearerToken(req?: { headers?: HeadersLike } | null): string | null {
  const headers: any = req?.headers
  if (!headers) return null
  let raw: unknown = null
  try {
    raw = typeof headers.get === 'function'
      ? headers.get('authorization') ?? headers.get('Authorization')
      : headers.authorization ?? headers.Authorization
  } catch {
    return null
  }
  const value = String(raw ?? '').trim()
  if (!value) return null
  const match = /^Bearer\s+(.+)$/i.exec(value)
  return (match ? match[1] : value).trim() || null
}

/**
 * Per-token clients are cheap but not free; access tokens rotate every 15
 * minutes, so without a bound a long-lived server would leak one client per
 * refresh. Oldest entries are dropped past the cap.
 */
const TOKEN_CACHE_LIMIT = 200
const tokenClients = new Map<string, SupabaseClient>()

/**
 * A client that talks to PostgREST AS the given user: the anon key stays in
 * `apikey` while their access token goes in `Authorization`, which is exactly
 * what makes `auth.uid()` resolve inside RLS policies. With a service-role key
 * configured the trusted client is returned instead (it already bypasses RLS),
 * and with no token at all the caller gets the plain server client so reads of
 * insert-any / public tables keep working.
 */
export function getClientForToken(accessToken: string | null): SupabaseClient | null {
  if (hasServiceRoleKey()) return getServerClient()
  const token = (accessToken || '').trim()
  if (!token) return getServerClient()
  if (!isSupabaseConfigured()) return null
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim()
  if (!url || !anonKey) return null

  const hit = tokenClients.get(token)
  if (hit) {
    // Re-insert so the LRU order tracks the most recently used token.
    tokenClients.delete(token)
    tokenClients.set(token, hit)
    return hit
  }
  try {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
    if (tokenClients.size >= TOKEN_CACHE_LIMIT) {
      const oldest = tokenClients.keys().next().value
      if (oldest) tokenClients.delete(oldest)
    }
    tokenClients.set(token, client)
    return client
  } catch (e) {
    console.warn('[supabase] per-user client unavailable:', (e as Error)?.message, '— using local demo store.')
    return getServerClient()
  }
}

/** Test seam: drop cached per-user clients. */
export function resetRequestClients(): void {
  tokenClients.clear()
}

/** Client for a route handler: writes as the signed-in caller when possible. */
export function getClientForRequest(req?: { headers?: HeadersLike } | null): SupabaseClient | null {
  return getClientForToken(bearerToken(req))
}
