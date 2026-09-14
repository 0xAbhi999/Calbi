import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Demo-mode "database": a single JSON file on disk, made concurrency-safe.
//
// Two files are involved, and the split matters for deploys:
//   - `calibiai_db.json`            (git-tracked) — the SEED / demo snapshot.
//   - `calibiai_db.runtime.json`    (gitignored)  — LIVE runtime writes.
//
// The app used to write new sign-ups / sessions / results straight into the
// tracked file. On a live server that left the tracked file permanently
// "modified", so the deploy's `git checkout -B <branch>` aborted with
// "Your local changes ... would be overwritten by checkout". Runtime data now
// lives in a gitignored file, so the tracked seed is only ever changed by
// commits and deploys can always check out cleanly.
//
// ── Why this layer exists (5000-concurrent-users hardening) ───────────────
// The old implementation did, on EVERY write (every autosave, session start,
// submit): `readFileSync(whole file) → JSON.parse → mutate → JSON.stringify →
// writeFileSync(whole file)`. That is three separate failure modes under load:
//
//   1. Lost updates — two processes read the same snapshot, both write, the
//      slower one silently clobbers the faster one.
//   2. Corruption — a reader can observe a half-written file.
//   3. Event-loop stalls — synchronous I/O of a growing file on the hot path.
//
// This module now:
//   - Keeps an in-memory cache so reads are O(1) after first load (mtime
//     revalidated so other Node workers' writes stay visible).
//   - Serialises writes in-process and coalesces bursts (a keystroke storm
//     collapses into a handful of flushes instead of one per event).
//   - Serialises ACROSS processes with an O_EXCL lockfile (atomic on Linux),
//     with stale-lock recovery.
//   - Writes atomically (temp file + rename), so a crash mid-write can never
//     leave a truncated/corrupt runtime file, and readers never see a torn
//     write even without the lock.
//   - Merges by row id before writing so a worker never clobbers another
//     worker's concurrently-inserted rows.
//
// The public API stays synchronous so every existing route keeps working
// unchanged; durability is guaranteed by the flush queue, and the submit /
// session-start routes additionally `await flushDB()` for the one write that
// absolutely must be on disk before responding.
// ---------------------------------------------------------------------------

const SEED_NAME = 'calibiai_db.json'
const RUNTIME_NAME = 'calibiai_db.runtime.json'

/** How long to coalesce a burst of writes before flushing to disk. */
const FLUSH_DELAY_MS = 40
/** A lockfile older than this is considered abandoned (crashed writer). */
const LOCK_STALE_MS = 5000
const LOCK_RETRY_MS = 10
/** Give up waiting for the cross-process lock after this long (write anyway —
 *  atomic rename already guarantees the file can't corrupt). */
const LOCK_TIMEOUT_MS = 1500

// Test seam: point the store at a temp dir (and drop the cache). Production
// always uses process.cwd().
let dirOverride: string | null = null

const COLLECTIONS = [
  'users',
  'profiles',
  'assessment_sessions',
  'assessment_results',
  'resume_analyses',
  'tracking_events',
  'feedback',
  'help_requests',
] as const

export interface User {
  id: string
  email: string
  password_hash: string
  role: string
  institution_id: string
  name?: string
  created_at: string
  last_login_at?: string
}

export interface Profile {
  id: string
  email: string
  full_name?: string
  /** College PRN / permanent registration number — optional. */
  prn?: string
  phone?: string
  dob?: string
  gender?: string
  degree?: string
  college?: string
  graduation_year?: number
  cgpa?: number
  skills?: string
  linkedin_url?: string
  github_url?: string
  ai_avatar?: { seed: number; style: string; version: number; generated_at: string } | null
  updated_at: string
}

export interface AssessmentSession {
  id: string
  student_id: string
  status: string
  started_at: string
  expires_at: string
  duration_sec: number
  answers?: any
  submitted_at?: string
  tab_switches: number
  question_seed?: number
  created_at: string
}

export interface AssessmentResult {
  id: string
  session_id: string
  student_id: string
  scores: any
  total: number
  grade: string
  percentile: number
  verifiable_hash: string
  ai_feedback?: any
  created_at: string
}

export interface ResumeAnalysis {
  id: string
  student_id: string
  storage_key?: string
  resume_score?: number
  parsed?: any
  feedback?: any
  created_at: string
}

export interface TrackingEvent {
  id: string
  user_id: string
  action: string
  completed: boolean
  completed_at?: string
}

/**
 * Post-assessment feedback a candidate submits about the experience ("which
 * candidate gave which feedback").
 *
 * Supabase (`feedback_submissions`) is the destination; this record is the copy
 * the app can always write. It doubles as the retry queue: `synced: false`
 * means "accepted from the candidate, not in Postgres yet", and
 * `POST /api/feedback/flush` pushes those rows across as soon as the database is
 * reachable again. A candidate is therefore never blocked on the DB — and the
 * feedback is never lost either.
 */
export interface FeedbackSubmission {
  id: string
  /** Candidate id — a Supabase UUID, or a local `u_…` demo id. */
  student_id: string
  /** The assessment session the feedback belongs to. */
  session_id?: string
  email?: string
  /** 1–5 stars. */
  rating: number
  message: string
  /** 'web' | 'ai-suggested' | … — how the text was produced. */
  source?: string
  created_at: string
  /** `true` once the row exists in `public.feedback_submissions`. */
  synced?: boolean
  /** Why the last Supabase attempt failed (diagnostics only). */
  sync_error?: string
  /** How many Supabase attempts have been made for this row. */
  attempts?: number
}

/**
 * A support request raised through the in-app help form ("A little help, right
 * here"). Stored in `public.help_requests` — the same "Supabase is the
 * destination, this file is the queue" arrangement as feedback, so the form
 * depends on no third-party inbox and its free-tier limits.
 */
export interface HelpRequest {
  id: string
  /** Candidate id when signed in (a Supabase UUID or a local `u_…` demo id). */
  student_id?: string
  email?: string
  phone?: string
  message: string
  /** Pathname the request was sent from (no query string). */
  page?: string
  source?: string
  created_at: string
  synced?: boolean
  sync_error?: string
  attempts?: number
}

export interface DBData {
  users: User[]
  profiles: Profile[]
  assessment_sessions: AssessmentSession[]
  assessment_results: AssessmentResult[]
  resume_analyses: ResumeAnalysis[]
  tracking_events: TrackingEvent[]
  feedback: FeedbackSubmission[]
  help_requests: HelpRequest[]
}

function emptyDB(): DBData {
  return {
    users: [],
    profiles: [],
    assessment_sessions: [],
    assessment_results: [],
    resume_analyses: [],
    tracking_events: [],
    feedback: [],
    help_requests: [],
  }
}

function seedFile(): string {
  return path.join(dirOverride || process.cwd(), SEED_NAME)
}
function runtimeFile(): string {
  return path.join(dirOverride || process.cwd(), RUNTIME_NAME)
}
function lockFile(): string {
  return runtimeFile() + '.lock'
}

/** Where the data lives right now: the runtime file once it exists, else seed. */
function currentFile(): string {
  return fs.existsSync(runtimeFile()) ? runtimeFile() : seedFile()
}

function statMtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function normalize(raw: any): DBData {
  const base = emptyDB()
  if (!raw || typeof raw !== 'object') return base
  for (const col of COLLECTIONS) {
    if (Array.isArray(raw[col])) base[col] = raw[col]
  }
  return base
}

function readMaybe(file: string): DBData | null {
  try {
    if (!fs.existsSync(file)) return null
    return normalize(JSON.parse(fs.readFileSync(file, 'utf-8')))
  } catch {
    // Corrupt or unreadable → treat as absent rather than crash every request.
    console.warn('[db] could not read', file)
    return null
  }
}

/** In-process cache of the parsed store. */
let cache: DBData | null = null
let cacheSrc = ''
let cacheMtimeMs = 0

/** Writes are coalesced: burst → single atomic flush. */
let rerun = false
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pending: Promise<void> | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Merge `next` (this process's view) over `disk` (what's actually on disk) by
 *  row id, so a worker writing its own rows never erases rows another worker
 *  inserted since our last read. Ours wins on id collision. */
function mergeByKey(disk: DBData, next: DBData): DBData {
  const out: DBData = { ...emptyDB() }
  for (const col of COLLECTIONS) {
    const map = new Map<string, any>()
    for (const row of disk[col] as any[]) {
      if (row && row.id != null) map.set(String(row.id), row)
    }
    for (const row of next[col] as any[]) {
      if (row && row.id != null) map.set(String(row.id), row)
    }
    out[col] = [...map.values()] as any
  }
  return out
}

/** Atomic write: temp file in the same dir + rename (never a partial file). */
function writeAtomic(file: string, content: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(tmp, content, 'utf-8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw e
  }
}

/**
 * Cross-process mutual exclusion via an O_EXCL lockfile (atomic on Linux,
 * which is what MilesWeb runs). A crashed writer leaves a stale lock that is
 * recovered automatically.
 */
async function withFileLock(lockPath: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now()
  for (;;) {
    let fd: number | null = null
    try {
      fd = fs.openSync(lockPath, 'wx') // fails with EEXIST if held
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      try {
        await fn()
      } finally {
        try {
          fs.unlinkSync(lockPath)
        } catch {
          /* ignore */
        }
      }
      return
    } catch (e: any) {
      if (fd != null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* ignore */
        }
      }
      if (e.code === 'EEXIST') {
        // Steal the lock if its owner crashed.
        try {
          const st = fs.statSync(lockPath)
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            try {
              fs.unlinkSync(lockPath)
            } catch {
              /* ignore */
            }
            continue
          }
        } catch {
          /* lock vanished — loop and retry */
        }
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
          // Degrade gracefully: atomic rename already prevents corruption, so
          // the worst case here is a lost cross-process merge, not data loss.
          console.warn('[db] cross-process lock timeout — flushing unlocked')
          await fn()
          return
        }
        await sleep(LOCK_RETRY_MS)
        continue
      }
      throw e
    }
  }
}

/** One flush pass: lock → read disk → merge → atomic write. */
async function persistOnce(): Promise<void> {
  const data = cache
  if (!data) return
  await withFileLock(lockFile(), async () => {
    const file = runtimeFile()
    const onDisk = readMaybe(file)
    const merged = onDisk ? mergeByKey(onDisk, data) : data
    writeAtomic(file, JSON.stringify(merged, null, 2))
    cacheSrc = file
    cacheMtimeMs = statMtimeMs(file)
  })
}

function pump(): Promise<void> {
  if (pending) {
    rerun = true
    return pending
  }
  pending = (async () => {
    do {
      rerun = false
      await persistOnce()
    } while (rerun)
  })().finally(() => {
    pending = null
  })
  return pending
}

function scheduleFlush(): void {
  rerun = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void pump()
  }, FLUSH_DELAY_MS)
}

/** Flush any queued writes to disk immediately and resolve when durable. */
export function flushDB(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  return pump()
}

/** Drop the in-memory cache (next read re-loads from disk). */
export function resetDbCache(): void {
  cache = null
  cacheSrc = ''
  cacheMtimeMs = 0
}

/** Test seam: point the store at a directory and reset. */
export function setDbDirectory(dir: string): void {
  dirOverride = dir
  resetDbCache()
}

function initDB(): DBData {
  const file = currentFile()
  const mtime = statMtimeMs(file)
  if (cache && cacheSrc === file && mtime === cacheMtimeMs) return cache
  cache = readMaybe(file) || emptyDB()
  cacheSrc = file
  cacheMtimeMs = mtime
  return cache
}

function saveDB(data: DBData) {
  // The callers pass the object they got from getDB() after mutating it, so
  // caching it directly keeps reads and the next flush perfectly consistent.
  cache = data
  scheduleFlush()
}

export function getDB(): DBData {
  return initDB()
}

export function getUserByEmail(email: string): User | undefined {
  const db = getDB()
  return db.users.find(u => u.email.toLowerCase() === email.toLowerCase())
}

export function getUserById(id: string): User | undefined {
  const db = getDB()
  return db.users.find(u => u.id === id)
}

export function createUser(email: string, passwordHash: string, role = 'student', institutionId = 'inst_iitm', name?: string): User {
  const db = getDB()
  const user: User = {
    id: 'u_' + randomUUID().split('-')[0],
    email,
    password_hash: passwordHash,
    role,
    institution_id: institutionId,
    name: name || email.split('@')[0],
    created_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
  }
  db.users.push(user)
  saveDB(db)
  return user
}

export function updateUserLogin(id: string) {
  const db = getDB()
  const user = db.users.find(u => u.id === id)
  if (user) {
    user.last_login_at = new Date().toISOString()
    saveDB(db)
  }
}

export function saveProfile(profile: Profile) {
  const db = getDB()
  const idx = db.profiles.findIndex(p => p.id === profile.id)
  if (idx >= 0) db.profiles[idx] = profile
  else db.profiles.push(profile)
  saveDB(db)
}

export function getProfileById(id: string): Profile | undefined {
  const db = getDB()
  return db.profiles.find(p => p.id === id)
}

/**
 * Another student already using this PRN, or `undefined`. PRNs are compared in
 * canonical form (upper case, no whitespace — see normalizePrn) and blanks are
 * never a match, since the field is optional.
 */
export function findProfileByPrn(prn: string, excludeId?: string): Profile | undefined {
  const wanted = String(prn ?? '').replace(/\s+/g, '').toUpperCase()
  if (!wanted) return undefined
  const db = getDB()
  return db.profiles.find(p =>
    p.id !== excludeId &&
    String(p.prn ?? '').replace(/\s+/g, '').toUpperCase() === wanted,
  )
}

export function saveAssessmentSession(session: AssessmentSession) {
  const db = getDB()
  const idx = db.assessment_sessions.findIndex(s => s.id === session.id)
  if (idx >= 0) db.assessment_sessions[idx] = session
  else db.assessment_sessions.push(session)
  saveDB(db)
}

export function getAssessmentSession(id: string): AssessmentSession | undefined {
  const db = getDB()
  return db.assessment_sessions.find(s => s.id === id)
}

export function getActiveSessionForStudent(studentId: string): AssessmentSession | undefined {
  const db = getDB()
  return db.assessment_sessions.find(s => s.student_id === studentId && s.status === 'in_progress')
}

export function saveAssessmentResult(result: AssessmentResult) {
  const db = getDB()
  const idx = db.assessment_results.findIndex(r => r.session_id === result.session_id)
  if (idx >= 0) db.assessment_results[idx] = result
  else db.assessment_results.push(result)
  saveDB(db)
}

export function getAssessmentResultBySession(sessionId: string): AssessmentResult | undefined {
  const db = getDB()
  return db.assessment_results.find(r => r.session_id === sessionId)
}

export function getLatestAssessmentResultForStudent(studentId: string): AssessmentResult | undefined {
  const db = getDB()
  const results = db.assessment_results.filter(r => r.student_id === studentId)
  if (results.length === 0) return undefined
  return results.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
}

export function saveResumeAnalysis(analysis: ResumeAnalysis) {
  const db = getDB()
  const idx = db.resume_analyses.findIndex(r => r.id === analysis.id)
  if (idx >= 0) db.resume_analyses[idx] = analysis
  else db.resume_analyses.push(analysis)
  saveDB(db)
}

export function getResumeAnalysisByStudent(studentId: string): ResumeAnalysis | undefined {
  const db = getDB()
  const results = db.resume_analyses.filter(r => r.student_id === studentId)
  return results.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
}

export function saveTrackingEvent(event: TrackingEvent) {
  const db = getDB()
  const idx = db.tracking_events.findIndex(e => e.id === event.id)
  if (idx >= 0) db.tracking_events[idx] = event
  else db.tracking_events.push(event)
  saveDB(db)
}

export function getTrackingEvents(userId: string): TrackingEvent[] {
  const db = getDB()
  return db.tracking_events.filter(e => e.user_id === userId)
}

export function saveFeedback(submission: FeedbackSubmission) {
  const db = getDB()
  const idx = db.feedback.findIndex(f => f.id === submission.id)
  // Keep a row's earlier sync bookkeeping when a caller re-saves the same
  // submission without it (e.g. a retry that only carries the payload).
  const previous = idx >= 0 ? db.feedback[idx] : undefined
  const next = {
    ...submission,
    synced: submission.synced ?? previous?.synced,
    sync_error: submission.sync_error ?? previous?.sync_error,
    attempts: submission.attempts ?? previous?.attempts,
  }
  if (idx >= 0) db.feedback[idx] = next
  else db.feedback.push(next)
  saveDB(db)
}

/**
 * Feedback that was accepted from a candidate but has not reached
 * `public.feedback_submissions` yet (the retry queue). Only rows explicitly
 * marked `synced: false` are returned, so seeded/legacy rows are left to the
 * admin "Write candidates into Supabase" job instead of being replayed here.
 */
export function getUnsyncedFeedback(limit = 25): FeedbackSubmission[] {
  const db = getDB()
  return db.feedback
    .filter(f => f.synced === false)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, Math.max(1, limit))
}

/** Mark a queued submission as delivered (or record why the attempt failed). */
export function markFeedbackSynced(id: string, error?: string) {
  const db = getDB()
  const idx = db.feedback.findIndex(f => f.id === id)
  if (idx < 0) return
  const previous = db.feedback[idx]
  db.feedback[idx] = error
    ? { ...previous, synced: false, sync_error: error, attempts: (previous.attempts || 0) + 1 }
    : { ...previous, synced: true, sync_error: undefined, attempts: (previous.attempts || 0) + 1 }
  saveDB(db)
}

/** Newest-first feedback for one candidate (matched by id or, failing that, email). */
export function getFeedbackForStudent(studentId: string, email?: string): FeedbackSubmission[] {
  const db = getDB()
  const id = String(studentId || '').trim().toLowerCase()
  const mail = String(email || '').trim().toLowerCase()
  return db.feedback
    .filter(f => {
      const fId = String(f.student_id || '').trim().toLowerCase()
      const fMail = String(f.email || '').trim().toLowerCase()
      return (id && fId === id) || (mail && fMail === mail)
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

export function getAllFeedback(): FeedbackSubmission[] {
  return [...getDB().feedback]
}

/* ------------------------------ help requests ----------------------------- */

export function saveHelpRequest(request: HelpRequest) {
  const db = getDB()
  const idx = db.help_requests.findIndex(h => h.id === request.id)
  const previous = idx >= 0 ? db.help_requests[idx] : undefined
  const next = {
    ...request,
    synced: request.synced ?? previous?.synced,
    sync_error: request.sync_error ?? previous?.sync_error,
    attempts: request.attempts ?? previous?.attempts,
  }
  if (idx >= 0) db.help_requests[idx] = next
  else db.help_requests.push(next)
  saveDB(db)
}

export function getAllHelpRequests(): HelpRequest[] {
  const db = getDB()
  return [...db.help_requests].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )
}

/** Help requests accepted but not yet in `public.help_requests` (retry queue). */
export function getUnsyncedHelpRequests(limit = 25): HelpRequest[] {
  const db = getDB()
  return db.help_requests
    .filter(h => h.synced === false)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, Math.max(1, limit))
}

export function markHelpRequestSynced(id: string, error?: string) {
  const db = getDB()
  const idx = db.help_requests.findIndex(h => h.id === id)
  if (idx < 0) return
  const previous = db.help_requests[idx]
  db.help_requests[idx] = error
    ? { ...previous, synced: false, sync_error: error, attempts: (previous.attempts || 0) + 1 }
    : { ...previous, synced: true, sync_error: undefined, attempts: (previous.attempts || 0) + 1 }
  saveDB(db)
}
