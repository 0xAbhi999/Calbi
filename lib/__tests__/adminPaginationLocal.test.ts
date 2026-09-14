/**
 * Paginated admin reads in local demo mode (no Supabase env vars): the same
 * filter/sort/slice semantics, served from the JSON store.
 *
 * NOTE: no Supabase env is set in this file on purpose — each test file runs
 * in its own process, so getServerClient() stays null here.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'node:os'
import path from 'node:path'

import { fetchAdminMeta, fetchStudentsPage } from '../adminStudents.ts'
import { parsePageParams } from '../adminPage.ts'
import { flushDB, saveAssessmentResult, saveProfile, setDbDirectory } from '../db.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-pagination-local-'))
setDbDirectory(dir)

const mkResult = (studentId: string, total: number) => ({
  id: `res_${studentId}`,
  session_id: `sess_${studentId}`,
  student_id: studentId,
  scores: { total, grade: 'A' },
  total,
  grade: 'A',
  percentile: 80,
  verifiable_hash: `hash:${studentId}`,
  created_at: '2026-09-05T09:00:00.000Z',
})

// 7 students: 5 scored (two colleges), 1 attempted-without-result, 1 fresh.
const seed: Array<{ id: string; name: string; college: string; total?: number }> = [
  { id: 'u_1', name: 'Aarav', college: 'PCCOE', total: 900 },
  { id: 'u_2', name: 'Rohan', college: 'PCCOE', total: 850 },
  { id: 'u_3', name: 'Sneha', college: 'COEP', total: 800 },
  { id: 'u_4', name: 'Vikram', college: 'PCCOE' },
  { id: 'u_5', name: 'Ishaan', college: 'COEP', total: 780 },
  { id: 'u_6', name: 'Divya', college: 'PCCOE', total: 760 },
  { id: 'u_7', name: 'Kabir', college: 'MIT' },
]
for (const s of seed) {
  saveProfile({ id: s.id, email: `${s.id}@local.test`, full_name: s.name, college: s.college, updated_at: '2026-09-05T08:00:00.000Z' })
  if (s.total !== undefined) saveAssessmentResult(mkResult(s.id, s.total))
}

test('local mode: pages slice the sorted set with an exact total', async () => {
  const p1 = await fetchStudentsPage(parsePageParams({ page: '1', pageSize: '3' }))
  assert.equal(p1.source, 'local')
  assert.equal(p1.total, 7)
  assert.equal(p1.totalPages, 3)
  assert.deepEqual(p1.sources, { supabase: 0, local: 7 })
  assert.deepEqual(p1.students.map(s => s.student_id), ['u_1', 'u_2', 'u_3'])
  const p2 = await fetchStudentsPage(parsePageParams({ page: '2', pageSize: '3' }))
  // Score ties break by college: MIT (u_7) sorts before PCCOE (u_4).
  assert.deepEqual(p2.students.map(s => s.student_id), ['u_5', 'u_6', 'u_7'])
  const p3 = await fetchStudentsPage(parsePageParams({ page: '3', pageSize: '3' }))
  assert.deepEqual(p3.students.map(s => s.student_id), ['u_4'])
})

test('local mode: college + search + assessed filters combine', async () => {
  const page = await fetchStudentsPage(parsePageParams({ college: 'PCCOE', assessed: '1', pageSize: '50' }))
  assert.deepEqual(page.students.map(s => s.student_id), ['u_1', 'u_2', 'u_6'])
  const q = await fetchStudentsPage(parsePageParams({ q: 'ishaan', pageSize: '50' }))
  assert.deepEqual(q.students.map(s => s.student_id), ['u_5'])
})

test('local mode: meta aggregates the local store', async () => {
  const meta = await fetchAdminMeta()
  assert.deepEqual(meta.colleges, ['COEP', 'MIT', 'PCCOE'])
  assert.deepEqual(meta.stats, { total: 7, colleges: 3, assessed: 5, avg: 818 })
})

after(async () => {
  await flushDB()
  fs.rmSync(dir, { recursive: true, force: true })
})
