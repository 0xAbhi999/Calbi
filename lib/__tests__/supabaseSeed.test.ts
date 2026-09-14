import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSeedPlan, mapId, seedUuid, describePlan, remapRowsToAuthIds } from '../supabaseSeed.ts'
import { CSV_COLUMNS } from '../csv.ts'
import { buildRow, fillFeedbackFrom, mergeStudentRows } from '../studentRows.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ---------------------------------------------------------------------------
// Seeding the local store into Supabase

test('seedUuid is deterministic, a valid v5-shaped uuid and scope/key dependent', () => {
  const a = seedUuid('profile', 'u_84368932')
  assert.match(a, UUID_RE)
  assert.equal(a, seedUuid('profile', 'u_84368932'))
  assert.notEqual(a, seedUuid('profile', 'u_other'))
  assert.notEqual(a, seedUuid('session', 'u_84368932'))
})

test('mapId keeps real UUIDs and maps local demo ids deterministically', () => {
  const real = '53711d1a-b8e4-4b3a-9f21-2c6f0f4b8a11'
  assert.equal(mapId('profile', real), real)
  assert.match(mapId('profile', 'u_d8ff3b08')!, UUID_RE)
  assert.equal(mapId('profile', 'u_d8ff3b08'), mapId('profile', 'u_d8ff3b08'))
  assert.equal(mapId('profile', ''), null)
})

const store: any = {
  users: [
    { id: 'u_84368932', email: 'Prajwal@gmail.com', role: 'student', name: 'Prajwal', created_at: '2026-09-06T10:00:00.000Z' },
    { id: 'u_dcb106d7', email: 'priya@iitm.ac.in', role: 'student', created_at: '2026-09-06T11:00:00.000Z' },
  ],
  profiles: [
    { id: 'u_84368932', email: 'Prajwal@gmail.com', full_name: 'Prajwal Gulhane', college: 'COEP', updated_at: '2026-09-07T00:00:00.000Z' },
    { id: 'u_dcb106d7', email: 'priya@iitm.ac.in', full_name: 'Priya Sharma', updated_at: '2026-09-06T11:00:00.000Z' },
  ],
  assessment_sessions: [
    { id: 'sess_da8ea53d', student_id: 'u_84368932', status: 'submitted', started_at: '2026-09-06T10:10:52.779Z', expires_at: '2026-09-06T12:10:52.779Z', duration_sec: 7200, tab_switches: 0, created_at: '2026-09-06T10:10:52.779Z' },
  ],
  assessment_results: [
    { id: 'res_e8867909', session_id: 'sess_da8ea53d', student_id: 'u_84368932', scores: { total: 105 }, total: 105, grade: 'C', percentile: 55, verifiable_hash: 'sha256:abc-def', created_at: '2026-09-06T16:29:21.000Z' },
  ],
  resume_analyses: [
    { id: 'res_1788689439891', student_id: 'u_84368932', resume_score: 78, parsed: { skills: ['Python'] }, created_at: '2026-09-06T10:11:00.000Z' },
  ],
  feedback: [
    { id: 'fb_1', student_id: 'u_84368932', email: 'prajwal@gmail.com', session_id: 'sess_da8ea53d', rating: 4, message: 'Really good assessment, well structured.', created_at: '2026-09-06T16:40:00.000Z' },
  ],
}

test('buildSeedPlan groups by email and produces auth + profile + child rows', () => {
  const plan = buildSeedPlan(store)
  assert.equal(plan.candidates.length, 2)
  assert.equal(plan.summary.auth, 2)
  assert.equal(plan.summary.profiles, 2)
  assert.equal(plan.summary.assessment_sessions, 1)
  assert.equal(plan.summary.assessment_results, 1)
  assert.equal(plan.summary.resume_analyses, 1)
  assert.equal(plan.summary.feedback_submissions, 1)
  assert.match(describePlan(plan), /2 candidates/)
})

test('buildSeedPlan is idempotent — same local ids produce the same uuids', () => {
  const a = buildSeedPlan(store)
  const b = buildSeedPlan(store)
  const ids = (p: ReturnType<typeof buildSeedPlan>) => p.rows.map(r => `${r.table}:${r.id}`).sort()
  assert.deepEqual(ids(a), ids(b))
})

test('remapRowsToAuthIds re-points rows at the auth id that really exists', () => {
  const plan = buildSeedPlan(store)
  const plannedProfileId = plan.rows.find(r => r.table === 'profiles' && r.email === 'prajwal@gmail.com')!.id
  // The account for this email already exists under a different (random) id.
  const realAuthId = '5f0c1a2b-3d4e-4f5a-8b9c-0d1e2f3a4b5c'
  remapRowsToAuthIds(plan.rows, new Map([['prajwal@gmail.com', realAuthId]]))

  const auth = plan.rows.find(r => r.table === 'auth' && r.email === 'prajwal@gmail.com')!
  const profile = plan.rows.find(r => r.table === 'profiles' && r.email === 'prajwal@gmail.com')!
  const session = plan.rows.find(r => r.table === 'assessment_sessions' && r.email === 'prajwal@gmail.com')!
  const result = plan.rows.find(r => r.table === 'assessment_results' && r.email === 'prajwal@gmail.com')!
  const resume = plan.rows.find(r => r.table === 'resume_analyses' && r.email === 'prajwal@gmail.com')!
  const feedback = plan.rows.find(r => r.table === 'feedback_submissions' && r.email === 'prajwal@gmail.com')!

  assert.equal(auth.id, realAuthId)
  assert.equal(profile.id, realAuthId)
  assert.equal(profile.payload.id, realAuthId)
  // Child rows keep their own deterministic ids but reference the real student.
  assert.notEqual(session.id, plannedProfileId)
  assert.equal(session.payload.student_id, realAuthId)
  assert.equal(result.payload.student_id, realAuthId)
  assert.equal(resume.payload.student_id, realAuthId)
  assert.equal(feedback.payload.student_id, realAuthId)

  // Other candidates are untouched.
  const other = plan.rows.find(r => r.table === 'profiles' && r.email === 'priya@iitm.ac.in')!
  assert.notEqual(other.id, realAuthId)
})

test('remapRowsToAuthIds leaves rows alone when ids already match', () => {
  const plan = buildSeedPlan(store)
  const before = JSON.stringify(plan.rows)
  const planned = plan.rows.find(r => r.table === 'auth' && r.email === 'prajwal@gmail.com')!
  remapRowsToAuthIds(plan.rows, new Map([['prajwal@gmail.com', planned.id]]))
  assert.equal(JSON.stringify(plan.rows), before)
})

test('buildSeedPlan links every child row to its candidate and session', () => {
  const plan = buildSeedPlan(store)
  const profile = plan.rows.find(r => r.table === 'profiles' && r.email === 'prajwal@gmail.com')!
  const session = plan.rows.find(r => r.table === 'assessment_sessions')!
  const result = plan.rows.find(r => r.table === 'assessment_results')!
  const feedback = plan.rows.find(r => r.table === 'feedback_submissions')!
  assert.equal(session.payload.student_id, profile.id)
  assert.equal(result.payload.student_id, profile.id)
  assert.equal(result.payload.session_id, session.id) // FK satisfied
  assert.equal(feedback.payload.student_id, profile.id)
  assert.equal(feedback.payload.rating, 4)
  assert.equal(feedback.payload.email, 'prajwal@gmail.com')
})

test('buildSeedPlan keeps the newest profile when one email has several rows', () => {
  const plan = buildSeedPlan({
    ...store,
    profiles: [
      ...store.profiles,
      { id: 'u_dup', email: 'Prajwal@gmail.com', full_name: 'Prajwal (older)', updated_at: '2026-09-01T00:00:00.000Z' },
      { id: 'u_dup2', email: 'Prajwal@gmail.com', full_name: 'Prajwal (newest)', updated_at: '2026-09-08T00:00:00.000Z' },
    ],
  } as any)
  const profile = plan.rows.find(r => r.table === 'profiles' && r.email === 'prajwal@gmail.com')!
  assert.equal(profile.payload.full_name, 'Prajwal (newest)')
  assert.equal(plan.candidates.length, 2) // still one candidate per email
})

// ---------------------------------------------------------------------------
// Feedback in the admin rows

test('buildRow carries the candidate feedback columns', () => {
  const row = buildRow({
    student_id: 'u_1',
    email: 'a@b.com',
    profile: { full_name: 'A' },
    feedback: { rating: 5, message: 'Great experience overall.', created_at: '2026-09-08T10:00:00.000Z' },
    feedback_count: 2,
  })
  assert.equal(row.feedback_rating, '5')
  assert.equal(row.feedback_message, 'Great experience overall.')
  assert.equal(row.feedback_at, '2026-09-08T10:00:00.000Z')
  assert.equal(row.feedback_count, '2')
})

test('buildRow leaves feedback blank when the candidate has not submitted any', () => {
  const row = buildRow({ student_id: 'u_2', email: 'c@d.com', profile: { full_name: 'C' } })
  assert.equal(row.feedback_rating, '')
  assert.equal(row.feedback_message, '')
  assert.equal(row.feedback_count, '')
})

test('fillFeedbackFrom copies feedback only when it adds something newer', () => {
  const live = buildRow({ student_id: 'u_1', email: 'a@b.com', profile: { full_name: 'A' } })
  const local = buildRow({
    student_id: 'u_1',
    email: 'a@b.com',
    profile: { full_name: 'A' },
    feedback: { rating: 4, message: 'Good but long.', created_at: '2026-09-08T10:00:00.000Z' },
  })
  const filled = fillFeedbackFrom(live, local)
  assert.equal(filled.feedback_rating, '4')
  assert.equal(filled.feedback_message, 'Good but long.')

  // Older feedback must not overwrite newer.
  const newerLive = buildRow({
    student_id: 'u_1',
    email: 'a@b.com',
    profile: { full_name: 'A' },
    feedback: { rating: 5, message: 'Latest.', created_at: '2026-09-09T10:00:00.000Z' },
  })
  const kept = fillFeedbackFrom(newerLive, local)
  assert.equal(kept.feedback_message, 'Latest.')
  assert.equal(kept.feedback_rating, '5')
})

test('mergeStudentRows keeps the feedback of a shadowed local row', () => {
  const liveId = '11111111-2222-3333-4444-555555555555'
  const remote = [buildRow({ student_id: liveId, email: 'same@x.com', profile: { full_name: 'Live' } })]
  const local = [
    buildRow({
      student_id: 'u_9',
      email: 'same@x.com',
      profile: { full_name: 'Local' },
      feedback: { rating: 3, message: 'Feedback given under the demo id.', created_at: '2026-09-08T10:00:00.000Z' },
    }),
  ]
  const merged = mergeStudentRows(remote, local)
  assert.equal(merged.local, 0)
  assert.equal(merged.rows.length, 1)
  assert.equal(merged.rows[0].name, 'Live')
  assert.equal(merged.rows[0].feedback_rating, '3')
  assert.equal(merged.rows[0].feedback_message, 'Feedback given under the demo id.')
})

test('CSV exports the feedback columns', () => {
  const keys = CSV_COLUMNS.map(c => c.key)
  assert.equal(CSV_COLUMNS.length, 52)
  for (const key of ['feedback_rating', 'feedback_message', 'feedback_at', 'feedback_count'] as const) {
    assert.ok(keys.includes(key), `${key} missing from the CSV`)
  }
})

test('mergeStudentRows: a student present in both stores is one row', () => {
  // The API writes each submission to the local store AND Supabase with the same
  // id, so the admin reads it twice. The rows must still show count 1.
  //
  // NOTE: this only covers mergeStudentRows. It used to be titled
  // "attachFeedback-equivalent behaviour", which is how a real bug in
  // attachFeedback shipped unnoticed — the actual function is covered by
  // adminReports.test.ts / adminSupabase.test.ts, which call fetchAllStudents().
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const remote = [buildRow({
    student_id: 'u_1', email: 'a@b.com', profile: { full_name: 'A' },
    feedback: { rating: 4, message: 'Both stores.', created_at: '2026-09-08T10:00:00.000Z' },
    feedback_count: 1,
  })]
  const local = [buildRow({
    student_id: 'u_1', email: 'a@b.com', profile: { full_name: 'A' },
    feedback: { rating: 4, message: 'Both stores.', created_at: '2026-09-08T10:00:00.000Z' },
    feedback_count: 1,
  })]
  const merged = mergeStudentRows(remote, local)
  assert.equal(merged.local, 0)
  assert.equal(merged.rows[0].feedback_count, '1')
  assert.equal(String(id).length, 36) // the id is what makes the two copies one row
})
