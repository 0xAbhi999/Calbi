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
// query always tries the view first and falls back to the base tables, and a
// Supabase failure never hides the local rows.
import { getAllFeedback, getDB } from './db.ts'
import { getServerClient } from './supabaseServer.ts'
import { fetchAllFeedback } from './persist.ts'
import { buildRow, mergeStudentRows, sortRows } from './studentRows.ts'
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
 * Columns read from the `student_profiles_full` view. This is every view
 * column EXCEPT the two heavy JSONB blobs the admin never renders
 * (`resume_feedback` and `assessment_ai_feedback`) — skipping them shrinks
 * each row by ~20-40% and the dashboard downloads the whole table, so every
 * byte here is multiplied by the student count on each refresh.
 * (`feedback_rating/message/created_at` from migration 0004 are likewise
 * skipped — feedback is joined explicitly so the dashboard works whether or
 * not that migration has been applied.)
 */
const VIEW_COLUMNS = [
  'student_id', 'email', 'role', 'full_name', 'prn', 'phone', 'dob', 'gender',
  'degree', 'college', 'institution_id', 'graduation_year', 'cgpa', 'skills',
  'linkedin_url', 'github_url', 'ai_avatar', 'profile_created_at',
  'profile_updated_at', 'resume_id', 'resume_storage_key', 'resume_score',
  'resume_parsed', 'resume_created_at', 'assessment_session_id', 'talent_score',
  'grade', 'percentile', 'assessment_scores', 'verifiable_hash',
  'report_storage_key', 'assessment_created_at',
].join(',')

/**
 * Read the export view with the narrow column list above. Deployments whose
 * view predates a column (e.g. migration 0003's `prn` was never applied)
 * fail that query with an unknown-column error — retry those with a wildcard
 * so the dashboard keeps working instead of dropping to the heavier
 * base-table join.
 */
async function fetchViewRows(sb: any): Promise<{ data?: any[] | null; error?: { message: string } | null }> {
  const narrow = await sb.from('student_profiles_full').select(VIEW_COLUMNS).eq('role', 'student')
  if (!narrow.error) return narrow
  if (/column|does not exist/i.test(String(narrow.error.message || ''))) {
    return sb.from('student_profiles_full').select('*').eq('role', 'student')
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
 * Fallback join against the base tables. Used when `student_profiles_full` does
 * not exist (e.g. only `supabase/schema.sql` was partially applied) so the
 * admin dashboard still shows real data instead of silently going empty.
 */
async function fetchFromBaseTables(sb: any): Promise<{ rows: AdminStudentRow[]; error?: FetchError }> {
  try {
    const [profilesQ, resumesQ, resultsQ, sessionsQ] = await Promise.all([
      sb.from('profiles').select('*').eq('role', 'student'),
      // Narrow selects: the row builder only needs the score + parsed skills
      // from resumes and the scores/total/grade/percentile/hash from results.
      // `select('*')` would also drag the full `feedback` / `ai_feedback`
      // JSONB blobs for every historic row (not just the latest per student).
      sb.from('resume_analyses').select('student_id,resume_score,parsed,created_at').order('created_at', { ascending: false }),
      sb.from('assessment_results').select('student_id,scores,total,grade,percentile,verifiable_hash,created_at').order('created_at', { ascending: false }),
      sb.from('assessment_sessions')
        .select('id,student_id,status,submitted_at,created_at')
        .order('created_at', { ascending: false }),
    ])
    if (profilesQ.error) return { rows: [], error: { message: profilesQ.error.message } }
    // Resumes / results are best-effort — keep profiles even if these fail.
    const resumes: any[] = resumesQ.data || []
    const results: any[] = resultsQ.data || []
    const sessions: any[] = sessionsQ.data || []
    const byStudent = (arr: any[]) => {
      const map = new Map<string, any>()
      for (const row of arr) {
        const key = String(row.student_id || '')
        if (!key) continue
        // Prefer the first (already newest-first) row on a per-student basis.
        if (!map.has(key)) map.set(key, row)
      }
      return map
    }
    const latestResume = byStudent(resumes)
    const latestResult = byStudent(results)
    const latestSession = byStudent(sessions.filter(sessionCountsAsAssessment))

    const rows = (profilesQ.data || []).map((p: any) => {
      const result = latestResult.get(p.id)
      const session = latestSession.get(p.id)
      return buildRow({
        student_id: p.id,
        email: p.email,
        role: p.role,
        profile: p,
        scores: result || null,
        resume_score: latestResume.get(p.id)?.resume_score,
        resume_parsed: latestResume.get(p.id)?.parsed,
        assessment_attempted: sessionCountsAsAssessment(session),
        verifiable_hash: result?.verifiable_hash,
        assessed_at: result?.created_at || session?.submitted_at || session?.created_at,
        created_at: p.created_at,
      })
    })
    return { rows: sortRows(rows) }
  } catch (e: any) {
    return { rows: [], error: { message: e?.message || 'Base-table fallback failed.' } }
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
        // 2) The view is missing / errored — fall back to the base tables.
        const viewWarning = `student_profiles_full view: ${error.message}`
        const fallback = await fetchFromBaseTables(sb)
        if (!fallback.error) {
          remote = fallback.rows
          warning = `${viewWarning}. Showing results joined from the base tables instead.`
        } else {
          warning = `Could not load students from Supabase: ${fallback.error.message}`
        }
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

/** Row count via a HEAD-style query — transfers bytes, not rows. */
async function tableCount(sb: any, table: string, roleFilter = false): Promise<number> {
  try {
    let q = sb.from(table).select('id', { count: 'exact', head: true })
    if (roleFilter) q = q.eq('role', 'student')
    const { count, error } = await q
    if (error) return -1
    return count ?? 0
  } catch {
    return -1
  }
}

/** Newest timestamp in a table (single tiny row) — catches edits that keep counts equal. */
async function latestStamp(sb: any, table: string, col: string): Promise<string> {
  try {
    const { data, error } = await sb.from(table).select(col).order(col, { ascending: false }).limit(1).maybeSingle()
    if (error || !data) return ''
    return String((data as any)[col] || '')
  } catch {
    return ''
  }
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
export async function fetchStudentsFingerprint(): Promise<StudentsFingerprint> {
  const sb = getServerClient()
  const parts: Record<string, string | number> = { remote: sb ? 1 : 0 }
  const counts = { profiles: -1, results: -1, resumes: -1, feedback: -1 }
  if (sb) {
    try {
      const [profiles, results, resumes, feedback, pStamp, rStamp, resStamp, fStamp] = await Promise.all([
        tableCount(sb, 'profiles', true),
        tableCount(sb, 'assessment_results'),
        tableCount(sb, 'resume_analyses'),
        tableCount(sb, 'feedback_submissions'),
        latestStamp(sb, 'profiles', 'updated_at'),
        latestStamp(sb, 'assessment_results', 'created_at'),
        latestStamp(sb, 'resume_analyses', 'created_at'),
        latestStamp(sb, 'feedback_submissions', 'created_at'),
      ])
      counts.profiles = profiles
      counts.results = results
      counts.resumes = resumes
      counts.feedback = feedback
      parts.profiles = profiles
      parts.results = results
      parts.resumes = resumes
      parts.feedback = feedback
      parts.pStamp = pStamp
      parts.rStamp = rStamp
      parts.resStamp = resStamp
      parts.fStamp = fStamp
    } catch {
      // Fall through — the time bucket below still changes the fingerprint.
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
  if (!sb) parts.time_bucket = Math.floor(Date.now() / 60000)
  const fingerprint = Object.keys(parts).sort().map(k => `${k}=${parts[k]}`).join('|')
  return { fingerprint, counts, updated_at: new Date().toISOString() }
}
