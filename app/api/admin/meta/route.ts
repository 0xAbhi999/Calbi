import { NextResponse } from 'next/server'
import { isAdminRequest } from '@/lib/adminAuth'
import { fetchAdminMeta } from '@/lib/adminStudents'

// College dropdown values + global stat cards. Already cheap (a single-row
// stats view once migration 0006 is applied); the 60s cache is for bursts of
// concurrent admins, not egress.
const CACHE_TTL_MS = 60000
let cache: { at: number; payload: any } | null = null

export async function GET(req: Request) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return NextResponse.json({ ...cache.payload, cached: true })
    }
    const meta = await fetchAdminMeta()
    const payload = { ...meta, cached: false }
    cache = { at: Date.now(), payload }
    return NextResponse.json(payload)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to load dashboard meta.' }, { status: 500 })
  }
}
