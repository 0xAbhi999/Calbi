import { NextResponse } from 'next/server'
import { isAdminRequest } from '@/lib/adminAuth'
import { fetchStudentsFingerprint, fetchStudentsPage } from '@/lib/adminStudents'
import { parsePageParams } from '@/lib/adminPage'

// Short server-side cache for page payloads. The dashboard polls frequently
// and several admins/tabs may be open at once — without this every poll is a
// fresh Supabase read (egress is billed per byte out of Supabase). 20s keeps
// the view live while collapsing concurrent polls into one upstream read.
const CACHE_TTL_MS = 20000
const CACHE_MAX_ENTRIES = 30
const cache = new Map<string, { at: number; payload: any }>()

function cached(key: string): any | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at >= CACHE_TTL_MS) {
    cache.delete(key)
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
  try {
    const url = new URL(req.url)

    // Lightweight change probe (~1KB): the dashboard polls this on its refresh
    // interval and only requests a table page when `fingerprint` changes.
    if (url.searchParams.get('check') === '1') {
      const fp = await fetchStudentsFingerprint()
      return NextResponse.json({ ...fp, ok: true })
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
    const hit = cached(key)
    if (hit) return NextResponse.json({ ...hit, cached: true })

    const result = await fetchStudentsPage(params)
    // The fingerprint lets the client skip re-downloading until data changes.
    const { fingerprint } = await fetchStudentsFingerprint()
    const payload = { ...result, fingerprint, cached: false, updated_at: new Date().toISOString() }
    store(key, payload)
    return NextResponse.json(payload)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to load students.' }, { status: 500 })
  }
}
