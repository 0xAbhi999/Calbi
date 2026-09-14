// Server-side Supabase client for API routes.
// Prefers SUPABASE_SERVICE_ROLE_KEY (trusted writes, bypasses RLS); falls back
// to the anon key, in which case writes are still limited to what the RLS
// policies allow for self-scoped rows. Returns null when Supabase is not
// configured (or the package is the compile-time stub) so callers fall back
// to the local JSON demo store.
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
