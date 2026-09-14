import { NextResponse } from 'next/server'
import { getAllFeedback, getFeedbackForStudent } from '@/lib/db'
import { flushQueuedFeedback, saveFeedbackSubmission } from '@/lib/feedbackStore'
import { fetchFeedbackForStudent } from '@/lib/persist'
import { getServerClient } from '@/lib/supabaseServer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Candidate feedback ("which candidate gave which feedback").
 *
 *   POST /api/feedback   { id?, student_id, session_id?, email?, rating, message, source? }
 *   GET  /api/feedback?student_id=&email=        → that candidate's submissions
 *
 * Supabase `feedback_submissions` is the destination. The local store is written
 * too — as the demo-mode store when Supabase is not configured, and as the retry
 * queue when a write fails — so the endpoint answers `200` for every accepted
 * submission instead of leaving a candidate stuck on `/feedback` (see
 * `lib/feedbackStore.ts` for why a 5xx here used to strand them).
 */
export async function POST(req: Request) {
  let body: any = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const client = getServerClient()
  const result = await saveFeedbackSubmission(body, client)

  // A rejected payload is the only failure the candidate can act on.
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  // Best-effort: deliver anything queued by an earlier failed write while the
  // connection is already open. Failures here change nothing for the caller.
  let flushed = { attempted: 0, synced: 0, failed: 0 }
  try {
    if (client) flushed = await flushQueuedFeedback(client)
  } catch (e: any) {
    console.warn('[feedback] queue flush failed:', e?.message || e)
  }

  return NextResponse.json({
    ok: true,
    saved: true,
    /** False only in fully local demo mode, where the local store *is* the store. */
    supabase_configured: !!client,
    feedback: result.submission,
    /** True when the row is in Postgres right now. */
    supabase: result.stored === 'supabase',
    /** True when it was accepted and is waiting for the database to come back. */
    queued: result.stored === 'queue',
    stored: result.stored,
    reason: result.reason,
    duplicate: !!result.duplicate,
    flushed,
  })
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const studentId = url.searchParams.get('student_id') || url.searchParams.get('user_id') || ''
    const email = url.searchParams.get('email') || ''
    if (!studentId && !email) {
      // Admin/diagnostic listing — same shape as the local store.
      return NextResponse.json({ feedback: getAllFeedback() })
    }
    const local = getFeedbackForStudent(studentId, email)
    const sb = getServerClient()
    if (sb) {
      const remote = await fetchFeedbackForStudent(sb, studentId, email)
      if (remote) {
        const mine = remote
        if (mine.length) {
          // Newest first, Supabase preferred, de-duplicated by id.
          const seen = new Set<string>()
          const merged = [...mine, ...local].filter(f => {
            const key = String(f.id) || `${f.created_at}|${f.message}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          merged.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          return NextResponse.json({ feedback: merged, supabase: true })
        }
      }
    }
    return NextResponse.json({ feedback: local })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to load feedback.' }, { status: 500 })
  }
}
