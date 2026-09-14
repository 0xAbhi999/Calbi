/**
 * The admin dashboard's Supabase path, exercised against a real supabase-js
 * client pointed at an in-process PostgREST stand-in.
 *
 * This is the path production actually uses (`student_profiles_full` view +
 * `feedback_submissions`), so the "feedback wiped the report" bug is guarded
 * here too — not just on the local-store path. Separate file on purpose:
 * `getServerClient()` memoises its client per process, so the Supabase env must
 * be set before anything reads it.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54399'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { fetchAllStudents } from '../adminStudents.ts'
import { flushDB, setDbDirectory } from '../db.ts'

const VIEW_ROW = {
  student_id: '11111111-1111-4111-8111-111111111111',
  email: 'aarti@example.com',
  role: 'student',
  full_name: 'Aarti Deshmukh',
  prn: 'PCCOE2021045',
  phone: '+91 98220 11111',
  dob: '2003-04-11',
  gender: 'female',
  degree: 'B.Tech CSE',
  college: 'PCCOE',
  institution_id: null,
  graduation_year: 2026,
  cgpa: 8.7,
  skills: 'Python, React, SQL',
  linkedin_url: null,
  github_url: null,
  ai_avatar: null,
  profile_created_at: '2026-09-01T08:00:00.000Z',
  profile_updated_at: '2026-09-01T08:00:00.000Z',
  resume_id: 'r1',
  resume_storage_key: 'resumes/aarti.pdf',
  resume_score: 82,
  resume_parsed: { skills: ['Python', 'React'], word_count: 512 },
  resume_feedback: { strengths: ['Quantified impact'] },
  resume_created_at: '2026-09-01T08:30:00.000Z',
  assessment_session_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  talent_score: 760,
  grade: 'A',
  percentile: 84.2,
  assessment_scores: {
    english: { listening: 42, speaking: 38, reading: 45, writing: 40, total: 165 },
    problem_solving: 78,
    ai_debugging: 66,
    ai_feature: 71,
    prompt_engineering: 82,
    cognitive: {
      grid: 34, logical: 30, total: 182, behavioral_total: 118,
      behavioral: {
        teamwork: 20, accountability: 19, adaptability: 21,
        responsible_ai: 18, decision_making: 20, learning_mindset: 20,
      },
    },
    detail: { listeningCorrect: 7, listeningTotal: 10, debugPer: 66.7 },
    total: 760,
  },
  assessment_ai_feedback: { writing: { score: 38 } },
  verifiable_hash: 'sha256:demo',
  report_storage_key: 'reports/aarti.pdf',
  assessment_created_at: '2026-09-01T10:31:00.000Z',
  // Present in the view once migration 0004 has been applied.
  feedback_rating: 5,
  feedback_message: 'Good assessment, up to the mark.',
  feedback_created_at: '2026-09-01T10:35:00.000Z',
}

const FEEDBACK_ROW = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  student_id: VIEW_ROW.student_id,
  student_ref: VIEW_ROW.student_id,
  email: VIEW_ROW.email,
  session_id: VIEW_ROW.assessment_session_id,
  rating: 5,
  message: 'Good assessment, up to the mark.',
  source: 'web',
  created_at: '2026-09-01T10:35:00.000Z',
}

const requested: string[] = []
const server = http.createServer((req, res) => {
  const table = (req.url || '').match(/^\/rest\/v1\/([a-z_]+)/)?.[1] || ''
  requested.push(`${req.method} ${table}`)
  const body =
    table === 'student_profiles_full' ? [VIEW_ROW]
    : table === 'feedback_submissions' ? [FEEDBACK_ROW]
    : []
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Range': `0-${body.length - 1}/*` })
  res.end(JSON.stringify(body))
})

await new Promise<void>(resolve => server.listen(54399, '127.0.0.1', resolve))

// Keep the local store empty so only the Supabase rows are under test.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-supabase-test-'))
setDbDirectory(dir)

test('the Supabase view path returns the report together with the feedback', async () => {
  const result = await fetchAllStudents()
  assert.equal(result.source, 'supabase')
  assert.equal(result.warning, undefined, `unexpected warning: ${result.warning}`)
  assert.ok(requested.includes('GET student_profiles_full'), 'the export view was queried')
  assert.ok(requested.includes('GET feedback_submissions'), 'feedback was queried')
  assert.equal(result.feedbackFromSupabase, true)

  const row: any = result.students.find(s => s.email === 'aarti@example.com')
  assert.ok(row, 'the student is listed')

  // The report columns (this is what used to disappear).
  assert.equal(row.score, '760')
  assert.equal(row.grade, 'A')
  assert.equal(row.percentile, '84.2')
  assert.equal(row.has_assessment, 'Yes')
  assert.equal(row.english, '165')
  assert.equal(row.english_listening, '42')
  assert.equal(row.problem_solving, '78')
  assert.equal(row.cognitive, '182')
  assert.equal(row.teamwork, '20')
  assert.equal(row.resume_score, '82')
  assert.equal(row.resume_skills, 'Python, React')
  assert.equal(row.verifiable_hash, 'sha256:demo')
  assert.equal(row.assessed_at, '2026-09-01T10:31:00.000Z')

  // …and the feedback from `feedback_submissions` is attached as well.
  assert.equal(row.feedback_rating, '5')
  assert.equal(row.feedback_message, 'Good assessment, up to the mark.')
  assert.equal(row.feedback_count, '1')
  assert.equal(row.feedback_history?.[0]?.id, FEEDBACK_ROW.id)
})

// Teardown must be registered, not run inline: node:test defers test bodies
// until the module has finished loading, so top-level statements here would
// close the server before the test ever made a request.
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await flushDB()
  fs.rmSync(dir, { recursive: true, force: true })
})
