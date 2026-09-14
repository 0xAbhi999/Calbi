// Admin data source — one row per student joining profile + latest assessment
// result + latest resume analysis. The admin reads BOTH backends and merges
// them: the Supabase `student_profiles_full` view (service-role reads bypass
// RLS) and the local JSON store. Neither store is a complete picture on its
// own — students who signed up through the deployed app exist only in Postgres,
// while the curated/demo candidates shipped in `calibiai_db.json` (non-UUID
// `u_…` ids) were never inserted into Postgres and exist only locally. Reading
// just one of them is what made the dashboard show a fraction of the students
// the rest of the app can serve.
//
// Both /api/admin/students and /api/admin/export share this module so the
// on-screen table and the downloaded CSV always agree.
//
// fetchAllStudents() returns a richer result object (rows + source + per-store
// counts + warning) so the dashboard can tell the admin *where* the data came
// from and surface a clear reason when Supabase is configured but something is
// off (e.g. the flattened export view has not been created yet). The Supabase
// query always tries the bounded view path; schema failures fail closed with a
// warning, and a Supabase failure never hides the local rows.
import { getAllFeedback, getDB } from './db.ts'
import { getServerClient } from './supabaseServer.ts'
import { fetchAllFeedback } from './persist.ts'
import { buildRow, fillAssessmentFrom, mergeStudentRows, sortRows } from './studentRows.ts'
import {
  NIL_UUID,
  buildSearchOr,
  compareAdminRows,
  filterAdminRows,
  remoteWindowFor,
  sliceMergedPage,
  type AdminPageParams,
} from './adminPage.ts'
import type { AdminFeedbackEntry, AdminStudentRow } from './csv'

export interface AdminStudentsResult {
  /** Fully joined rows, ready for the table / CSV. */
  students: AdminStudentRow[]
  /** Which backend produced the rows: Supabase or the local JSON demo store. */
  source: 'supabase' | 'local'
  /** Optional human-readable note about a fallback / degraded read. */
  warning?: string
  /** How many rows came from each store (after de-duplication). */
  sources?: { supabase: number; local: number }
  /** True when feedback rows could be read from Supabase as well. */
  feedbackFromSupabase?: boolean
  /** True when the host can write the local candidates into Supabase (service role set). */
  canSync?: boolean
}

/** One feedback submission, normalised to the shape the admin matches on. */
interface FeedbackRow {
  id: string
  student_id: string
  email: string
  rating: any
  message: string
  session_id: string
  source: string
  created_at: string
}

function toFeedbackRow(r: any): FeedbackRow | null {
  if (!r) return null
  const message = String(r.message ?? '').trim()
  const rating = r.rating ?? null
  if (!message && (rating === null || rating === undefined)) return null
  return {
    id: String(r.id ?? '').trim(),
    student_id: String(r.student_ref ?? r.student_id ?? '').trim().toLowerCase(),
    email: String(r.email ?? '').trim().toLowerCase(),
    rating,
    message,
    session_id: String(r.session_id ?? '').trim(),
    source: String(r.source ?? '').trim(),
    created_at: String(r.created_at ?? ''),
  }
}

/**
 * Attach every submission to its candidate row, matched by candidate id
 * (`student_id` / `student_ref`) **or** email, because a candidate may be stored
 * in Postgres under a UUID while their feedback arrived under a local `u_…` id
 * (or the other way round). The flat columns remain the latest submission for
 * the table and CSV; `feedback_history` keeps the complete newest-first list
 * for the expanded admin view.
 */
function attachFeedback(rows: AdminStudentRow[], feedback: FeedbackRow[]): AdminStudentRow[] {
  if (!feedback.length) return rows
  const byStudent = new Map<string, FeedbackRow[]>()
  const push = (key: string, row: FeedbackRow) => {
    if (!key) return
    const list = byStudent.get(key)
    if (list) list.push(row)
    else byStudent.set(key, [row])
  }
  for (const row of feedback) {
    push(row.student_id, row)
    push(row.email, row)
  }
  const newestFirst = (a: FeedbackRow, b: FeedbackRow) =>
    new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
  // A submission is written to the local store and Supabase with the same id,
  // so both reads return it. Seeded rows can have different ids after the sync,
  // therefore also use the submission content as a mirror-safe signature.
  const signatures = (f: FeedbackRow) => [
    f.id ? `id:${f.id}` : '',
    `content:${f.student_id}|${f.email}|${f.session_id}|${f.created_at}|${f.rating}|${f.message}`,
  ].filter(Boolean)
  const asAdminEntry = (f: FeedbackRow): AdminFeedbackEntry => ({
    id: f.id,
    student_id: f.student_id,
    email: f.email,
    rating: f.rating === null || f.rating === undefined ? '' : String(f.rating),
    message: f.message,
    session_id: f.session_id,
    source: f.source,
    created_at: f.created_at,
  })
  return rows.map((r) => {
    const key = (r.student_id || '').trim().toLowerCase()
    const mail = (r.email || '').trim().toLowerCase()
    const seen = new Set<string>()
    const mine = [...(byStudent.get(key) || []), ...(byStudent.get(mail) || [])]
      .filter(f => {
        const sigs = signatures(f)
        if (sigs.some(sig => seen.has(sig))) return false
        sigs.forEach(sig => seen.add(sig))
        return true
      })
      .sort(newestFirst)
    if (!mine.length) return r
    const latest = mine[0]
    // Attach onto the row that is already fully built. This used to re-run
    // buildRow() with only the profile + feedback, which silently threw away
    // every assessment column — score, grade, percentile, all module and
    // behavioural scores, resume score, assessment date, and `has_assessment`
    // flipped to "No". So the moment a candidate submitted feedback their
    // report vanished from the dashboard and the CSV. Spreading the existing
    // row keeps all of it and only overwrites the feedback columns.
    return {
      ...r,
      feedback_rating: latest.rating === null || latest.rating === undefined ? '' : String(latest.rating),
      feedback_message: String(latest.message ?? ''),
      feedback_at: String(latest.created_at ?? ''),
      feedback_count: String(mine.length),
      feedback_history: mine.map(asAdminEntry),
    }
  })
}

/** Local feedback rows (demo mode / runtime store). */
function localFeedbackRows(): FeedbackRow[] {
  return getAllFeedback()
    .map(toFeedbackRow)
    .filter((r): r is FeedbackRow => !!r)
}

/** What could prevent reading every row; collated so the UI can show it. */
export interface FetchError {
  message: string
}

/** A completed/expired session is evidence that the candidate took the test,
 * even when the result write failed or is still being evaluated. */
function sessionCountsAsAssessment(session: any): boolean {
  if (!session) return false
  const status = String(session.status || '').toLowerCase()
  return status === 'submitted' || status === 'expired' || !!session.submitted_at
}

/** Build one AdminStudentRow from a Supabase `student_profiles_full` view row. */
function fromViewRow(r: any, assessmentSession?: any): AdminStudentRow {
  return buildRow({
    student_id: r.student_id,
    email: r.email,
    role: r.role,
    profile: r,
    scores: r.assessment_scores
      ? {
          scores: r.assessment_scores,
          total: r.talent_score,
          grade: r.grade,
          percentile: r.percentile,
          verifiable_hash: r.verifiable_hash,
          created_at: r.assessment_created_at,
        }
      : null,
    resume_score: r.resume_score,
    resume_parsed: r.resume_parsed,
    assessment_attempted: sessionCountsAsAssessment(assessmentSession) || !!r.assessment_session_id,
    verifiable_hash: r.verifiable_hash,
    assessed_at: r.assessment_created_at || assessmentSession?.submitted_at || assessmentSession?.created_at,
    created_at: r.profile_created_at,
  })
}

/**
 * Columns read from the `student_profiles_full` view. This is only the
 * identity, resume-summary and score fields buildRow actually needs; the two
 * heavy JSONB blobs the admin never renders (`resume_feedback` and
 * `assessment_ai_feedback`) plus storage/tenant metadata are excluded. The
 * dashboard downloads a page repeatedly, so every unnecessary byte is
 * multiplied by page size and refresh count.
 * (`feedback_rating/message/created_at` from migration 0004 are likewise
 * skipped — feedback is joined explicitly so the dashboard works whether or
 * not that migration has been applied.)
 */
const VIEW_COLUMNS = [
  // Only fields used by buildRow / the expanded row are selected. In
  // particular, do not pull storage keys, avatar config, tenant metadata or
  // the view's heavy AI-feedback JSONB column into every admin page.
  'student_id', 'email', 'role', 'full_name', 'prn', 'phone', 'dob', 'gender',
  'degree', 'college', 'graduation_year', 'cgpa', 'skills', 'linkedin_url',
  'github_url', 'profile_created_at', 'resume_score', 'resume_parsed',
  'assessment_session_id', 'talent_score', 'grade', 'percentile',
  'assessment_scores', 'verifiable_hash', 'assessment_created_at',
].join(',')

// Migration 0003 added `prn`; migration 0002 already has every other field
// needed by the table. Retry with this still-narrow projection rather than
// `select=*`, which would pull the heavy feedback/AI JSONB columns for every
// student when an older view is deployed.
const LEGACY_VIEW_COLUMNS = VIEW_COLUMNS
  .split(',')
  .filter(column => column !== 'prn')
  .join(',')

/** Read the export view with a bounded projection in every schema generation. */
async function fetchViewRows(sb: any): Promise<{ data?: any[] | null; error?: { message: string } | null }> {
  const narrow = await sb.from('student_profiles_full').select(VIEW_COLUMNS).eq('role', 'student')
  if (!narrow.error) return narrow
  if (/column|does not exist/i.test(String(narrow.error.message || ''))) {
    return sb.from('student_profiles_full').select(LEGACY_VIEW_COLUMNS).eq('role', 'student')
  }
  return narrow
}

/** The export view only has an assessment session id when a result exists.
 * Read sessions separately so a submitted/expired attempt with a missing or
 * delayed result is still marked as taken in the admin dashboard. */
async function latestAssessmentSessions(sb: any): Promise<Map<string, any>> {
  try {
    const { data, error } = await sb
      .from('assessment_sessions')
      .select('id,student_id,status,submitted_at,created_at')
      .order('created_at', { ascending: false })
    if (error) return new Map()
    const latest = new Map<string, any>()
    for (const session of data || []) {
      if (!sessionCountsAsAssessment(session)) continue
      const id = String(session?.student_id || '')
      if (id && !latest.has(id)) latest.set(id, session)
    }
    return latest
  } catch {
    return new Map()
  }
}

/**
 * Rows from the local JSON store (seed `calibiai_db.json` overridden by the
 * gitignored `calibiai_db.runtime.json` once the app has written live demo
 * data). Extracted so `fetchAllStudents()` can merge it with Supabase.
 *
 * Iterate *profiles* rather than users: in demo/seed data many profiles were
 * created without a matching row in `users`, so a users-first join would
 * silently drop most students from the admin view.
 */
function fetchLocalStudents(): AdminStudentRow[] {
  const db = getDB()
  const rows: AdminStudentRow[] = []
  const seen = new Set<string>()
  for (const profile of db.profiles) {
    seen.add(profile.id)
    const user = db.users.find(u => u.id === profile.id)
    const result = db.assessment_results
      .filter(r => r.student_id === profile.id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
    const session = db.assessment_sessions
      .filter(s => s.student_id === profile.id && sessionCountsAsAssessment(s))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
    const resume = db.resume_analyses
      .filter(r => r.student_id === profile.id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
    rows.push(
      buildRow({
        student_id: profile.id,
        email: profile.email || user?.email,
        role: user?.role || 'student',
        profile,
        scores: result || null,
        resume_score: resume?.resume_score,
        resume_parsed: resume?.parsed,
        assessment_attempted: sessionCountsAsAssessment(session),
        verifiable_hash: result?.verifiable_hash,
        assessed_at: result?.created_at || session?.submitted_at || session?.created_at,
        created_at: profile.updated_at || user?.created_at,
      }),
    )
  }
  // Registered accounts that somehow never got a profile row still count.
  for (const user of db.users) {
    if (seen.has(user.id)) continue
    rows.push(
      buildRow({
        student_id: user.id,
        email: user.email,
        role: user.role,
        profile: {},
        created_at: user.created_at,
      }),
    )
  }
  return sortRows(rows)
}

/**
 * Fetch every student (joined) — Supabase rows merged with the local JSON
 * store, so a student is missing only if they exist in neither. Never throws:
 * returns a result object with a diagnostic `warning` instead.
 */
export async function fetchAllStudents(): Promise<AdminStudentsResult> {
  const sb = getServerClient()
  let remote: AdminStudentRow[] = []
  let warning = ''

  if (sb) {
    try {
      // 1) Prefer the flattened export view (narrow columns — see VIEW_COLUMNS).
      const { data, error } = await fetchViewRows(sb)
      if (!error) {
        const sessions = await latestAssessmentSessions(sb)
        remote = (data || []).map((r: any) => {
          const session = sessions.get(String(r.student_id || ''))
          return fromViewRow(r, session)
        })
        // The view is RLS-protected (security_invoker). With the anon key and no
        // service role, the server-side admin request has no auth context, so
        // RLS hides every row and Postgres looks empty. Surface that clearly.
        if (remote.length === 0 && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
          warning =
            'No live students were returned. The admin is reading Supabase with the anon key, which is restricted by Row Level Security. Set SUPABASE_SERVICE_ROLE_KEY so the admin can read every student record.'
        }
      } else {
        // 2) Fail closed for a missing/broken view. Reading every base-table
        // row here would make a deployment/schema mistake take down the
        // database through egress. Local demo rows remain visible and the
        // warning points directly to the required migration.
        warning =
          `Could not load the Supabase student view: ${error.message}. Apply the Supabase migrations before using live admin data.`
      }
    } catch (e: any) {
      warning = `Could not load students from Supabase: ${e?.message || e}`
    }
  }

  // 3) Local demo store — always read, then merge. Students seeded into
  //    calibiai_db.json were never written to Postgres, so a Supabase-only
  //    read can never show them.
  let local: AdminStudentRow[] = []
  try {
    local = fetchLocalStudents()
  } catch (e: any) {
    const localError = `Could not load students from the local store: ${e?.message || e}`
    warning = warning ? `${warning} ${localError}` : localError
  }

  const merged = mergeStudentRows(remote, local)

  // 4) Feedback ("which candidate gave which feedback") — read from both stores
  //    and attach the latest submission to each row. Best-effort: the dashboard
  //    still works when migration 0004 has not been applied yet.
  let feedback: FeedbackRow[] = []
  let feedbackFromSupabase = false
  try {
    feedback = localFeedbackRows()
  } catch (e: any) {
    warning = warning || `Could not read local feedback: ${e?.message || e}`
  }
  if (sb) {
    const remoteFeedback = await fetchAllFeedback(sb)
    if (remoteFeedback) {
      feedbackFromSupabase = true
      feedback.push(
        ...remoteFeedback
          .map(toFeedbackRow)
          .filter((r): r is FeedbackRow => !!r),
      )
    }
  }

  return {
    students: attachFeedback(merged.rows, feedback),
    source: sb ? 'supabase' : 'local',
    sources: { supabase: merged.remote, local: merged.local },
    feedbackFromSupabase,
    canSync: !!sb && !!(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    warning: warning || undefined,
  }
}

// ---------------------------------------------------------------------------
// Change-detection fingerprint — the egress saver behind the admin's live view.
// ---------------------------------------------------------------------------

export interface StudentsFingerprint {
  /** Stable string: identical iff nothing the dashboard shows has changed. */
  fingerprint: string
  counts: { profiles: number; results: number; resumes: number; feedback: number }
  updated_at: string
}

/**
 * A ~1KB summary of everything the dashboard renders, used by
 * `GET /api/admin/students?check=1`. The admin page polls this on its refresh
 * interval and only re-downloads the full (multi-MB) dataset when the
 * fingerprint differs — so an idle dashboard costs ~120 tiny requests/hour
 * instead of ~120 full-table downloads/hour. Local-store counts are folded in
 * too (free — no Supabase traffic) so seeded/demo edits are also detected.
 * Never throws: degrades to a time-based fingerprint when Supabase is down.
 */
async function readStudentsFingerprint(): Promise<StudentsFingerprint> {
  const sb = getServerClient()
  const parts: Record<string, string | number> = { remote: sb ? 1 : 0 }
  const counts = { profiles: -1, results: -1, resumes: -1, feedback: -1 }
  if (sb) {
    try {
      // Migration 0007 collapses the old eight count/MAX requests into one
      // tiny row. If it is missing, fail closed: do not resurrect the old
      // eight-query fallback on every poll. The table page remains available
      // and a manual refresh still works; auto-refresh resumes as soon as the
      // migration is applied and the probe becomes visible.
      const compact = await sb.from('admin_change_probe').select('*').limit(1).maybeSingle()
      if (!compact.error && compact.data) {
        const d: any = compact.data
        const profiles = Number(d.profiles_count) || 0
        const results = Number(d.results_count) || 0
        const resumes = Number(d.resumes_count) || 0
        const feedback = Number(d.feedback_count) || 0
        counts.profiles = profiles
        counts.results = results
        counts.resumes = resumes
        counts.feedback = feedback
        parts.profiles = profiles
        parts.results = results
        parts.resumes = resumes
        parts.feedback = feedback
        parts.pStamp = String(d.profiles_stamp || '')
        parts.rStamp = String(d.results_stamp || '')
        parts.resStamp = String(d.resumes_stamp || '')
        parts.fStamp = String(d.feedback_stamp || '')
        parts.sStamp = String(d.sessions_stamp || '')
        parts.sessions = Number(d.sessions_count) || 0
      } else {
        // Keep this fingerprint stable. A time bucket would cause the client
        // to download another full page every minute while the compact probe is
        // unavailable, which is exactly the egress failure this guard prevents.
        parts.remote_probe = 'unavailable'
      }
    } catch {
      parts.remote_probe = 'unavailable'
    }
  }
  try {
    const db = getDB()
    parts.local_profiles = db.profiles.length
    parts.local_results = db.assessment_results.length
    parts.local_resumes = db.resume_analyses.length
    parts.local_feedback = db.feedback.length
  } catch {
    // Local store unreadable — ignore, remote parts still identify changes.
  }
  const fingerprint = Object.keys(parts).sort().map(k => `${k}=${parts[k]}`).join('|')
  return { fingerprint, counts, updated_at: new Date().toISOString() }
}

// Change probes are intentionally cached and coalesced. A dashboard tab polls
// every 30 seconds, and multiple admin tabs/instances can otherwise fan that
// one check into eight PostgREST requests each. A 15-second freshness window is
// invisible to an operator but removes the burst load and keeps the probe from
// becoming its own source of egress/connection pressure.
const FINGERPRINT_TTL_MS = 15_000
let fingerprintCache: { at: number; value: StudentsFingerprint } | null = null
let fingerprintInFlight: Promise<StudentsFingerprint> | null = null

export async function fetchStudentsFingerprint(): Promise<StudentsFingerprint> {
  if (fingerprintCache && Date.now() - fingerprintCache.at < FINGERPRINT_TTL_MS) {
    return fingerprintCache.value
  }
  if (fingerprintInFlight) return fingerprintInFlight
  fingerprintInFlight = readStudentsFingerprint()
    .then(value => {
      fingerprintCache = { at: Date.now(), value }
      return value
    })
    .finally(() => { fingerprintInFlight = null })
  return fingerprintInFlight
}

// ---------------------------------------------------------------------------
// Server-side pagination — one SQL window per table page instead of the whole
// dataset, so even on busy exam days (fingerprint changing every poll) each
// refresh costs ~one page, not the full table.
// ---------------------------------------------------------------------------

export interface StudentsPageResult {
  students: AdminStudentRow[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  source: 'supabase' | 'local'
  warning?: string
  /** Matching (filtered) totals per store, after de-duplication. */
  sources?: { supabase: number; local: number }
  feedbackFromSupabase?: boolean
  canSync?: boolean
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const FEEDBACK_COLUMNS = 'id,student_id,student_ref,email,session_id,rating,message,source,created_at'

/**
 * Whether the export view has the `assessment_attempted` column (migration
 * 0006). Probed lazily on the first assessed-only request and re-probed every
 * 10 minutes, so running the migration takes effect without a restart.
 * Without the column the "assessed only" filter falls back to "has a result"
 * (talent_score IS NOT NULL) — identical except for attempts whose result
 * write failed or is still pending.
 */
let attemptedCol: { value: boolean; at: number } | null = null
const ATTEMPTED_PROBE_TTL_MS = 10 * 60 * 1000

/** Whether the narrow VIEW_COLUMNS select works (false on pre-0003 views → use `*`). */
let narrowSelectOk: boolean | null = null

function mentionsColumn(error: any, column: string): boolean {
  const msg = String(error?.message || '').toLowerCase()
  return msg.includes(column.toLowerCase()) && (/column/.test(msg) || error?.code === '42703')
}

/**
 * One filtered + ordered + ranged read of the export view, with exact count.
 * Retries across (narrow|wide select) × (attempted|talent-only assessed
 * filter) when the deployment's view predates a column, and throws a
 * `{ fallback: true }`-marked error for anything else (missing view, RLS
 * surprise, network blip) so the caller can use the full in-memory path.
 */
async function queryRemoteWindow(
  sb: any,
  params: AdminPageParams,
  offset: number,
  limit: number,
): Promise<{ data: any[]; count: number }> {
  const assessed = params.assessed
  const probeFresh = !!attemptedCol && Date.now() - attemptedCol.at < ATTEMPTED_PROBE_TTL_MS
  let wide = narrowSelectOk === false
  let talentOnly = assessed && probeFresh && attemptedCol!.value === false
  for (let attempt = 0; attempt < 4; attempt++) {
    let q = sb
      .from('student_profiles_full')
      .select(wide ? LEGACY_VIEW_COLUMNS : VIEW_COLUMNS, { count: 'exact' })
      .eq('role', 'student')
    if (params.college) q = q.ilike('college', params.college)
    if (params.q) {
      const orBody = buildSearchOr(params.q)
      q = orBody ? q.or(orBody) : q.eq('student_id', NIL_UUID)
    }
    if (assessed) {
      q = talentOnly ? q.not('talent_score', 'is', null) : q.eq('assessment_attempted', true)
    }
    const asc = params.dir === 'asc'
    q =
      params.sort === 'score'
        ? q.order('talent_score', { ascending: asc, nullsFirst: asc })
        : q.order('full_name', { ascending: asc, nullsFirst: asc })
    q = q
      .order('college', { ascending: true, nullsFirst: true })
      .order('student_id', { ascending: true })
      .range(offset, offset + limit - 1)
    const { data, count, error } = await q
    if (!error) {
      if (!wide) narrowSelectOk = true
      if (assessed && !talentOnly) attemptedCol = { value: true, at: Date.now() }
      return { data: data || [], count: count ?? 0 }
    }
    if (assessed && !talentOnly && mentionsColumn(error, 'assessment_attempted')) {
      talentOnly = true
      attemptedCol = { value: false, at: Date.now() }
      continue
    }
    if (!wide && /column/i.test(String(error.message || ''))) {
      wide = true
      narrowSelectOk = false
      continue
    }
    // Only schema/setup failures should trigger the intentionally expensive
    // full-table fallback. A timeout, connection reset, rate limit or RLS
    // failure must NOT download every profile/result/resume just because one
    // admin page refresh happened during a transient incident.
    const message = String(error.message || 'Window query failed.')
    const schemaFailure =
      error?.code === '42P01' || error?.code === '42703' || error?.code === 'PGRST205' ||
      /relation|table|view|schema cache|does not exist|unknown column/i.test(message)
    throw Object.assign(new Error(message), { fallback: schemaFailure })
  }
  throw Object.assign(new Error('Window query failed.'), { fallback: true })
}

/**
 * Which local rows already exist remotely (by id or email) — two tiny
 * `.in()` queries over the (small) local set instead of downloading the whole
 * remote id list. Fails OPEN (empty sets → local rows shown separately) so a
 * transient error never hides students.
 */
async function remoteDupKeys(
  sb: any,
  localRows: AdminStudentRow[],
): Promise<{ ids: Set<string>; emails: Set<string> }> {
  const empty = { ids: new Set<string>(), emails: new Set<string>() }
  if (!localRows.length) return empty
  const uuids = [
    ...new Set(localRows.map(r => r.student_id.trim()).filter(id => UUID_RE.test(id))),
  ]
  const emails = [
    ...new Set(
      localRows
        .map(r => r.email.trim().toLowerCase())
        .filter(e => e && !/[,()]/.test(e)),
    ),
  ]
  try {
    const [byId, byEmail] = await Promise.all([
      uuids.length
        ? sb.from('profiles').select('id').in('id', uuids)
        : Promise.resolve({ data: [] }),
      emails.length
        ? sb.from('profiles').select('id,email').in('email', emails)
        : Promise.resolve({ data: [] }),
    ])
    if (byId.error || byEmail.error) return empty
    for (const r of byId.data || []) empty.ids.add(String(r.id || '').toLowerCase())
    for (const r of byEmail.data || []) {
      empty.ids.add(String(r.id || '').toLowerCase())
      if (r.email) empty.emails.add(String(r.email).toLowerCase())
    }
    return empty
  } catch {
    return empty
  }
}

/** Latest submitted/expired session per student, for the page's ids only. */
async function pageSessions(sb: any, studentIds: string[]): Promise<Map<string, any>> {
  const map = new Map<string, any>()
  const uuids = [...new Set(studentIds.map(s => String(s || '')).filter(id => UUID_RE.test(id)))]
  if (!uuids.length) return map
  try {
    const { data, error } = await sb
      .from('assessment_sessions')
      .select('id,student_id,status,submitted_at,created_at')
      .in('student_id', uuids)
      .order('created_at', { ascending: false })
    if (error) return map
    for (const s of data || []) {
      if (!sessionCountsAsAssessment(s)) continue
      const id = String(s?.student_id || '')
      if (id && !map.has(id)) map.set(id, s)
    }
  } catch {
    // Best-effort: rows without session data still show their results.
  }
  return map
}

/**
 * Feedback for the page's students only: local matches are exact and in
 * memory; remote matches are two tiny `.in()` queries (`student_ref` is
 * always set — see persistFeedback — so no uuid-column query is needed).
 */
async function pageFeedback(
  sb: any,
  rows: AdminStudentRow[],
  localAll: FeedbackRow[],
): Promise<{ rows: FeedbackRow[]; fromSupabase: boolean }> {
  const out: FeedbackRow[] = []
  let fromSupabase = false
  if (!rows.length) return { rows: out, fromSupabase }
  const idSet = new Set(rows.map(r => r.student_id.trim().toLowerCase()).filter(Boolean))
  const mailSet = new Set(rows.map(r => r.email.trim().toLowerCase()).filter(Boolean))
  out.push(
    ...localAll.filter(
      f => (f.student_id && idSet.has(f.student_id)) || (f.email && mailSet.has(f.email)),
    ),
  )
  if (sb) {
    const safeIds = [...idSet].filter(s => !/[,()]/.test(s))
    const safeEmails = [...mailSet].filter(s => !/[,()]/.test(s))
    try {
      const queries: Promise<any>[] = []
      if (safeIds.length) {
        queries.push(sb.from('feedback_submissions').select(FEEDBACK_COLUMNS).in('student_ref', safeIds).limit(100))
      }
      if (safeEmails.length) {
        queries.push(sb.from('feedback_submissions').select(FEEDBACK_COLUMNS).in('email', safeEmails).limit(100))
      }
      const results = await Promise.all(queries)
      if (results.every(r => !r.error)) {
        fromSupabase = true
        for (const r of results) {
          out.push(
            ...(r.data || []).map(toFeedbackRow).filter((f: FeedbackRow | null): f is FeedbackRow => !!f),
          )
        }
      }
    } catch {
      // Table missing (pre-0004) or transient — local matches still attach.
    }
  }
  return { rows: out, fromSupabase }
}

/** Degraded path: whole dataset in memory, then filter/sort/slice (setup-error states only). */
async function fallbackPage(
  params: AdminPageParams,
  viewWarning: string,
): Promise<StudentsPageResult> {
  const all = await fetchAllStudents()
  const filtered = filterAdminRows(all.students, params).sort(compareAdminRows(params.sort, params.dir))
  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / params.pageSize))
  const page = Math.min(params.page, totalPages)
  return {
    students: filtered.slice((page - 1) * params.pageSize, page * params.pageSize),
    total,
    page,
    pageSize: params.pageSize,
    totalPages,
    source: all.source,
    sources: all.sources,
    feedbackFromSupabase: all.feedbackFromSupabase,
    canSync: all.canSync,
    warning: [viewWarning, all.warning].filter(Boolean).join(' ') || undefined,
  }
}

/**
 * One table page: filtered + ordered + joined rows with an exact total.
 *
 * Remote bytes per page are O(pageSize + localCount): one SQL window with an
 * exact count, one sessions lookup and two feedback lookups for the page's
 * ids, plus two tiny de-dup probes — instead of the full multi-MB table.
 * Never throws: schema failures degrade to bounded/local rows with a warning,
 * while transient Supabase failures are allowed to reach the API's stale-page
 * guard rather than triggering a full-table read.
 */
export async function fetchStudentsPage(params: AdminPageParams): Promise<StudentsPageResult> {
  const sb = getServerClient()
  const cmp = compareAdminRows(params.sort, params.dir)
  const canSync = !!sb && !!(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()

  // 1) Local store — free (no egress), always fully available.
  let localFiltered: AdminStudentRow[] = []
  let warning = ''
  try {
    localFiltered = filterAdminRows(fetchLocalStudents(), params)
  } catch (e: any) {
    warning = `Could not load students from the local store: ${e?.message || e}`
  }
  let localFeedback: FeedbackRow[] = []
  try {
    localFeedback = localFeedbackRows()
  } catch {
    // No local feedback — remote matches may still attach below.
  }

  // 2) Demo mode (no Supabase): paginate the local store in memory.
  if (!sb) {
    const sorted = [...localFiltered].sort(cmp)
    const total = sorted.length
    const totalPages = Math.max(1, Math.ceil(total / params.pageSize))
    const page = Math.min(params.page, totalPages)
    const pageRows = sorted.slice((page - 1) * params.pageSize, page * params.pageSize)
    const fb = await pageFeedback(null, pageRows, localFeedback)
    return {
      students: attachFeedback(pageRows, fb.rows),
      total,
      page,
      pageSize: params.pageSize,
      totalPages,
      source: 'local',
      sources: { supabase: 0, local: total },
      feedbackFromSupabase: false,
      canSync: false,
      warning: warning || undefined,
    }
  }

  // 3) Drop local rows shadowed by a live row (remote wins for identity).
  const dup = await remoteDupKeys(sb, localFiltered)
  const isDup = (r: AdminStudentRow) =>
    dup.ids.has(r.student_id.trim().toLowerCase()) || dup.emails.has(r.email.trim().toLowerCase())
  const localUnique = localFiltered.filter(r => !isDup(r))
  const dupedLocal = localFiltered.filter(isDup)
  const L = localUnique.length

  // 4) Remote window (+exact count). One re-query when the data shrank under
  //    the admin and the requested page no longer exists.
  let page = params.page
  let P = (page - 1) * params.pageSize
  let { offset, limit } = remoteWindowFor(page, params.pageSize, L)
  let win: { data: any[]; count: number }
  try {
    win = await queryRemoteWindow(sb, params, offset, limit)
  } catch (e: any) {
    if (e?.fallback) {
      return fallbackPage(params, `Live paged query failed (${e?.message || e}); the paginated view is unavailable, so the setup fallback was used.`)
    }
    // Preserve the failure for the API layer. It can serve a short-lived stale
    // page; silently switching to a multi-megabyte full read is exactly what
    // caused the egress spikes during transient Supabase failures.
    throw e
  }
  let remoteCount = win.count
  let total = remoteCount + L
  if (total > 0 && P >= total) {
    page = Math.max(1, Math.ceil(total / params.pageSize))
    P = (page - 1) * params.pageSize
    ;({ offset, limit } = remoteWindowFor(page, params.pageSize, L))
    try {
      win = await queryRemoteWindow(sb, params, offset, limit)
    } catch (e: any) {
      if (e?.fallback) {
        return fallbackPage(params, `Live paged query failed (${e?.message || e}); the paginated view is unavailable, so the setup fallback was used.`)
      }
      throw e
    }
    remoteCount = win.count
    total = remoteCount + L
  }
  const unfiltered = !params.college && !params.q && !params.assessed
  if (unfiltered && remoteCount === 0 && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    warning =
      warning ||
      'No live students were returned. The admin is reading Supabase with the anon key, which is restricted by Row Level Security. Set SUPABASE_SERVICE_ROLE_KEY so the admin can read every student record.'
  }

  // 5) Build remote rows: sessions for exact "taken" display + assessment fill
  //    from shadowed local rows (same enrichment as mergeStudentRows).
  const sessions = await pageSessions(
    sb,
    win.data.map((r: any) => String(r.student_id || '')),
  )
  const remoteRows = win.data.map((r: any) => {
    const id = String(r.student_id || '')
    let built = fromViewRow(r, sessions.get(id))
    const shadow = dupedLocal.find(
      l =>
        (id && l.student_id.trim().toLowerCase() === id.toLowerCase()) ||
        (r.email && l.email.trim().toLowerCase() === String(r.email).toLowerCase()),
    )
    if (shadow) built = fillAssessmentFrom(built, shadow)
    return built
  })

  // 6) Merge the window with ALL (already filtered) local rows, sort, slice.
  //    NOTE: a row enriched in step 5 sorts by its filled-in score while its
  //    SQL position used the unfilled one, so pre-sync demo duplicates can sit
  //    one page off until "Write candidates into Supabase" runs. Cosmetic,
  //    self-healing, and only for unsynced duplicates.
  const merged = [...remoteRows, ...localUnique].sort(cmp)
  const pageRows = sliceMergedPage(merged, page, params.pageSize, offset)

  // 7) Feedback for the page's students only.
  const fb = await pageFeedback(sb, pageRows, localFeedback)

  return {
    students: attachFeedback(pageRows, fb.rows),
    total,
    page,
    pageSize: params.pageSize,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    source: 'supabase',
    sources: { supabase: remoteCount, local: L },
    feedbackFromSupabase: fb.fromSupabase,
    canSync,
    warning: warning || undefined,
  }
}

// ---------------------------------------------------------------------------
// Dashboard meta: college list + global stats in ~1KB (migration 0006's
// single-row `admin_stats` view), with a bounded legacy scan for older DBs.
// ---------------------------------------------------------------------------

export interface AdminMetaStats {
  total: number
  colleges: number
  assessed: number
  avg: number
}

export interface AdminMetaResult {
  colleges: string[]
  stats: AdminMetaStats
  updated_at: string
}

interface RemoteMeta {
  total: number
  assessed: number
  scored: number
  scoreSum: number
  colleges: string[]
}

const EMPTY_META: RemoteMeta = { total: 0, assessed: 0, scored: 0, scoreSum: 0, colleges: [] }

/** Remote aggregates. Total function: returns zeros when Supabase is unreachable. */
async function fetchRemoteMeta(sb: any): Promise<RemoteMeta> {
  // 1) Single-row stats view (migration 0006) — the ~200-byte path.
  try {
    const { data, error } = await sb.from('admin_stats').select('*').limit(1).maybeSingle()
    if (!error && data) {
      const scored = Number(data.scored_students) || 0
      return {
        total: Number(data.total_students) || 0,
        assessed: Number(data.assessed_students) || 0,
        scored,
        scoreSum: (Number(data.avg_score) || 0) * scored,
        colleges: Array.isArray(data.colleges) ? data.colleges.map((c: any) => String(c)) : [],
      }
    }
  } catch {
    // View missing (pre-0006) — fall through to the narrow scan.
  }
  // 2) Bounded legacy fallback. Do not scan the export view or all base-table
  // rows when migration 0006 is absent: that was the second source of large
  // admin reads in the incident logs. This sample is capped and is only a
  // temporary degraded view until `admin_stats` is deployed. The table page
  // remains the source for actual student rows, while the cards may be partial.
  try {
    const { data, count, error } = await sb
      .from('student_profiles_full')
      .select('talent_score,college', { count: 'exact' })
      .eq('role', 'student')
      .range(0, 99)
    if (!error && data) {
      let assessed = 0
      let scoreSum = 0
      const colleges = new Set<string>()
      for (const r of data) {
        if (r.talent_score !== null && r.talent_score !== undefined) {
          assessed++
          scoreSum += Number(r.talent_score) || 0
        }
        const c = String(r.college || '').trim()
        if (c) colleges.add(c)
      }
      return {
        // PostgREST's exact count remains cheap; assessed/average are based on
        // the bounded sample and are replaced by exact values after migration.
        total: count ?? data.length,
        assessed,
        scored: assessed,
        scoreSum,
        colleges: [...colleges],
      }
    }
  } catch {
    // View missing entirely — no unbounded base-table fallback.
  }
  return EMPTY_META
}

/**
 * College dropdown values + global stat cards, de-duplicated against the
 * local store. Total function: degrades to local-only data when Supabase is
 * unreachable. NOTE: `avg` is the mean over SCORED students (earlier code
 * divided by the assessed count including unscored attempts as zeros).
 */
export async function fetchAdminMeta(): Promise<AdminMetaResult> {
  const sb = getServerClient()
  let local: AdminStudentRow[] = []
  try {
    local = fetchLocalStudents()
  } catch {
    // Local store unreadable — remote data still answers.
  }
  let remote = EMPTY_META
  let dup = { ids: new Set<string>(), emails: new Set<string>() }
  if (sb) {
    const [meta, d] = await Promise.all([fetchRemoteMeta(sb), remoteDupKeys(sb, local)])
    remote = meta
    dup = d
  }
  const uniqueLocal = local.filter(
    r =>
      !dup.ids.has(r.student_id.trim().toLowerCase()) &&
      !dup.emails.has(r.email.trim().toLowerCase()),
  )
  const localAssessed = uniqueLocal.filter(r => r.has_assessment === 'Yes')
  const localScored = localAssessed.filter(r => r.score !== '')
  const localSum = localScored.reduce((a, r) => a + (Number(r.score) || 0), 0)
  const assessed = remote.assessed + localAssessed.length
  const scored = remote.scored + localScored.length
  const colleges = [
    ...new Set([
      ...remote.colleges,
      ...uniqueLocal.map(r => r.college.trim()).filter(Boolean),
    ]),
  ].sort((a, b) => a.localeCompare(b))
  return {
    colleges,
    stats: {
      total: remote.total + uniqueLocal.length,
      colleges: colleges.length,
      assessed,
      avg: scored ? Math.round((remote.scoreSum + localSum) / scored) : 0,
    },
    updated_at: new Date().toISOString(),
  }
}
