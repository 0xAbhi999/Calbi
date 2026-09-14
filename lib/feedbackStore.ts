/**
 * Where candidate feedback actually goes.
 *
 * **Supabase (`public.feedback_submissions`) is the only destination.** There is
 * no third-party form service in this path any more — a free-tier submission
 * limit used to turn into an error on the candidate's screen, and because the
 * page only cleared its "feedback pending" ticket on a 2xx response the
 * candidate was then bounced back to `/feedback` on every visit, unable to see
 * their dashboard or their report.
 *
 * The two rules this module enforces:
 *
 *   1. **A candidate is never blocked on the database.** Every accepted
 *      submission returns `ok: true`. If the Postgres write fails the row is
 *      kept in the local store as `synced: false` — a queue, not a copy — and
 *      `flushQueuedFeedback()` replays it as soon as the database answers
 *      again. Validation errors (400) are the only way to be told "no".
 *   2. **Nothing is lost.** The queue lives on the server, so a later flush from
 *      any request (the student dashboard does one on mount, `/feedback` does
 *      one after a queued save) delivers it even if the candidate closed the tab.
 */
import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getUnsyncedFeedback, markFeedbackSynced, saveFeedback, type FeedbackSubmission } from './db.ts'
import { validFeedback } from './feedback.ts'
import { persistFeedbackDetailed, type PersistOutcome } from './persist.ts'

export interface FeedbackInput {
  id?: unknown
  student_id?: unknown
  user_id?: unknown
  email?: unknown
  session_id?: unknown
  rating?: unknown
  message?: unknown
  source?: unknown
}

export interface FeedbackSaved {
  ok: true
  submission: FeedbackSubmission
  /** `supabase` — the row is in Postgres. `queue` — accepted, waiting to sync. */
  stored: 'supabase' | 'queue'
  /** True when the same submission id was already stored (a retry). */
  duplicate?: boolean
  /** Why the row is in the queue instead of Postgres (`stored === 'queue'`). */
  reason?: string
}

export interface FeedbackRejected {
  ok: false
  error: string
  status: number
}

export type FeedbackSaveResult = FeedbackSaved | FeedbackRejected

/** Client payload → the stored row. Rejects anything that is not valid feedback. */
export function normaliseFeedback(body: any): FeedbackSaveResult | { submission: FeedbackSubmission } {
  const rating = Number(body?.rating)
  const message = String(body?.message ?? '').trim()
  if (!validFeedback(rating, message)) {
    return {
      ok: false,
      error: 'Feedback needs a rating from 1 to 5 and at least 10 characters.',
      status: 400,
    }
  }
  return {
    submission: {
      // The client reuses this id when retrying, so a transient failure cannot
      // create duplicate rows in Postgres or in the queue.
      id: String(body?.id ?? '').trim() || randomUUID(),
      student_id: String(body?.student_id ?? body?.user_id ?? '').trim() || 'sess_demo',
      session_id: String(body?.session_id ?? '').trim() || undefined,
      email: String(body?.email ?? '').trim().toLowerCase() || undefined,
      rating,
      message,
      source: String(body?.source ?? '').trim() || 'web',
      created_at: new Date().toISOString(),
    },
  }
}

/** A short, safe, operator-facing reason for a queued row. */
export function describePersistFailure(outcome: PersistOutcome): string {
  if (outcome.tableMissing) {
    return 'feedback_submissions is missing — run supabase/migrations/0004_feedback_submissions.sql'
  }
  if (outcome.code === '42501') {
    return 'Supabase row-level security rejected the write (set SUPABASE_SERVICE_ROLE_KEY or widen the policy)'
  }
  if (outcome.code === '23514') return 'Supabase rejected the row (a CHECK constraint failed)'
  if (outcome.code === '23503') return 'Supabase rejected the row (the candidate profile is missing)'
  return outcome.message || 'The Supabase write failed'
}

/**
 * Store one submission. Supabase first; on failure the row is queued locally so
 * the candidate still gets a success and the feedback still reaches Postgres.
 * Never throws for a database problem.
 */
export async function saveFeedbackSubmission(
  body: FeedbackInput,
  client: SupabaseClient | null,
): Promise<FeedbackSaveResult> {
  const parsed = normaliseFeedback(body) as FeedbackSaved | FeedbackRejected | { submission: FeedbackSubmission }
  if ('ok' in parsed) return parsed
  const submission = (parsed as { submission: FeedbackSubmission }).submission

  if (!client) {
    // No Supabase configured: the local store is the only store, and the row is
    // queued so it is pushed across the moment Supabase is switched on.
    saveFeedback({ ...submission, synced: false, sync_error: 'Supabase is not configured on this server' })
    return { ok: true, submission, stored: 'queue', reason: 'Supabase is not configured on this server' }
  }

  const outcome = await persistFeedbackDetailed(client, submission)
  if (outcome.ok) {
    saveFeedback({ ...submission, synced: true })
    return { ok: true, submission, stored: 'supabase', duplicate: outcome.duplicate }
  }

  const reason = describePersistFailure(outcome)
  console.warn(`[feedback] queued ${submission.id}:`, outcome.code || '', outcome.message)
  saveFeedback({
    ...submission,
    synced: false,
    sync_error: [outcome.code, outcome.message].filter(Boolean).join(' '),
    attempts: 1,
  })
  return { ok: true, submission, stored: 'queue', reason }
}

export interface FlushResult {
  attempted: number
  synced: number
  /** Rows that still have not reached Supabase after this run. */
  failed: number
}

/**
 * Replay queued feedback into Supabase. Called on every `/feedback` POST, by
 * `POST /api/feedback/flush` (the student dashboard does this on mount), and by
 * the admin sync — whichever runs first delivers the row.
 */
export async function flushQueuedFeedback(
  client: SupabaseClient | null,
  limit = 25,
): Promise<FlushResult> {
  if (!client) return { attempted: 0, synced: 0, failed: 0 }
  const rows = getUnsyncedFeedback(limit)
  let synced = 0
  for (const row of rows) {
    const outcome = await persistFeedbackDetailed(client, row)
    if (outcome.ok) {
      markFeedbackSynced(row.id)
      synced++
    } else {
      markFeedbackSynced(row.id, [outcome.code, outcome.message].filter(Boolean).join(' '))
    }
  }
  return { attempted: rows.length, synced, failed: rows.length - synced }
}
