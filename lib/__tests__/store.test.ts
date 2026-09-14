import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  setDbDirectory,
  resetDbCache,
  flushDB,
  createUser,
  getUserByEmail,
  saveAssessmentSession,
  getAssessmentSession,
  saveAssessmentResult,
  getLatestAssessmentResultForStudent,
} from '../db.ts'

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'calibiai-store-'))
}

test('store: writes survive a cache reset (durability)', async () => {
  const dir = tmpdir()
  setDbDirectory(dir)
  createUser('alice@example.com', 'hash', 'student', 'inst_iitm', 'Alice')
  await flushDB()
  resetDbCache()
  const u = getUserByEmail('alice@example.com')
  assert.ok(u)
  assert.equal(u!.name, 'Alice')
})

test('store: cross-process writes are preserved by the id merge (no clobber)', async () => {
  const dir = tmpdir()
  setDbDirectory(dir)

  // This process writes a session.
  const session = {
    id: 'sess_local',
    student_id: 'u_local',
    status: 'in_progress',
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7200_000).toISOString(),
    duration_sec: 7200,
    tab_switches: 0,
    created_at: new Date().toISOString(),
  }
  saveAssessmentSession(session)
  await flushDB()

  // Simulate ANOTHER process (or another PM2 worker) inserting a row directly
  // into the runtime file after our last read.
  const runtime = path.join(dir, 'calibiai_db.runtime.json')
  const onDisk = JSON.parse(fs.readFileSync(runtime, 'utf-8'))
  onDisk.users.push({
    id: 'u_foreign',
    email: 'foreign@example.com',
    password_hash: 'x',
    role: 'student',
    institution_id: 'inst_iitm',
    name: 'Foreign',
    created_at: new Date().toISOString(),
  })
  fs.writeFileSync(runtime, JSON.stringify(onDisk, null, 2))

  // Now this process writes something else and flushes. The foreign row must
  // survive the merge (our worker must not erase the other worker's insert).
  saveAssessmentResult({
    id: 'res_1',
    session_id: 'sess_local',
    student_id: 'u_local',
    scores: {},
    total: 50,
    grade: 'B',
    percentile: 40,
    verifiable_hash: 'abc',
    created_at: new Date().toISOString(),
  })
  await flushDB()

  const final = JSON.parse(fs.readFileSync(runtime, 'utf-8'))
  const emails = final.users.map((u: any) => u.email)
  assert.ok(emails.includes('foreign@example.com'), 'foreign user was not clobbered')
  assert.ok(final.assessment_sessions.some((s: any) => s.id === 'sess_local'))
  assert.ok(final.assessment_results.some((r: any) => r.id === 'res_1'))
})

test('store: mtime revalidation picks up another worker\u2019s writes', async () => {
  const dir = tmpdir()
  setDbDirectory(dir)
  createUser('first@example.com', 'h')
  await flushDB()
  // Another process appends directly to disk (bypassing this process's cache).
  const runtime = path.join(dir, 'calibiai_db.runtime.json')
  const onDisk = JSON.parse(fs.readFileSync(runtime, 'utf-8'))
  onDisk.users.push({
    id: 'u_2',
    email: 'second@example.com',
    password_hash: 'x',
    role: 'student',
    institution_id: 'inst_iitm',
    name: 'Second',
    created_at: new Date().toISOString(),
  })
  fs.writeFileSync(runtime, JSON.stringify(onDisk, null, 2))
  // Force a distinct mtime so the stat-based revalidation reliably fires (in a
  // real deployment the rewrite naturally lands in a later millisecond).
  const future = new Date(Date.now() + 2000)
  fs.utimesSync(runtime, future, future)
  // No resetDbCache() — the mtime check alone must notice the new row.
  assert.ok(getUserByEmail('second@example.com'))
})

test('store: result lookup returns latest per student', async () => {
  const dir = tmpdir()
  setDbDirectory(dir)
  const mk = (id: string, ts: string) => ({
    id,
    session_id: id,
    student_id: 'stu',
    scores: {},
    total: 0,
    grade: 'D',
    percentile: 0,
    verifiable_hash: '',
    created_at: ts,
  })
  saveAssessmentResult(mk('r1', '2026-01-01T00:00:00.000Z'))
  saveAssessmentResult(mk('r2', '2026-02-01T00:00:00.000Z'))
  await flushDB()
  const latest = getLatestAssessmentResultForStudent('stu')
  assert.equal(latest!.id, 'r2')
})

test('store: sessions round-trip through a flush', async () => {
  const dir = tmpdir()
  setDbDirectory(dir)
  saveAssessmentSession({
    id: 'sess_1',
    student_id: 'stu_1',
    status: 'in_progress',
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7200_000).toISOString(),
    duration_sec: 7200,
    tab_switches: 0,
    created_at: new Date().toISOString(),
  })
  await flushDB()
  assert.ok(getAssessmentSession('sess_1'))
})
