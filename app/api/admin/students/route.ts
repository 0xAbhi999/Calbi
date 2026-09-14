import { NextResponse } from 'next/server'
import { isAdminRequest } from '@/lib/adminAuth'
import { fetchStudentsFingerprint, fetchStudentsPage } from '@/lib/adminStudents'
import { parsePageParams } from '@/lib/adminPage'

// Short server-side cache for page payloads. The dashboard polls frequently
// and several admins/tabs may be open at once — without this every poll is a
// fresh Supabase read (egress is billed per byte out of Supabase). 20s keeps
// the view live while collapsing concurrent polls into one upstream read.
const CACHE_TTL_MS = 20000
const STALE_MAX_MS = 5 * 60 * 1000
const CHECK_CACHE_TTL_MS = 15000
const CACHE_MAX_ENTRIES = 30
const cache = new Map<string, { at: number; payload: any }>()
let lastCheck: { at: number; payload: any } | null = null

function cached(key: string): any | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at >= CACHE_TTL_MS) {
    // Keep the expired entry until STALE_MAX_MS so a transient upstream error
    // can return it without a full-table fallback.
    return null
  }
  return hit.payload
}

function store(key: string, payload: any): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
  cache.set(key, { at: Date.now(), payload })
}

export async function GET(req: Request) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let requestKey: string | null = null
  try {
    const url = new URL(req.url)

    // Lightweight change probe (~1KB): the dashboard polls this on its refresh
    // interval and only requests a table page when `fingerprint` changes.
    if (url.searchParams.get('check') === '1') {
      if (lastCheck && Date.now() - lastCheck.at < CHECK_CACHE_TTL_MS) {
        return NextResponse.json({ ...lastCheck.payload, cached: true }, {
          headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=20' },
        })
      }
      const fp = await fetchStudentsFingerprint()
      const payload = { ...fp, ok: true }
      lastCheck = { at: Date.now(), payload }
      return NextResponse.json(payload, {
        headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=20' },
      })
    }

    const params = parsePageParams({
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('pageSize'),
      college: url.searchParams.get('college'),
      q: url.searchParams.get('q'),
      sort: url.searchParams.get('sort'),
      dir: url.searchParams.get('dir'),
      assessed: url.searchParams.get('assessed'),
    })
    const key = JSON.stringify(params)
    requestKey = key
    const hit = cached(key)
    if (hit) return NextResponse.json({ ...hit, cached: true })

    const result = await fetchStudentsPage(params)
    // The fingerprint lets the client skip re-downloading until data changes.
    const { fingerprint } = await fetchStudentsFingerprint()
    const payload = { ...result, fingerprint, cached: false, updated_at: new Date().toISOString() }
    store(key, payload)
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=30' },
    })
  } catch (e: any) {
    // Never turn a transient Supabase timeout into a full-table fallback. Keep
    // the last good page visible for a short window instead; the next probe or
    // manual refresh will retry without multiplying egress.
    if (requestKey) {
      const stale = cache.get(requestKey)
      if (stale && Date.now() - stale.at < STALE_MAX_MS) {
        return NextResponse.json({
          ...stale.payload,
          cached: true,
          stale: true,
          warning: 'Live data is temporarily unavailable; showing the last successful page.',
        }, { headers: { 'Cache-Control': 'private, max-age=5' } })
      }
    }
    return NextResponse.json({ error: e?.message || 'Failed to load students.' }, { status: 503, headers: { 'Retry-After': '15' } })
  }
}
