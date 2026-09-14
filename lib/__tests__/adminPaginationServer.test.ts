/**
 * Server-side pagination against a real supabase-js client pointed at an
 * in-process PostgREST stand-in that actually implements filtering, ordering,
 * range windows and exact counts — so the test proves the generated SQL-side
 * queries are correct, not just the merge logic.
 *
 * Fixtures: 10 remote students (8 scored, 1 attempted-without-result, 1
 * resultless) + 2 local rows (1 unique top scorer, 1 duplicate-by-email that
 * enriches a resultless remote row).
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54401'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { fetchAdminMeta, fetchStudentsFingerprint, fetchStudentsPage } from '../adminStudents.ts'
import { parsePageParams } from '../adminPage.ts'
import { flushDB, saveAssessmentResult, saveFeedback, saveProfile, setDbDirectory } from '../db.ts'

// ---------------------------------------------------------------- fixtures

const R1 = '11111111-1111-4111-8111-111111111111'
const R2 = '22222222-2222-4222-8222-222222222222'
const R3 = '33333333-3333-4333-8333-333333333333'
const R4 = '44444444-4444-4444-8444-444444444444'
const R5 = '55555555-5555-4555-8555-555555555555'
const R6 = '66666666-6666-4666-8666-666666666666'
const R7 = '77777777-7777-4777-8777-777777777777'
const R8 = '88888888-8888-4888-8888-888888888888'
const R9 = '99999999-9999-4999-8999-999999999999'
const R10 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const vrow = (id: string, name: string, college: string, talent: number | null, attempted: boolean, email: string) => ({
  student_id: id,
  email,
  role: 'student',
  full_name: name,
  prn: 'PRN' + id.slice(0, 4),
  phone: '+91 90000' + id.slice(0, 4).replace(/-/g, ''),
  dob: null,
  gender: null,
  degree: 'B.Tech',
  college,
  institution_id: null,
  graduation_year: 2026,
  cgpa: 8.0,
  skills: 'Python',
  linkedin_url: null,
  github_url: null,
  ai_avatar: null,
  profile_created_at: '2026-09-01T08:00:00.000Z',
  profile_updated_at: '2026-09-01T08:00:00.000Z',
  resume_id: null,
  resume_storage_key: null,
  resume_score: 80,
  resume_parsed: { skills: ['Python'] },
  resume_created_at: '2026-09-01T09:00:00.000Z',
  assessment_session_id: talent !== null ? `sess-${id.slice(0, 8)}` : null,
  talent_score: talent,
  grade: talent !== null ? 'A' : null,
  percentile: talent !== null ? 80 : null,
  assessment_scores:
    talent !== null
      ? { total: talent, grade: 'A', english: { total: 150 }, cognitive: { total: 150 } }
      : null,
  verifiable_hash: talent !== null ? 'hash:' + id.slice(0, 8) : null,
  report_storage_key: null,
  assessment_created_at: talent !== null ? '2026-09-02T10:00:00.000Z' : null,
  assessment_attempted: attempted,
})

const VIEW_ROWS = [
  vrow(R1, 'Aarav Sharma', 'PCCOE', 900, true, 'aarav@x.com'),
  vrow(R2, 'Rohan Verma', 'PCCOE', 850, true, 'rohan@x.com'),
  vrow(R3, 'Sneha Iyer', 'COEP', null, false, 'sneha@x.com'),
  vrow(R4, 'Vikram Rao', 'PCCOE', null, true, 'vikram@x.com'),
  vrow(R5, 'Ishaan Mehta', 'COEP', 800, true, 'ishaan@x.com'),
  vrow(R6, 'Divya Nair', 'PCCOE', 780, true, 'divya@x.com'),
  vrow(R7, 'Kabir Singh', 'PCCOE', 760, true, 'kabir@x.com'),
  vrow(R8, 'Ananya Das', 'COEP', 740, true, 'ananya@x.com'),
  vrow(R9, 'Arjun Patel', 'PCCOE', 720, true, 'arjun@x.com'),
  vrow(R10, 'Meera Joshi', 'PCCOE', 700, true, 'meera@x.com'),
]

const PROFILES = VIEW_ROWS.map(r => ({ id: r.student_id, email: r.email }))

const SESSIONS = [
  { id: '90000000-0000-4000-8000-000000000001', student_id: R1, status: 'submitted', submitted_at: '2026-09-02T10:00:00.000Z', created_at: '2026-09-02T08:00:00.000Z' },
  { id: '90000000-0000-4000-8000-000000000004', student_id: R4, status: 'submitted', submitted_at: '2026-09-03T10:00:00.000Z', created_at: '2026-09-03T08:00:00.000Z' },
]

const FEEDBACK = [
  { id: 'a0000000-0000-4000-8000-000000000001', student_id: R1, student_ref: R1, email: 'aarav@x.com', session_id: 'sess-1', rating: 5, message: 'Remote feedback row here', source: 'web', created_at: '2026-09-04T10:00:00.000Z' },
  { id: 'a0000000-0000-4000-8000-000000000002', student_id: R2, student_ref: R2, email: 'rohan@x.com', session_id: 'sess-2', rating: 4, message: 'Second remote row', source: 'web', created_at: '2026-09-04T11:00:00.000Z' },
]

const STATS_ROW = {
  total_students: 10,
  assessed_students: 9,
  scored_students: 8,
  avg_score: 781.25,
  colleges: ['COEP', 'PCCOE'],
}

// ---------------------------------------------------------------- stand-in

const mode = { view: 'ok' as 'ok' | 'missing', attemptedCol: true, narrowFails: false, stats: 'ok' as 'ok' | 'missing' }
const requested: string[] = []

const likeToRegExp = (pattern: string): RegExp => {
  const src = pattern
    .split('')
    .map(ch => (ch === '*' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${src}$`, 'i')
}

const inList = (v: string | null): string[] =>
  v && v.startsWith('in.(') && v.endsWith(')') ? v.slice(4, -1).split(',').filter(Boolean) : []

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x')
  const table = url.pathname.match(/^\/rest\/v1\/([a-z_]+)/)?.[1] || ''
  const sp = url.searchParams
  requested.push(`${req.method} ${table}?${sp.toString()}`)
  const json = (code: number, body: any, extra: Record<string, string> = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...extra })
    res.end(JSON.stringify(body))
  }

  if (table === 'admin_stats') {
    if (mode.stats === 'missing') {
      return json(404, { code: 'PGRST205', message: "Could not find the table 'public.admin_stats' in the schema cache" })
    }
    const single = (req.headers.accept || '').includes('vnd.pgrst.object')
    return json(200, single ? STATS_ROW : [STATS_ROW])
  }

  if (table === 'profiles') {
    if (sp.has('id') && sp.get('id')!.startsWith('in.(')) {
      const set = new Set(inList(sp.get('id')))
      return json(200, PROFILES.filter(p => set.has(p.id)))
    }
    if (sp.has('email') && sp.get('email')!.startsWith('in.(')) {
      const set = new Set(inList(sp.get('email')).map(s => s.toLowerCase()))
      return json(200, PROFILES.filter(p => set.has(p.email.toLowerCase())))
    }
    return json(200, [])
  }

  if (table === 'assessment_sessions') {
    const set = new Set(inList(sp.get('student_id')))
    return json(200, SESSIONS.filter(s => set.has(s.student_id)))
  }

  if (table === 'feedback_submissions') {
    if (sp.has('student_ref')) {
      const set = new Set(inList(sp.get('student_ref')))
      return json(200, FEEDBACK.filter(f => set.has(f.student_ref)))
    }
    if (sp.has('email')) {
      const set = new Set(inList(sp.get('email')).map(s => s.toLowerCase()))
      return json(200, FEEDBACK.filter(f => (f.email || '').toLowerCase() && set.has((f.email || '').toLowerCase())))
    }
    return json(200, [])
  }

  if (table === 'resume_analyses' || table === 'assessment_results') return json(200, [])

  if (table === 'student_profiles_full') {
    if (mode.view === 'missing') {
      return json(404, { code: 'PGRST205', message: "Could not find the table 'public.student_profiles_full' in the schema cache" })
    }
    const select = sp.get('select') || ''
    if (mode.narrowFails && select !== '*' && select.includes('prn')) {
      return json(400, { code: '42703', message: 'column "prn" of relation "student_profiles_full" does not exist' })
    }
    let rows = [...VIEW_ROWS]
    if (sp.get('role') === 'eq.student') rows = rows.filter(r => r.role === 'student')
    if (sp.has('college') && sp.get('college')!.startsWith('ilike.')) {
      const want = sp.get('college')!.slice('ilike.'.length).toLowerCase()
      rows = rows.filter(r => (r.college || '').toLowerCase() === want)
    }
    if (sp.has('or')) {
      const branches = sp
        .get('or')!
        .replace(/^\(|\)$/g, '')
        .split(',')
        .map(b => {
          const m = b.match(/^([a-z_]+)\.ilike\.(.*)$/)
          return m ? { col: m[1], rx: likeToRegExp(m[2]) } : null
        })
      rows = rows.filter(r => branches.some(b => b && b.rx.test(String((r as any)[b.col] ?? ''))))
    }
    if (sp.get('assessment_attempted') === 'eq.true') {
      if (!mode.attemptedCol) {
        return json(400, { code: '42703', message: 'column "assessment_attempted" of relation "student_profiles_full" does not exist' })
      }
      rows = rows.filter(r => r.assessment_attempted === true)
    }
    if (sp.get('talent_score') === 'not.is.null') rows = rows.filter(r => r.talent_score !== null && r.talent_score !== undefined)
    if (sp.has('student_id') && sp.get('student_id')!.startsWith('eq.')) {
      const want = sp.get('student_id')!.slice('eq.'.length)
      rows = rows.filter(r => r.student_id === want)
    }
    const specs = (sp.get('order') || '')
      .split(',')
      .filter(Boolean)
      .map(o => {
        const [col, dir, nulls] = o.split('.')
        return { col, asc: dir !== 'desc', nullsFirst: nulls === 'nullsfirst' }
      })
    rows.sort((a, b) => {
      for (const s of specs) {
        const av = (a as any)[s.col]
        const bv = (b as any)[s.col]
        const an = av === null || av === undefined
        const bn = bv === null || bv === undefined
        if (an || bn) {
          if (an && bn) continue
          return (s.nullsFirst ? (an ? -1 : 1) : an ? 1 : -1)
        }
        if (av === bv) continue
        const c = av < bv ? -1 : 1
        return s.asc ? c : -c
      }
      return 0
    })
    const total = rows.length
    const offset = Number(sp.get('offset') || 0)
    const limit = Number(sp.get('limit') || total)
    const slice = rows.slice(offset, offset + limit)
    const extra: Record<string, string> = {}
    if ((req.headers.prefer || '').includes('count=exact')) {
      extra['Content-Range'] = slice.length ? `${offset}-${offset + slice.length - 1}/${total}` : `*/${total}`
    }
    return json(200, slice, extra)
  }

  return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` })
})

// ---------------------------------------------------------------- local seed

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-pagination-test-'))
setDbDirectory(dir)

saveProfile({ id: 'u_lo1', email: 'zoya@local.test', full_name: 'Zoya Khan', college: 'PCCOE', updated_at: '2026-09-05T08:00:00.000Z' })
saveAssessmentResult({
  id: 'res_lo1', session_id: 'sess_lo1', student_id: 'u_lo1',
  scores: { total: 960, grade: 'S', english: { total: 190 }, cognitive: { total: 190 } },
  total: 960, grade: 'S', percentile: 99, verifiable_hash: 'hash:lo1', created_at: '2026-09-05T09:00:00.000Z',
})
saveFeedback({ id: 'fb_lo1', student_id: 'u_lo1', email: 'zoya@local.test', rating: 5, message: 'Local topper feedback here', created_at: '2026-09-05T10:00:00.000Z' })
// Duplicate of remote R3 by email — enriches R3's missing result, never a separate row.
saveProfile({ id: 'u_lo2', email: 'sneha@x.com', full_name: 'Sneha Local', college: 'COEP', updated_at: '2026-09-05T08:00:00.000Z' })
saveAssessmentResult({
  id: 'res_lo2', session_id: 'sess_lo2', student_id: 'u_lo2',
  scores: { total: 700, grade: 'B' },
  total: 700, grade: 'B', percentile: 60, verifiable_hash: 'hash:lo2', created_at: '2026-09-05T09:00:00.000Z',
})
// Local feedback for a REMOTE student (matched by id) — cross-store attach.
saveFeedback({ id: 'fb_r1', student_id: R1, email: 'aarav@x.com', rating: 4, message: 'Local feedback row here!!', created_at: '2026-09-05T11:00:00.000Z' })

await new Promise<void>(resolve => server.listen(54401, '127.0.0.1', resolve))

const viewRequests = () => requested.filter(u => u.includes('GET student_profiles_full'))

// ------------------------------------------------------------------- tests

test('ancient view: narrow select fails once, then bounded legacy projection succeeds', async () => {
  mode.narrowFails = true
  requested.length = 0
  const page = await fetchStudentsPage(parsePageParams({ page: '1', pageSize: '50' }))
  assert.equal(page.total, 11)
  assert.equal(viewRequests().length, 2)
  assert.ok(!viewRequests()[1].includes('select=*'), 'legacy retry never uses select=*')
  assert.ok(!viewRequests()[1].includes('prn'), 'legacy retry omits the unavailable column')
  mode.narrowFails = false
})

test('page 1: one SQL window + exact total + merged local topper', async () => {
  requested.length = 0
  const page = await fetchStudentsPage(parsePageParams({ page: '1', pageSize: '5' }))
  assert.equal(page.warning, undefined, `unexpected warning: ${page.warning}`)
  assert.equal(page.source, 'supabase')
  assert.equal(page.total, 11)
  assert.equal(page.page, 1)
  assert.equal(page.totalPages, 3)
  assert.deepEqual(page.sources, { supabase: 10, local: 1 })
  assert.equal(page.canSync, true)
  assert.deepEqual(page.students.map(s => s.student_id), ['u_lo1', R1, R2, R5, R6])
  assert.deepEqual(page.students.map(s => s.score), ['960', '900', '850', '800', '780'])
  // Exactly one view read, and it is a window — not a full-table download.
  assert.equal(viewRequests().length, 1)
  assert.ok(viewRequests()[0].includes('limit=7'), 'over-fetched by local count (5+2)')
  assert.ok(viewRequests()[0].includes('offset=0'))
  // Feedback comes from page-scoped lookups, never a full-table read.
  for (const u of requested.filter(x => x.includes('feedback_submissions'))) {
    assert.ok(u.includes('in.'), `page-scoped feedback lookup: ${u}`)
  }
  // Cross-store feedback: remote row + local row for the same student.
  const r1 = page.students.find(s => s.student_id === R1)!
  assert.equal(r1.feedback_count, '2')
  assert.equal(r1.feedback_history?.length, 2)
  const zoya = page.students.find(s => s.student_id === 'u_lo1')!
  assert.equal(zoya.feedback_count, '1')
})

test('page 2: continuation with enrichment + attempted-only display stayed exact elsewhere', async () => {
  const page = await fetchStudentsPage(parsePageParams({ page: '2', pageSize: '5' }))
  assert.equal(page.total, 11)
  assert.deepEqual(page.students.map(s => s.student_id), [R7, R8, R9, R3, R10])
  // R3 has no remote result — its score is filled from the shadowed local row.
  const r3 = page.students.find(s => s.student_id === R3)!
  assert.equal(r3.score, '700')
  assert.equal(r3.has_assessment, 'Yes')
  // The shadowing local row is never shown separately.
  assert.ok(!page.students.some(s => s.student_id === 'u_lo2'))
})

test('page 3: attempted-without-result row shows Taken with empty score', async () => {
  const page = await fetchStudentsPage(parsePageParams({ page: '3', pageSize: '5' }))
  assert.deepEqual(page.students.map(s => s.student_id), [R4])
  assert.equal(page.students[0].has_assessment, 'Yes')
  assert.equal(page.students[0].score, '')
  assert.equal(page.students[0].assessed_at, '2026-09-03T10:00:00.000Z')
})

test('search runs in SQL and matches across stores', async () => {
  requested.length = 0
  const one = await fetchStudentsPage(parsePageParams({ q: 'aarav', pageSize: '50' }))
  assert.deepEqual(one.students.map(s => s.student_id), [R1])
  assert.ok(viewRequests()[0].includes('or='), 'search pushed into SQL or()')
  const many = await fetchStudentsPage(parsePageParams({ q: 'x.com', pageSize: '50' }))
  // All 10 remote emails match; the local sneha@x.com row is shadowed by R3.
  assert.equal(many.total, 10)
})

test('college filter is exact and case-insensitive', async () => {
  requested.length = 0
  const page = await fetchStudentsPage(parsePageParams({ college: 'pccoe', pageSize: '50' }))
  assert.ok(viewRequests()[0].includes('college=ilike.pccoe'))
  assert.equal(page.total, 8)
  assert.ok(page.students.every(s => s.college === 'PCCOE'))
})

test('name sort orders across the merged set', async () => {
  const page = await fetchStudentsPage(parsePageParams({ sort: 'name', pageSize: '4' }))
  assert.deepEqual(page.students.map(s => s.name), ['Aarav Sharma', 'Ananya Das', 'Arjun Patel', 'Divya Nair'])
})

test('assessed filter uses assessment_attempted when migrated', async () => {
  requested.length = 0
  const page = await fetchStudentsPage(parsePageParams({ assessed: '1', pageSize: '50' }))
  assert.ok(viewRequests()[0].includes('assessment_attempted=eq.true'))
  // 8 scored + attempted-only R4 + local topper; resultless R3 excluded.
  assert.equal(page.total, 10)
  assert.ok(page.students.some(s => s.student_id === R4))
  assert.ok(!page.students.some(s => s.student_id === R3))
})

test('assessed filter falls back to talent-only without migration 0006', async () => {
  mode.attemptedCol = false
  requested.length = 0
  try {
    const page = await fetchStudentsPage(parsePageParams({ assessed: '1', pageSize: '50' }))
    assert.equal(viewRequests().length, 2)
    assert.ok(viewRequests()[1].includes('talent_score=not.is.null'))
    assert.equal(page.total, 9)
    assert.ok(!page.students.some(s => s.student_id === R4))
  } finally {
    mode.attemptedCol = true
  }
})

test('page beyond the end clamps to the last page', async () => {
  const page = await fetchStudentsPage(parsePageParams({ page: '99', pageSize: '5' }))
  assert.equal(page.page, 3)
  assert.deepEqual(page.students.map(s => s.student_id), [R4])
})

test('meta: single-row stats view + local merge', async () => {
  requested.length = 0
  const meta = await fetchAdminMeta()
  assert.ok(requested.some(u => u.includes('GET admin_stats')), 'stats view queried')
  assert.deepEqual(meta.colleges, ['COEP', 'PCCOE'])
  assert.deepEqual(meta.stats, { total: 11, colleges: 2, assessed: 10, avg: 801 })
})

test('meta: falls back to a bounded scan without migration 0006', async () => {
  mode.stats = 'missing'
  requested.length = 0
  try {
    const meta = await fetchAdminMeta()
    const scan = requested.find(u => u.includes('GET student_profiles_full'))
    assert.ok(scan && scan.includes('select=talent_score'), `bounded scan used: ${scan}`)
    assert.ok(scan && scan.includes('limit=100'), `scan is capped: ${scan}`)
    assert.deepEqual(meta.stats, { total: 11, colleges: 2, assessed: 9, avg: 801 })
  } finally {
    mode.stats = 'missing'
  }
})

test('missing compact probe never revives the old eight-query polling path', async () => {
  requested.length = 0
  const first = await fetchStudentsFingerprint()
  const afterFirst = requested.length
  const second = await fetchStudentsFingerprint()
  assert.equal(afterFirst, 1, `only the compact probe should be queried: ${requested.join(' | ')}`)
  assert.equal(requested.length, afterFirst, 'the short fingerprint cache should coalesce the next poll')
  assert.equal(second.fingerprint, first.fingerprint)
  assert.ok(requested[0].includes('admin_change_probe'))
  assert.ok(!requested.some(u => /profiles|assessment_results|resume_analyses|feedback_submissions/.test(u)))
})

test('missing view: degraded fallback still shows local rows with a warning', async () => {
  mode.view = 'missing'
  requested.length = 0
  try {
    const page = await fetchStudentsPage(parsePageParams({ page: '1', pageSize: '50' }))
    assert.ok(page.warning && page.warning.includes('fallback'), `warning: ${page.warning}`)
    assert.deepEqual(page.students.map(s => s.student_id), ['u_lo1', 'u_lo2'])
    assert.equal(page.total, 2)
    assert.equal(page.students[0].feedback_count, '1')
  } finally {
    mode.view = 'ok'
  }
})

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await flushDB()
  fs.rmSync(dir, { recursive: true, force: true })
})
