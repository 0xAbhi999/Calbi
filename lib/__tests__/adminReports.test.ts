/**
 * Regression tests for the admin dashboard's student reports.
 *
 * These run the REAL `fetchAllStudents()` (not a re-implementation), because
 * the bug they guard against hid behind a test that only exercised a look-alike
 * of `attachFeedback`: a candidate who submitted feedback had their row rebuilt
 * from profile + feedback alone, which wiped the score, grade, percentile,
 * every module and behavioural score, the resume score and the assessment date,
 * and flipped "Assessment" to "No". Giving feedback made your report disappear.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { fetchAllStudents } from '../adminStudents.ts'
import {
  flushDB,
  saveAssessmentResult,
  saveAssessmentSession,
  saveFeedback,
  saveProfile,
  saveResumeAnalysis,
  setDbDirectory,
} from '../db.ts'

/** The `scores` JSONB exactly as the app stores it (computeScores() output). */
const scoresPayload = (total: number) => ({
  english: { listening: 42, speaking: 38, reading: 45, writing: 40, total: 165, max: 200 },
  problem_solving: 78,
  ai_debugging: 66,
  ai_feature: 71,
  prompt_engineering: 82,
  cognitive: {
    grid: 34, logical: 30, cognitive_score: 64, behavioral_total: 118, total: 182, max: 200,
    behavioral: {
      teamwork: 20, accountability: 19, adaptability: 21,
      responsible_ai: 18, decision_making: 20, learning_mindset: 20,
    },
  },
  detail: {
    listeningCorrect: 7, listeningTotal: 10, readingCorrect: 9, readingTotal: 10,
    problemCorrect: 6, problemTotal: 8, logicalCorrect: 5, logicalTotal: 7,
    debugPer: 66.7, promptPer: 82, featureScore100: 71, speakingCount: 3,
  },
  total,
  grade: 'A',
  percentile: 84.2,
  verifiable_hash: 'sha256:demo',
})

function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-report-test-'))
  setDbDirectory(dir)
  return async () => {
    await flushDB()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function seedStudent(id: string, email: string, opts: { feedback?: number; resume?: boolean } = {}) {
  saveProfile({
    id, email, full_name: `Student ${id}`, college: 'PCCOE', prn: `PRN${id}`,
    skills: 'Python, SQL', cgpa: 8.5, degree: 'B.Tech CSE',
    updated_at: '2026-09-01T08:00:00.000Z',
  } as any)
  saveAssessmentSession({
    id: `sess_${id}`, student_id: id, status: 'submitted',
    started_at: '2026-09-01T09:00:00.000Z', expires_at: '2026-09-01T11:00:00.000Z',
    duration_sec: 7200, tab_switches: 1, answers: {},
    submitted_at: '2026-09-01T10:30:00.000Z', created_at: '2026-09-01T09:00:00.000Z',
  })
  saveAssessmentResult({
    id: `res_${id}`, session_id: `sess_${id}`, student_id: id,
    scores: scoresPayload(760), total: 760, grade: 'A', percentile: 84.2,
    verifiable_hash: 'sha256:demo', ai_feedback: {}, created_at: '2026-09-01T10:31:00.000Z',
  } as any)
  if (opts.resume) {
    saveResumeAnalysis({
      id: `ra_${id}`, student_id: id, storage_key: `resumes/${id}.pdf`, resume_score: 82,
      parsed: { skills: ['Python', 'React'], word_count: 512, file_name: 'Resume.pdf' },
      feedback: { strengths: ['Quantified impact'] }, created_at: '2026-09-01T08:30:00.000Z',
    } as any)
  }
  if (opts.feedback) {
    saveFeedback({
      id: `fb_${id}`, student_id: id, email, session_id: `sess_${id}`,
      rating: opts.feedback, message: 'Good assessment, up to the mark.',
      created_at: '2026-09-01T10:35:00.000Z',
    })
  }
}

/** Every report column that used to vanish when feedback was attached. */
const REPORT_COLUMNS = [
  'score', 'grade', 'percentile', 'has_assessment', 'assessed_at', 'verifiable_hash',
  'english', 'english_listening', 'english_speaking', 'english_reading', 'english_writing',
  'problem_solving', 'ai_debugging', 'ai_feature', 'prompt_engineering',
  'cognitive', 'cognitive_grid', 'cognitive_logical', 'behavioral_total',
  'teamwork', 'accountability', 'adaptability', 'responsible_ai', 'decision_making',
  'learning_mindset', 'listening_correct', 'reading_total', 'problem_correct',
  'logical_total', 'resume_score', 'resume_skills',
] as const

test('a student who submitted feedback still shows their full report', async () => {
  const cleanup = useTempStore()
  seedStudent('u_10001', 'aarti@example.com', { feedback: 5, resume: true })

  const { students } = await fetchAllStudents()
  const row: any = students.find(s => s.email === 'aarti@example.com')
  assert.ok(row, 'the student is listed')

  const blanks = REPORT_COLUMNS.filter(col => row[col] === '' || row[col] === undefined)
  assert.deepEqual(blanks, [], `these report columns were wiped by the feedback attach: ${blanks.join(', ')}`)

  assert.equal(row.score, '760')
  assert.equal(row.grade, 'A')
  assert.equal(row.percentile, '84.2')
  assert.equal(row.has_assessment, 'Yes')
  assert.equal(row.english, '165')
  assert.equal(row.english_listening, '42')
  assert.equal(row.teamwork, '20')
  assert.equal(row.resume_score, '82')
  assert.equal(row.assessed_at, '2026-09-01T10:31:00.000Z')
  // …and the feedback is attached too, not instead.
  assert.equal(row.feedback_rating, '5')
  assert.equal(row.feedback_message, 'Good assessment, up to the mark.')
  assert.equal(row.feedback_count, '1')
  assert.equal(row.feedback_history?.length, 1)
  await cleanup()
})

test('a student without feedback shows the same report', async () => {
  const cleanup = useTempStore()
  seedStudent('u_10002', 'rohan@example.com', { resume: true })

  const { students } = await fetchAllStudents()
  const row: any = students.find(s => s.email === 'rohan@example.com')
  assert.equal(row.score, '760')
  assert.equal(row.grade, 'A')
  assert.equal(row.english, '165')
  assert.equal(row.resume_score, '82')
  assert.equal(row.feedback_rating, '')
  assert.equal(row.feedback_count, '')
  await cleanup()
})

test('two submissions count twice, the newest wins, the report survives', async () => {
  const cleanup = useTempStore()
  seedStudent('u_10003', 'neha@example.com', { resume: true })
  saveFeedback({
    id: 'fb_a', student_id: 'u_10003', email: 'neha@example.com', session_id: 'sess_u_10003',
    rating: 2, message: 'Could be better, more practical questions.',
    created_at: '2026-09-01T10:35:00.000Z',
  })
  // Same content arriving from both stores (local queue + Supabase) counts once.
  saveFeedback({
    id: 'fb_b', student_id: 'u_10003', email: 'neha@example.com', session_id: 'sess_u_10003',
    rating: 5, message: 'Up to the mark, well balanced.',
    created_at: '2026-09-02T09:00:00.000Z',
  })

  const { students } = await fetchAllStudents()
  const row: any = students.find(s => s.email === 'neha@example.com')
  assert.equal(row.feedback_count, '2')
  assert.equal(row.feedback_rating, '5', 'newest submission wins')
  assert.equal(row.score, '760')
  assert.equal(row.grade, 'A')
  await cleanup()
})

test('a submitted session with no saved result is still marked as taken', async () => {
  const cleanup = useTempStore()
  saveProfile({ id: 'u_10004', email: 'sameer@example.com', full_name: 'Sameer Joshi', college: 'PCCOE', updated_at: '2026-09-01T08:00:00.000Z' } as any)
  saveAssessmentSession({
    id: 'sess_u_10004', student_id: 'u_10004', status: 'submitted',
    started_at: '2026-09-01T09:00:00.000Z', expires_at: '2026-09-01T11:00:00.000Z',
    duration_sec: 7200, tab_switches: 0, answers: {},
    submitted_at: '2026-09-01T11:00:00.000Z', created_at: '2026-09-01T09:00:00.000Z',
  })
  saveFeedback({
    id: 'fb_c', student_id: 'u_10004', email: 'sameer@example.com', rating: 4,
    message: 'Reasonable, a bit long.', created_at: '2026-09-01T11:05:00.000Z',
  })

  const { students } = await fetchAllStudents()
  const row: any = students.find(s => s.email === 'sameer@example.com')
  assert.equal(row.has_assessment, 'Yes')
  assert.equal(row.score, '', 'no result row means no score')
  assert.equal(row.feedback_rating, '4')
  await cleanup()
})
