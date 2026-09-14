import { NextResponse } from 'next/server'
import { isAdminRequest } from '@/lib/adminAuth'
import { fetchAllStudents, fetchStudentsFingerprint } from '@/lib/adminStudents'
import { filterRows } from '@/lib/adminFilters'

// Short server-side cache for the full payload. The dashboard polls
// frequently and several admins/tabs may be open at once — without this every
// poll is a full multi-table Supabase read (egress is billed per byte out of
// Supabase). 20s keeps the view live while collapsing concurrent polls into
// one upstream read.
const CACHE_TTL_MS = 20000
let cache: { key: string; at: number; payload: any } | null = null

export async function GET(req: Request) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const url = new URL(req.url)
    const college = url.searchParams.get('college') || ''
    const q = url.searchParams.get('q') || ''

    // Lightweight change probe (~1KB): the dashboard polls this on its refresh
    // interval and only requests the full dataset when `fingerprint` changes.
    if (url.searchParams.get('check') === '1') {
      const fp = await fetchStudentsFingerprint()
      return NextResponse.json({ ...fp, ok: true })
    }

    const key = `${college}|${q}`
    if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
      return NextResponse.json({ ...cache.payload, cached: true })
    }
    const { students, source, warning, sources, feedbackFromSupabase, canSync } = await fetchAllStudents()
    const rows = filterRows(students, { college, q })
    // The fingerprint lets the client skip re-downloading until data changes.
    const { fingerprint } = await fetchStudentsFingerprint()
    const payload = {
      students: rows,
      total: students.length,
      filtered: rows.length,
      source,
      sources,
      feedbackFromSupabase,
      canSync,
      warning,
      fingerprint,
      cached: false,
      updated_at: new Date().toISOString(),
    }
    cache = { key, at: Date.now(), payload }
    return NextResponse.json(payload)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to load students.' }, { status: 500 })
  }
}
