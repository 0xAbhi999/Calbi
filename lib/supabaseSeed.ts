// Seed / sync the local JSON demo store into Supabase.
//
// Why: the curated candidates live in `calibiai_db.json` (ids like `u_84368932`
// that are not valid UUIDs) and were never written to Postgres, so a
// Supabase-only view of the world could never show them. This module turns the
// local store into Supabase rows — auth users + profile + assessment sessions /
// results + resume analyses + feedback — so the database becomes the complete
// record, and `POST /api/admin/sync` (or `npm run seed:supabase`) can run it
// against the deployed app without shell access to Postgres.
//
// Everything is IDEMPOTENT: each row's UUID is derived deterministically from
// its local id (sha1 → RFC-4122 v5 layout), so re-running updates the same rows
// instead of duplicating them. Candidates are grouped by email (Supabase Auth
// enforces one account per email), and each group contributes its newest
// profile / session / result / resume / feedback.
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DBData } from './db'

/** Deterministic UUID (RFC 4122 v5-style) so re-runs are stable. */
export function seedUuid(scope: string, key: string): string {
  const h = createHash('sha1').update(`calibiai-seed:${scope}:${key}`).digest()
  const bytes = Buffer.from(h.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const clean = (v: any): string | null => {
  const s = String(v ?? '').trim()
  return s ? s : null
}
const emailKey = (v: any): string => String(v ?? '').trim().toLowerCase()

/** A live UUID stays as-is; a local `u_…` / `sess_…` id becomes deterministic. */
export function mapId(scope: string, localId: any): string | null {
  const s = String(localId ?? '').trim()
  if (!s) return null
  if (UUID_RE.test(s)) return s
  return seedUuid(scope, s)
}

export interface SeedCandidate {
  email: string
  full_name: string | null
  avatar: any
  profile: any
  sessions: any[]
  results: any[]
  resumes: any[]
  feedback: any[]
}

export interface SeedPlanRow {
  table: 'auth' | 'profiles' | 'assessment_sessions' | 'assessment_results' | 'resume_analyses' | 'feedback_submissions'
  id: string
  email?: string
  payload: any
}

export interface SeedPlan {
  candidates: SeedCandidate[]
  rows: SeedPlanRow[]
  summary: Record<string, number>
}

const newest = (rows: any[]) =>
  [...rows].sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime())

/**
 * Pure planner: local store → the rows that should exist in Supabase.
 * Kept dependency-free (no Supabase client) so it is unit-testable.
 */
export function buildSeedPlan(db: DBData): SeedPlan {
  const profiles = db.profiles || []
  const users = db.users || []
  const sessions = db.assessment_sessions || []
  const results = db.assessment_results || []
  const resumes = db.resume_analyses || []
  const feedback = db.feedback || []

  // Group everyone by email: a profile row may have no user row and vice versa.
  const byEmail = new Map<string, { email: string; profile?: any; user?: any }>()
  for (const p of profiles) {
    const key = emailKey(p.email)
    if (!key) continue
    const entry = byEmail.get(key) || { email: String(p.email) }
    // Newest profile wins when the same person has several rows.
    const current = entry.profile
    if (!current || new Date(p.updated_at || 0).getTime() >= new Date(current.updated_at || 0).getTime()) {
      entry.profile = p
    }
    byEmail.set(key, entry)
  }
  for (const u of users) {
    const key = emailKey(u.email)
    if (!key) continue
    const entry = byEmail.get(key) || { email: String(u.email) }
    entry.user = u
    byEmail.set(key, entry)
  }

  const candidates: SeedCandidate[] = []
  const rows: SeedPlanRow[] = []
  const summary: Record<string, number> = {
    auth: 0, profiles: 0, assessment_sessions: 0, assessment_results: 0, resume_analyses: 0, feedback_submissions: 0,
  }

  for (const [key, entry] of byEmail) {
    // One canonical (lower-case) address per candidate: Supabase Auth treats
    // e-mails case-insensitively and the local store has both 'X@gmail.com' and
    // 'x@gmail.com' variants for the same person.
    entry.email = key
    const profile = entry.profile || {}
    const user = entry.user || {}
    // Candidate identity: keep a real UUID when the local record already had one
    // (that student exists in Postgres), otherwise mint a deterministic one.
    const localStudentId = profile.id || user.id || key
    const studentId = UUID_RE.test(String(localStudentId)) ? String(localStudentId) : seedUuid('profile', key)
    const fullName = clean(profile.full_name) || clean(user.name) || key.split('@')[0]

    // All rows the local store holds for this person under *any* of their ids.
    const ids = new Set([String(profile.id || ''), String(user.id || '')].filter(Boolean))
    const mine = <T extends { student_id?: any }>(list: T[]) => list.filter(r => ids.has(String(r?.student_id || '')))
    const personSessions = mine(sessions)
    const personResults = mine(results)
    const personResumes = mine(resumes)
    const personFeedback = feedback.filter(f => {
      const fId = String(f?.student_id || '')
      const fMail = emailKey(f?.email)
      return ids.has(fId) || (fMail && fMail === key)
    })

    candidates.push({
      email: entry.email,
      full_name: fullName,
      avatar: profile.ai_avatar ?? null,
      profile,
      sessions: personSessions,
      results: personResults,
      resumes: personResumes,
      feedback: personFeedback,
    })

    const sessionIdMap = new Map<string, string>()
    for (const s of personSessions) {
      const id = mapId('session', s.id)!
      sessionIdMap.set(String(s.id), id)
      rows.push({
        table: 'assessment_sessions',
        id,
        email: entry.email,
        payload: {
          id,
          student_id: studentId,
          status: s.status || 'submitted',
          started_at: s.started_at || null,
          expires_at: s.expires_at || null,
          duration_sec: s.duration_sec ?? null,
          answers: { ...(s.answers || {}), seeded_from: 'calibiai_db.json' },
          submitted_at: s.submitted_at || null,
          tab_switches: s.tab_switches ?? 0,
          question_seed: s.question_seed ?? null,
        },
      })
      summary.assessment_sessions++
    }

    for (const r of personResults) {
      // A result must point at a session row that exists (FK + unique session_id):
      // fall back to a deterministic session id when the local session is gone.
      const sessionId = sessionIdMap.get(String(r.session_id)) || mapId('session', r.session_id || r.id)!
      rows.push({
        table: 'assessment_results',
        id: mapId('result', r.id || r.session_id)!,
        email: entry.email,
        payload: {
          id: mapId('result', r.id || r.session_id)!,
          session_id: sessionId,
          student_id: studentId,
          scores: r.scores || {},
          total: r.total ?? null,
          grade: r.grade ?? null,
          percentile: r.percentile ?? null,
          verifiable_hash: r.verifiable_hash ?? null,
          ai_feedback: r.ai_feedback ?? {},
          created_at: r.created_at || new Date().toISOString(),
        },
      })
      summary.assessment_results++
    }

    for (const r of personResumes) {
      rows.push({
        table: 'resume_analyses',
        id: mapId('resume', r.id)!,
        email: entry.email,
        payload: {
          id: mapId('resume', r.id)!,
          student_id: studentId,
          storage_key: r.storage_key ?? null,
          resume_score: r.resume_score ?? null,
          parsed: r.parsed || {},
          feedback: r.feedback || {},
          created_at: r.created_at || new Date().toISOString(),
        },
      })
      summary.resume_analyses++
    }

    for (const f of personFeedback) {
      rows.push({
        table: 'feedback_submissions',
        id: mapId('feedback', f.id)!,
        email: entry.email,
        payload: {
          id: mapId('feedback', f.id)!,
          student_id: studentId,
          student_ref: f.student_id ?? null,
          email: entry.email,
          session_id: f.session_id ?? null,
          rating: Number(f.rating) || null,
          message: String(f.message ?? '').trim(),
          source: f.source || 'seed',
          created_at: f.created_at || new Date().toISOString(),
        },
      })
      summary.feedback_submissions++
    }

    rows.push({
      table: 'auth',
      id: studentId,
      email: entry.email,
      payload: { id: studentId, email: entry.email, full_name: fullName },
    })
    summary.auth++

    rows.push({
      table: 'profiles',
      id: studentId,
      email: entry.email,
      payload: {
        id: studentId,
        email: entry.email,
        role: 'student',
        full_name: fullName,
        prn: clean(profile.prn),
        phone: clean(profile.phone),
        dob: clean(profile.dob),
        gender: clean(profile.gender),
        degree: clean(profile.degree),
        college: clean(profile.college),
        graduation_year: profile.graduation_year ?? null,
        cgpa: profile.cgpa ?? null,
        skills: clean(profile.skills),
        linkedin_url: clean(profile.linkedin_url),
        github_url: clean(profile.github_url),
        ai_avatar: profile.ai_avatar ?? null,
      },
    })
    summary.profiles++
  }

  return { candidates, rows, summary }
}

export interface SyncReport {
  ok: boolean
  error?: string
  summary: Record<string, number>
  /** Rows that could not be written (one entry per failure, capped). */
  failures: { table: string; id: string; error: string }[]
  /** Auth accounts that already existed and were reused. */
  reusedAccounts: number
  /** True when the feedback table is missing (migration 0004 not applied). */
  feedbackTableMissing?: boolean
}

/** Default password for seeded demo accounts (they own no real data). */
export const SEED_PASSWORD = process.env.SEED_PASSWORD || 'CalibiDemo@123'

/**
 * Re-point every data row at the auth id that ACTUALLY exists in auth.users.
 *
 * New accounts are created with the plan's deterministic id, but accounts that
 * already existed (reused) may live under a different id — upserting against
 * the planned id would then violate the profiles_id_fkey constraint. Pure and
 * exported for tests.
 */
export function remapRowsToAuthIds(rows: SeedPlanRow[], authIdByEmail: Map<string, string>): void {
  for (const row of rows) {
    if (!row.email) continue
    const realId = authIdByEmail.get(String(row.email).toLowerCase())
    if (!realId || realId === row.id) continue
    if (row.table === 'auth') {
      row.id = realId
      continue
    }
    if (row.table === 'profiles') {
      row.id = realId
      row.payload.id = realId
    }
    if ('student_id' in row.payload) row.payload.student_id = realId
  }
}

/**
 * Apply a seed plan to Supabase using the service-role client:
 *   1. `auth.admin.createUser` for each candidate (existing email → reuse),
 *   2. upsert `profiles`, then sessions → results → resumes → feedback.
 * Never throws: returns a report the caller can show to an admin.
 */
export async function applySeedPlan(
  client: SupabaseClient,
  plan: SeedPlan,
  log: (msg: string) => void = () => {},
): Promise<SyncReport> {
  const failures: SyncReport['failures'] = []
  let reusedAccounts = 0
  let feedbackTableMissing = false
  // email (lower-case) → the auth.users id that actually exists for it.
  const authIdByEmail = new Map<string, string>()

  const record = (table: string, id: string, error: string) => {
    if (failures.length < 25) failures.push({ table, id, error })
    log(`  ✗ ${table} ${id}: ${error}`)
  }

  // 1) Auth accounts (profiles.id is an FK to auth.users). The account MUST be
  //    created with the plan's deterministic id — profiles/sessions/results
  //    reference that exact id and would otherwise all fail profiles_id_fkey.
  for (const row of plan.rows.filter(r => r.table === 'auth')) {
    try {
      const { data, error } = await client.auth.admin.createUser({
        id: row.id,
        email: row.email!,
        password: SEED_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: row.payload.full_name, role: 'student', seeded: true },
      })
      if (!error) {
        if (data?.user?.id) authIdByEmail.set(String(row.email!).toLowerCase(), data.user.id)
        log(`  ✓ auth ${row.email}`)
        continue
      }
      if (/already|exists|registered|duplicate/i.test(error.message)) {
        reusedAccounts++
        log(`  ↺ auth ${row.email} (already registered — reused)`)
        continue
      }
      record('auth', row.email!, error.message)
    } catch (e: any) {
      record('auth', row.email!, e?.message || String(e))
    }
  }

  // 1b) Reused accounts may live under a DIFFERENT auth id (created before the
  //     sync passed an explicit id, or via normal sign-up). Resolve their real
  //     ids and re-point the data rows, or every upsert would fail the FK.
  const unresolved = plan.rows
    .filter(r => r.table === 'auth')
    .map(r => String(r.email!).toLowerCase())
    .filter(email => !authIdByEmail.has(email))
  if (unresolved.length) {
    const wanted = new Set(unresolved)
    for (let page = 1; page <= 50; page++) {
      const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 })
      if (error) break
      const users = data?.users || []
      for (const u of users) {
        const email = String((u as any).email ?? '').toLowerCase()
        if (u.id && wanted.has(email) && !authIdByEmail.has(email)) authIdByEmail.set(email, u.id)
      }
      if (!users.length || users.length < 200 || authIdByEmail.size >= wanted.size) break
    }
    for (const email of unresolved) {
      if (!authIdByEmail.has(email)) record('auth', email, 'email exists in auth but could not be resolved via listUsers')
    }
  }
  remapRowsToAuthIds(plan.rows, authIdByEmail)

  // 2) Data rows, parents first (sessions before results, profiles before all).
  const order = ['profiles', 'assessment_sessions', 'assessment_results', 'resume_analyses', 'feedback_submissions'] as const
  for (const table of order) {
    for (const row of plan.rows.filter(r => r.table === table)) {
      // Skip rows whose profile failed to be created would be nicer, but an FK
      // error is reported per-row anyway.
      const { error } = await client.from(table).upsert(row.payload, { onConflict: 'id' })
      if (!error) {
        log(`  ✓ ${table} ${row.id}`)
        continue
      }
      if (/relation .* does not exist|schema cache/i.test(error.message)) {
        if (table === 'feedback_submissions') {
          feedbackTableMissing = true
          record(table, row.id, 'table missing — run supabase/migrations/0004_feedback_submissions.sql')
          continue
        }
      }
      record(table, row.id, error.message)
    }
  }

  return {
    ok: failures.length === 0,
    summary: plan.summary,
    failures,
    reusedAccounts,
    feedbackTableMissing,
  }
}

/** Human-readable one-liner for logs / the admin UI. */
export function describePlan(plan: SeedPlan): string {
  const s = plan.summary
  return `${plan.candidates.length} candidates · ${s.profiles} profiles · ${s.assessment_sessions} sessions · ${s.assessment_results} results · ${s.resume_analyses} resumes · ${s.feedback_submissions} feedback`
}
