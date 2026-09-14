/**
 * Post-assessment feedback: the suggested wording, the validation rule shared by
 * the form and the API, and the browser-side "you still owe us feedback" ticket.
 *
 * The ticket matters because it is what decides whether a candidate is allowed
 * back onto their dashboard and report. It used to be a bare
 * `{ session_id }` object with no timestamp and no expiry, and it was only ever
 * removed after `POST /api/feedback` answered `2xx`. A single failed save (a
 * Supabase hiccup, or the old external form provider hitting its free-tier
 * limit) therefore left the key behind *forever* — `/dashboard/student` and
 * `/result` are both wrapped in `FeedbackGate`, so the candidate was bounced
 * back to `/feedback` on every visit, with no way out. The ticket now carries a
 * timestamp and expires, and `FeedbackGate` clears anything it cannot parse.
 */

export const FEEDBACK_PENDING_KEY = 'calibiai_feedback_pending'
/** Unsubmitted text, so a deferred or failed attempt never loses what was typed. */
export const FEEDBACK_DRAFT_KEY = 'calibiai_feedback_draft'

/** How long a pending-feedback ticket is honoured (7 days). */
export const FEEDBACK_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const feedbackOptions = [
  { label: 'Needs work', text: 'The assessment did not meet my expectations. It should be more challenging and better test practical skills.' },
  { label: 'Could be better', text: 'The assessment could be improved with clearer questions and a better balance of difficulty.' },
  { label: 'Pretty good', text: 'The assessment was satisfactory, but there is room for more relevant, practical questions.' },
  { label: 'Really good', text: 'The assessment was good, well structured, and appropriately challenging. A few refinements would make it even better.' },
  { label: 'Up to the mark', text: 'Good assessment, up to the mark. The questions were relevant, well balanced, and a meaningful test of my skills.' },
] as const

export function validFeedback(rating: unknown, message: unknown): boolean {
  return typeof rating === 'number' && Number.isInteger(rating) && rating >= 1 && rating <= 5
    && typeof message === 'string' && message.trim().length >= 10 && message.length <= 1000
}

/* -------------------------------------------------------------------------- */
/* Pending ticket + draft (browser storage, injected so it is unit-testable)   */
/* -------------------------------------------------------------------------- */

export interface FeedbackPending {
  /** The assessment session the feedback belongs to. */
  session_id: string
  /** When the assessment was submitted (epoch ms). */
  at: number
}

export interface FeedbackDraft {
  rating?: number
  message?: string
  session_id?: string
  /** When the draft was written (epoch ms). */
  at: number
}

export type KvRead = (key: string) => string | null
export type KvWrite = (key: string, value: string) => void
export type KvRemove = (key: string) => void

/** Storage helpers that never throw (private mode / SSR / disabled storage). */
function safeRead(key: string): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeWrite(key: string, value: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(key, value)
  } catch {
    /* Storage unavailable — the ticket is a nudge, not a requirement. */
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.removeItem(key)
  } catch {
    /* Nothing to clean up. */
  }
}

/**
 * Parse the stored ticket. Returns `null` — i.e. "no pending feedback" — when
 * the value is missing, unreadable, stale, or in the pre-timestamp shape the
 * old build wrote (those candidates are released instead of trapped).
 */
export function parseFeedbackPending(raw: string | null, now: number = Date.now()): FeedbackPending | null {
  if (!raw) return null
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const at = Number(parsed.at)
  // No/invalid `at` = written by a build that could leave the key behind with no
  // way to expire it. Treat it as stale so nobody is stuck on /feedback again.
  if (!Number.isFinite(at) || at <= 0) return null
  const age = now - at
  if (age < 0 || age >= FEEDBACK_PENDING_TTL_MS) return null
  return { session_id: String(parsed.session_id ?? '').trim() || 'sess_demo', at }
}

/** Called by `/assessment` right after a successful submission. */
export function markFeedbackPending(
  sessionId: string,
  write: KvWrite = safeWrite,
  now: number = Date.now(),
): void {
  write(FEEDBACK_PENDING_KEY, JSON.stringify({ session_id: sessionId || 'sess_demo', at: now }))
}

/** The live pending ticket, or `null` when the candidate owes nothing. */
export function readFeedbackPending(
  read: KvRead = safeRead,
  now: number = Date.now(),
): FeedbackPending | null {
  let raw: string | null = null
  try {
    raw = read(FEEDBACK_PENDING_KEY)
  } catch {
    return null
  }
  if (raw === null || raw === undefined) return null
  return parseFeedbackPending(raw, now)
}

/**
 * Clear the ticket. Called after a save is accepted (or queued) and when the
 * candidate defers — either way they must be able to reach their dashboard.
 */
export function clearFeedbackPending(remove: KvRemove = safeRemove): void {
  remove(FEEDBACK_PENDING_KEY)
}

/** True when a ticket exists but is stale/unparseable and should be dropped. */
export function isStaleFeedbackTicket(
  read: KvRead = safeRead,
  now: number = Date.now(),
): boolean {
  let raw: string | null = null
  try {
    raw = read(FEEDBACK_PENDING_KEY)
  } catch {
    return false
  }
  if (raw === null || raw === undefined) return false
  return parseFeedbackPending(raw, now) === null
}

/* --------------------------------- drafts --------------------------------- */

export function writeFeedbackDraft(
  draft: Omit<FeedbackDraft, 'at'>,
  write: KvWrite = safeWrite,
  now: number = Date.now(),
): void {
  write(FEEDBACK_DRAFT_KEY, JSON.stringify({ ...draft, at: now }))
}

/**
 * The saved draft, or `null` when there is nothing worth restoring. A draft
 * older than the pending ticket's lifetime is dropped, so the dashboard never
 * nudges a candidate about feedback from a forgotten attempt.
 */
export function readFeedbackDraft(
  read: KvRead = safeRead,
  now: number = Date.now(),
): FeedbackDraft | null {
  let raw: string | null = null
  try {
    raw = read(FEEDBACK_DRAFT_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const at = Number(parsed.at)
    if (!Number.isFinite(at) || at <= 0 || now - at < 0 || now - at >= FEEDBACK_PENDING_TTL_MS) return null
    const rating = Number(parsed.rating)
    return {
      rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      session_id: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
      at,
    }
  } catch {
    return null
  }
}

export function clearFeedbackDraft(remove: KvRemove = safeRemove): void {
  remove(FEEDBACK_DRAFT_KEY)
}
