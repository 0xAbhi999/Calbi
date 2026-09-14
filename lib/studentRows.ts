// Pure row mapping for the admin export — no Node/server imports so unit
// tests can load it directly and the browser could too if ever needed.
import type { AdminStudentRow } from './csv'

const num = (v: any): string => {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : String(v)
}

const txt = (v: any): string => (v === null || v === undefined ? '' : String(v).trim())

/** Merge profile skills string + resume-parsed skills array, deduped (CSV "all skills"). */
export function mergeSkills(profileSkills: any, resumeParsed: any): { skills: string; resume_skills: string; all_skills: string } {
  const base = txt(profileSkills)
  let resume: string[] = []
  if (Array.isArray(resumeParsed?.skills)) {
    resume = resumeParsed.skills.map((s: any) => txt(s)).filter(Boolean)
  } else if (typeof resumeParsed === 'string') {
    resume = resumeParsed.split(',').map((s: any) => txt(s)).filter(Boolean)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of [...base.split(','), ...resume]) {
    const clean = txt(s)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return { skills: base, resume_skills: resume.join(', '), all_skills: out.join(', ') }
}

/** Build a flat CSV row from profile fields + a `scores` object (assessment result). */
export function buildRow(input: {
  student_id: string
  email?: string
  role?: string
  profile: any
  scores?: any
  resume_score?: any
  resume_parsed?: any
  verifiable_hash?: any
  assessed_at?: any
  created_at?: any
  /** True when a submitted/expired assessment session exists even if its result is missing. */
  assessment_attempted?: boolean
  /** Latest feedback the candidate gave (`{ rating, message, created_at }`). */
  feedback?: { rating?: any; message?: any; created_at?: any } | null
  /** How many feedback submissions that candidate has made in total. */
  feedback_count?: any
}): AdminStudentRow {
  const p = input.profile || {}
  const s = input.scores
  const scoreObj = s?.scores && typeof s.scores === 'object' && typeof s.scores.total === 'number' ? s.scores : s
  const cognitive = scoreObj?.cognitive && typeof scoreObj.cognitive === 'object' ? scoreObj.cognitive : {}
  const behavioral = cognitive.behavioral || {}
  const detail = scoreObj?.detail || {}
  const eng = scoreObj?.english && typeof scoreObj.english === 'object' ? scoreObj.english : {}
  const sk = mergeSkills(p.skills ?? p.profile_skills, input.resume_parsed ?? p.resume_parsed)
  return {
    student_id: txt(input.student_id),
    email: txt(input.email ?? p.email),
    name: txt(p.full_name ?? p.name ?? input.email?.split('@')[0]),
    role: txt(input.role ?? p.role ?? 'student'),
    prn: txt(p.prn),
    phone: txt(p.phone ?? p.mobile),
    dob: txt(p.dob),
    gender: txt(p.gender),
    degree: txt(p.degree),
    college: txt(p.college),
    graduation_year: num(p.graduation_year),
    cgpa: num(p.cgpa),
    skills: sk.skills,
    resume_skills: sk.resume_skills,
    all_skills: sk.all_skills,
    linkedin_url: txt(p.linkedin_url),
    github_url: txt(p.github_url),
    created_at: txt(input.created_at ?? p.created_at ?? p.updated_at),
    resume_score: num(input.resume_score ?? p.resume_score),
    has_assessment: s || input.assessment_attempted ? 'Yes' : 'No',
    score: s ? num(scoreObj?.total ?? s.total) : '',
    grade: s ? txt(scoreObj?.grade ?? s.grade) : '',
    percentile: s ? num(scoreObj?.percentile ?? s.percentile) : '',
    english: eng ? num(eng.total) : '',
    english_listening: eng ? num(eng.listening) : '',
    english_speaking: eng ? num(eng.speaking) : '',
    english_reading: eng ? num(eng.reading) : '',
    english_writing: eng ? num(eng.writing) : '',
    problem_solving: num(scoreObj?.problem_solving),
    ai_debugging: num(scoreObj?.ai_debugging),
    ai_feature: num(scoreObj?.ai_feature),
    prompt_engineering: num(scoreObj?.prompt_engineering),
    cognitive: cognitive.total !== undefined ? num(cognitive.total) : '',
    cognitive_grid: cognitive.grid !== undefined ? num(cognitive.grid) : '',
    cognitive_logical: cognitive.logical !== undefined ? num(cognitive.logical) : '',
    behavioral_total: cognitive.behavioral_total !== undefined ? num(cognitive.behavioral_total) : '',
    teamwork: num(behavioral.teamwork),
    accountability: num(behavioral.accountability),
    adaptability: num(behavioral.adaptability),
    responsible_ai: num(behavioral.responsible_ai),
    decision_making: num(behavioral.decision_making),
    learning_mindset: num(behavioral.learning_mindset),
    listening_correct: num(detail.listeningCorrect),
    listening_total: num(detail.listeningTotal),
    reading_correct: num(detail.readingCorrect),
    reading_total: num(detail.readingTotal),
    problem_correct: num(detail.problemCorrect),
    problem_total: num(detail.problemTotal),
    logical_correct: num(detail.logicalCorrect),
    logical_total: num(detail.logicalTotal),
    verifiable_hash: txt(input.verifiable_hash ?? scoreObj?.verifiable_hash),
    assessed_at: txt(input.assessed_at ?? scoreObj?.submitted_at ?? s?.created_at),
    feedback_rating: input.feedback?.rating !== undefined && input.feedback?.rating !== null ? num(input.feedback.rating) : '',
    feedback_message: txt(input.feedback?.message),
    feedback_at: txt(input.feedback?.created_at),
    feedback_count: input.feedback_count ? num(input.feedback_count) : '',
  }
}

/**
 * Copy feedback from a shadowed `source` row onto `row` when `row` has none.
 * Used when a local (demo) row is merged away in favour of a live Supabase row:
 * the live row wins for identity, but feedback the candidate gave under the
 * other id/email must not disappear from the dashboard.
 */
export function fillFeedbackFrom(row: AdminStudentRow, source: AdminStudentRow): AdminStudentRow {
  if (!source || (!source.feedback_message && !source.feedback_rating)) return row
  const missing = !row.feedback_message && !row.feedback_rating
  const sourceIsNewer = !!source.feedback_at && (!row.feedback_at || source.feedback_at > row.feedback_at)
  if (!missing && !sourceIsNewer) return row
  return {
    ...row,
    feedback_rating: source.feedback_rating || row.feedback_rating,
    feedback_message: source.feedback_message || row.feedback_message,
    feedback_at: source.feedback_at || row.feedback_at,
    feedback_count: source.feedback_count || row.feedback_count,
  }
}

/** Sort newest-result first, then name. */
export function sortRows(rows: AdminStudentRow[]): AdminStudentRow[] {
  return [...rows].sort((a, b) => {
    const t = (b.assessed_at || '').localeCompare(a.assessed_at || '')
    if (t !== 0) return t
    return (a.name || '').localeCompare(b.name || '')
  })
}

const rowId = (r: AdminStudentRow) => (r.student_id || '').trim().toLowerCase()
const rowEmail = (r: AdminStudentRow) => (r.email || '').trim().toLowerCase()

/**
 * Prefer a real result over a profile-only row when the same candidate exists in
 * both stores. Supabase can contain the profile while the result is still being
 * evaluated, while the local store may still have the completed result (or vice
 * versa). The live profile remains the identity winner; only missing assessment
 * fields are filled from the other store.
 */
export function fillAssessmentFrom(row: AdminStudentRow, source: AdminStudentRow): AdminStudentRow {
  const resultFields: (keyof AdminStudentRow)[] = [
    'score', 'grade', 'percentile', 'english', 'english_listening', 'english_speaking',
    'english_reading', 'english_writing', 'problem_solving', 'ai_debugging', 'ai_feature',
    'prompt_engineering', 'cognitive', 'cognitive_grid', 'cognitive_logical',
    'behavioral_total', 'teamwork', 'accountability', 'adaptability', 'responsible_ai',
    'decision_making', 'learning_mindset', 'listening_correct', 'listening_total',
    'reading_correct', 'reading_total', 'problem_correct', 'problem_total',
    'logical_correct', 'logical_total', 'verifiable_hash', 'assessed_at',
  ]
  const rank = (candidate: AdminStudentRow) => {
    const hasResult = candidate.score !== '' || candidate.grade !== '' || candidate.percentile !== ''
      || candidate.verifiable_hash !== ''
    return hasResult ? 2 : candidate.has_assessment === 'Yes' ? 1 : 0
  }
  if (rank(source) <= rank(row)) return row
  const merged = { ...row, has_assessment: 'Yes' }
  for (const field of resultFields) merged[field] = source[field] as never
  return merged
}

/**
 * Merge live (Supabase) rows with rows from the local JSON store.
 *
 * The two stores are not mirrors: students who signed up through the deployed
 * app live in Postgres with a real UUID id, while the curated/demo candidates
 * in `calibiai_db.json` (`u_…` ids, not valid UUIDs) were never written to
 * Postgres and therefore only exist locally. Reading one of the two made the
 * admin dashboard silently incomplete, so both are now merged:
 *
 *   • a live row wins for identity/profile fields; missing feedback and
 *     assessment data are filled from the local row when it is more complete;
 *   • "same student" = same `student_id`, or — when the ids differ (the demo
 *     file and Postgres minted different ids) — the same email address;
 *   • local rows are otherwise never de-duplicated against each other, because
 *     the seeded dataset legitimately holds several attempts per email that
 *     the dashboard has always shown separately.
 */
export function mergeStudentRows(
  remote: AdminStudentRow[],
  local: AdminStudentRow[],
): { rows: AdminStudentRow[]; remote: number; local: number } {
  const seenIds = new Set(remote.map(rowId).filter(Boolean))
  const seenEmails = new Set(remote.map(rowEmail).filter(Boolean))
  const extra: AdminStudentRow[] = []
  const mergedRemote = [...remote]
  for (const row of local) {
    const id = rowId(row)
    const email = rowEmail(row)
    // Only a *live* row can shadow a local one — local rows never shadow each
    // other (see the note above about repeated attempts per email).
    const shadow = mergedRemote.find(
      r => (id && rowId(r) === id) || (email && rowEmail(r) === email),
    )
    if (shadow) {
      // The live row wins for identity, but keep feedback and any completed
      // assessment from the other store instead of dropping it when the live
      // profile has not received the result yet.
      let enriched = fillFeedbackFrom(shadow, row)
      enriched = fillAssessmentFrom(enriched, row)
      if (enriched !== shadow) mergedRemote[mergedRemote.indexOf(shadow)] = enriched
      continue
    }
    extra.push(row)
  }
  return { rows: sortRows([...mergedRemote, ...extra]), remote: mergedRemote.length, local: extra.length }
}
