// Supabase client — used only when NEXT_PUBLIC_SUPABASE_* env vars are set.
// When unconfigured, the app runs in fully local demo mode (localStorage),
// so `npm run dev` works out of the box with zero setup.
//
// IMPORTANT: this function must NEVER throw. It is called from click handlers
// (login, instructions "START 120-MIN TIMER", profile/resume save, assessment
// submit) and several of those call sites invoke it outside their try/catch.
// A malformed value (e.g. a placeholder URL without the https:// prefix) used
// to escape as an uncaught "Invalid supabaseUrl: Must be a valid HTTP or
// HTTPS URL." error and crash the Start Assessment flow. Configuration
// problems now degrade to local demo mode instead.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null
let resolved = false
let warned = false

function warnOnce(msg: string) {
  if (warned) return
  warned = true
  // eslint-disable-next-line no-console
  console.warn(`[supabase] ${msg} Falling back to local demo mode.`)
}

export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  return !!(url && key && /^https?:\/\//i.test(url.trim()))
}

export function getSupabase(): SupabaseClient | null {
  if (resolved) return client
  resolved = true
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  if (!url || !key) {
    client = null
    return null
  }
  if (!/^https?:\/\//i.test(url)) {
    warnOnce(`NEXT_PUBLIC_SUPABASE_URL ("${url}") must be a valid http(s) URL.`)
    client = null
    return null
  }
  try {
    client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Keep URL auto-detection off: /auth/callback performs the exchange
        // itself. If this were `true`, supabase-js would consume the single-use
        // `?code=` first and the callback page's own exchangeCodeForSession()
        // would then fail with "already used" and bounce the user to /login.
        detectSessionInUrl: false,
        // REQUIRED. supabase-js defaults `flowType` to 'implicit', which makes
        // Supabase return the session in the URL *fragment*
        // (#access_token=…) instead of a `?code=` query param. The callback
        // page exchanges a `?code=`, so under the default the session was never
        // picked up and every Google login ended back on /login. Pinning PKCE
        // makes Supabase send `?code=` — and it is the safer flow anyway.
        flowType: 'pkce',
      },
    })
  } catch (e) {
    warnOnce(`Supabase client could not be created (${(e as Error)?.message || e}).`)
    client = null
  }
  return client
}

/**
 * The signed-in user's access token, or null in demo mode / when signed out.
 *
 * Every API route that writes to a student's own Postgres rows needs this: the
 * RLS policies are `auth.uid() = id`, and the server-side client is only able
 * to satisfy them when the caller's JWT is forwarded (see lib/supabaseServer.ts).
 * Without it the write is rejected and the student's data never reaches
 * Supabase. `getSession()` also transparently refreshes an expired token.
 */
export async function getAccessToken(): Promise<string | null> {
  const sb = getSupabase()
  if (!sb) return null
  try {
    const { data } = await sb.auth.getSession()
    return data?.session?.access_token || null
  } catch {
    return null
  }
}
