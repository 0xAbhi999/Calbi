// `fetch()` that always carries the signed-in student's Supabase JWT.
//
// Why this exists: the API routes write to Postgres with a server-side client
// that has no session of its own, and every student-owned table is protected by
// `auth.uid() = id`. The only way those writes succeed without a
// SUPABASE_SERVICE_ROLE_KEY is for the browser to forward the user's access
// token, so the server can talk to PostgREST *as that user*. Any route called
// with a plain `fetch()` therefore loses the write silently — this wrapper is
// the one place that attaches the header, so no call site can forget it.
import { getAccessToken } from './supabase.ts'

/**
 * Same signature as `fetch`. Adds `Authorization: Bearer <access_token>` when a
 * Supabase session exists and the caller did not set the header itself. In demo
 * mode (no Supabase configured) it is a pass-through, so local development is
 * unaffected. Never throws for a missing/failed session lookup.
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers((init.headers as HeadersInit) || undefined)
  if (!headers.has('Authorization')) {
    const token = await getAccessToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
  }
  return fetch(input, { ...init, headers })
}

/** Header object form, for call sites that build their own RequestInit. */
export async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(extra || {}) }
  const token = await getAccessToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}
