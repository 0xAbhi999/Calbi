import { NextResponse } from 'next/server'
import { flushQueuedFeedback } from '@/lib/feedbackStore'
import { flushQueuedHelpRequests } from '@/lib/helpStore'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'
import { getServerClient } from '@/lib/supabaseServer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Deliver anything the server accepted but could not write to Supabase.
 *
 * The student dashboard calls this on mount and `/feedback` calls it after a
 * queued save, so a submission that failed once reaches
 * `public.feedback_submissions` on the next visit by *anyone* — the queue lives
 * on the server, not in the candidate's browser. Safe to repeat (rows are keyed
 * by submission id) and rate-limited so it cannot be used to hammer Postgres.
 */
export async function POST(req: Request) {
  // Generous on purpose: a whole college can sit behind one NAT address, and a
  // flush with an empty queue costs one in-memory read.
  const limited = checkRateLimit(`flush:${getClientIp(req)}`, 60, 10 * 60 * 1000)
  if (!limited.allowed) {
    return NextResponse.json(
      { ok: true, flushed: { attempted: 0, synced: 0, failed: 0 }, skipped: true },
      { status: 200, headers: { 'Retry-After': String(limited.retryAfterSec) } },
    )
  }

  const client = getServerClient()
  if (!client) {
    return NextResponse.json({
      ok: true,
      supabase: false,
      flushed: { attempted: 0, synced: 0, failed: 0 },
      help: { attempted: 0, synced: 0, failed: 0 },
      reason: 'Supabase is not configured on this server.',
    })
  }

  try {
    const flushed = await flushQueuedFeedback(client)
    const help = await flushQueuedHelpRequests(client)
    return NextResponse.json({ ok: true, supabase: true, flushed, help })
  } catch (e: any) {
    // Reported as a normal (empty) result: a flush is a background nicety and
    // must never surface as an error to the page that triggered it.
    console.warn('[flush] failed:', e?.message || e)
    return NextResponse.json({
      ok: true,
      supabase: true,
      flushed: { attempted: 0, synced: 0, failed: 0 },
      help: { attempted: 0, synced: 0, failed: 0 },
      error: e?.message || 'Flush failed',
    })
  }
}
