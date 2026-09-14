/**
 * Pagination helpers (lib/adminPage.ts): param parsing, search sanitizing,
 * ordering, filtering, and — the critical part — the merge-window math that
 * lets the server paginate in SQL while interleaving local-store rows.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ADMIN_PAGE_SIZE_DEFAULT,
  ADMIN_PAGE_SIZE_MAX,
  buildSearchOr,
  compareAdminRows,
  filterAdminRows,
  parsePageParams,
  remoteWindowFor,
  sanitizeLikeFragment,
  sliceMergedPage,
} from '../adminPage.ts'
import type { AdminStudentRow } from '../csv.ts'

const row = (over: Partial<AdminStudentRow> & { student_id: string }): AdminStudentRow =>
  ({
    email: '',
    name: '',
    role: 'student',
    prn: '',
    phone: '',
    dob: '',
    gender: '',
    degree: '',
    college: '',
    graduation_year: '',
    cgpa: '',
    skills: '',
    resume_skills: '',
    all_skills: '',
    linkedin_url: '',
    github_url: '',
    created_at: '',
    resume_score: '',
    has_assessment: 'No',
    score: '',
    grade: '',
    percentile: '',
    english: '',
    english_listening: '',
    english_speaking: '',
    english_reading: '',
    english_writing: '',
    problem_solving: '',
    ai_debugging: '',
    ai_feature: '',
    prompt_engineering: '',
    cognitive: '',
    cognitive_grid: '',
    cognitive_logical: '',
    behavioral_total: '',
    teamwork: '',
    accountability: '',
    adaptability: '',
    responsible_ai: '',
    decision_making: '',
    learning_mindset: '',
    listening_correct: '',
    listening_total: '',
    reading_correct: '',
    reading_total: '',
    problem_correct: '',
    problem_total: '',
    logical_correct: '',
    logical_total: '',
    verifiable_hash: '',
    assessed_at: '',
    feedback_rating: '',
    feedback_message: '',
    feedback_at: '',
    feedback_count: '',
    ...over,
  }) as AdminStudentRow

// ---------------------------------------------------------------------------
// parsePageParams
// ---------------------------------------------------------------------------

test('parsePageParams: defaults for empty input', () => {
  assert.deepEqual(parsePageParams({}), {
    page: 1,
    pageSize: ADMIN_PAGE_SIZE_DEFAULT,
    college: '',
    q: '',
    sort: 'score',
    dir: 'desc',
    assessed: false,
  })
})

test('parsePageParams: clamps and sanitizes hostile input', () => {
  const p = parsePageParams({
    page: '0',
    pageSize: '9999',
    college: '  PCCOE  ',
    q: 'x'.repeat(500),
    sort: 'DROP TABLE',
    dir: 'sideways',
    assessed: 'yes',
  })
  assert.equal(p.page, 1)
  assert.equal(p.pageSize, ADMIN_PAGE_SIZE_MAX)
  assert.equal(p.college, 'PCCOE')
  assert.equal(p.q.length, 100)
  assert.equal(p.sort, 'score')
  assert.equal(p.dir, 'desc')
  assert.equal(p.assessed, true)
})

test('parsePageParams: name sort defaults to ascending', () => {
  assert.equal(parsePageParams({ sort: 'name' }).dir, 'asc')
  assert.equal(parsePageParams({ sort: 'name', dir: 'desc' }).dir, 'desc')
  assert.equal(parsePageParams({ assessed: '1' }).assessed, true)
  assert.equal(parsePageParams({ assessed: '' }).assessed, false)
})

// ---------------------------------------------------------------------------
// buildSearchOr / sanitizeLikeFragment
// ---------------------------------------------------------------------------

test('buildSearchOr: searches all five columns', () => {
  assert.equal(
    buildSearchOr('aarti'),
    'full_name.ilike.*aarti*,email.ilike.*aarti*,prn.ilike.*aarti*,phone.ilike.*aarti*,college.ilike.*aarti*',
  )
})

test('buildSearchOr: strips PostgREST-structural characters', () => {
  // Commas/parens/quotes/colons/backslashes/asterisks would corrupt the or()
  // logic string — they must never reach the query (only the two intentional
  // `*` wildcards wrapping each value may appear).
  const built = buildSearchOr('a,b(c)d"e:f\\g*h')
  assert.ok(built)
  for (const part of built.split(',')) {
    const value = part.replace(/^[a-z_]+\.ilike\./, '')
    assert.match(value, /^\*[A-Za-z0-9_@+ -]+\*$/)
  }
  assert.ok(built.includes('*abcdefgh*'))
})

test('buildSearchOr: dots become single-char wildcards (emails stay searchable)', () => {
  const built = buildSearchOr('aarti@x.com')
  assert.ok(built && built.includes('*aarti@x_com*'))
})

test('buildSearchOr: returns null when nothing searchable remains', () => {
  assert.equal(buildSearchOr(''), null)
  assert.equal(buildSearchOr('   '), null)
  assert.equal(buildSearchOr('...'), null)
  assert.equal(buildSearchOr(',,,(('), null)
})

test('sanitizeLikeFragment: leaves spaces, plus and dash alone', () => {
  assert.equal(sanitizeLikeFragment('+91 98220-11111'), '+91 98220-11111')
})

// ---------------------------------------------------------------------------
// compareAdminRows
// ---------------------------------------------------------------------------

test('compareAdminRows: score desc puts missing scores last', () => {
  const rows = [
    row({ student_id: 'a', score: '', college: 'X' }),
    row({ student_id: 'b', score: '900', college: 'X' }),
    row({ student_id: 'c', score: '750', college: 'X' }),
  ].sort(compareAdminRows('score', 'desc'))
  assert.deepEqual(rows.map(r => r.student_id), ['b', 'c', 'a'])
})

test('compareAdminRows: score asc puts missing scores first', () => {
  const rows = [
    row({ student_id: 'a', score: '900', college: 'X' }),
    row({ student_id: 'b', score: '', college: 'X' }),
    row({ student_id: 'c', score: '750', college: 'X' }),
  ].sort(compareAdminRows('score', 'asc'))
  assert.deepEqual(rows.map(r => r.student_id), ['b', 'c', 'a'])
})

test('compareAdminRows: ties break by college, then student_id', () => {
  const rows = [
    row({ student_id: 's3', score: '800', college: 'Zeal' }),
    row({ student_id: 's1', score: '800', college: 'PCCOE' }),
    row({ student_id: 's2', score: '800', college: 'PCCOE' }),
  ].sort(compareAdminRows('score', 'desc'))
  assert.deepEqual(rows.map(r => r.student_id), ['s1', 's2', 's3'])
})

test('compareAdminRows: name sort is deterministic', () => {
  const rows = [
    row({ student_id: 'b', name: 'Rohan', college: 'X' }),
    row({ student_id: 'a', name: 'Aarti', college: 'X' }),
  ].sort(compareAdminRows('name', 'asc'))
  assert.deepEqual(rows.map(r => r.student_id), ['a', 'b'])
})

// ---------------------------------------------------------------------------
// filterAdminRows
// ---------------------------------------------------------------------------

test('filterAdminRows: college exact (case-insensitive), q substring, assessed', () => {
  const rows = [
    row({ student_id: 'a', name: 'Aarti', email: 'a@x.com', college: 'PCCOE', has_assessment: 'Yes' }),
    row({ student_id: 'b', name: 'Rohan', email: 'rohan@x.com', college: 'pccoe satellite', has_assessment: 'No' }),
    row({ student_id: 'c', name: 'Sneha', email: 's@x.com', college: 'COEP', has_assessment: 'Yes' }),
  ]
  assert.deepEqual(filterAdminRows(rows, { college: 'pccoe' }).map(r => r.student_id), ['a'])
  assert.deepEqual(filterAdminRows(rows, { q: 'ROHAN' }).map(r => r.student_id), ['b'])
  assert.deepEqual(filterAdminRows(rows, { q: 'x.com' }).map(r => r.student_id), ['a', 'b', 'c'])
  assert.deepEqual(filterAdminRows(rows, { assessed: true }).map(r => r.student_id), ['a', 'c'])
  assert.deepEqual(
    filterAdminRows(rows, { college: 'COEP', q: 'sneha', assessed: true }).map(r => r.student_id),
    ['c'],
  )
})

// ---------------------------------------------------------------------------
// Merge-window math: exhaustive check against naive merge-all-then-slice.
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random scores so fixtures interleave unpredictably. */
function fixtureScore(i: number, salt: number): string {
  if ((i * 7 + salt) % 5 === 0) return '' // some rows without scores
  return String(500 + ((i * 7919 + salt * 131) % 500))
}

test('window math: every page matches naive merge for many shapes', () => {
  const shapes: Array<{ remote: number; local: number; size: number }> = [
    { remote: 0, local: 0, size: 50 },
    { remote: 0, local: 16, size: 50 },
    { remote: 37, local: 0, size: 10 },
    { remote: 37, local: 16, size: 10 },
    { remote: 120, local: 3, size: 50 },
    { remote: 120, local: 40, size: 25 },
    { remote: 1000, local: 16, size: 50 },
    { remote: 53, local: 53, size: 7 },
  ]
  for (const { remote: nRemote, local: nLocal, size } of shapes) {
    for (const sort of ['score', 'name'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const cmp = compareAdminRows(sort, dir)
        const remoteAll = Array.from({ length: nRemote }, (_, i) =>
          row({
            student_id: `r-${String(i).padStart(4, '0')}`,
            name: `Remote ${String((i * 37) % 997).padStart(3, '0')}`,
            college: ['PCCOE', 'COEP', 'Zeal'][i % 3],
            score: fixtureScore(i, 1),
          }),
        ).sort(cmp)
        const localAll = Array.from({ length: nLocal }, (_, i) =>
          row({
            student_id: `u_${i}`,
            name: `Local ${String((i * 53) % 991).padStart(3, '0')}`,
            college: ['PCCOE', 'MIT'][i % 2],
            score: fixtureScore(i, 7),
          }),
        ).sort(cmp)
        const naive = [...remoteAll, ...localAll].sort(cmp)
        const totalPages = Math.max(1, Math.ceil(naive.length / size))
        for (let page = 1; page <= totalPages; page++) {
          // What the server does: over-fetch a remote window, merge with ALL
          // local rows, sort, slice.
          const { offset, limit } = remoteWindowFor(page, size, localAll.length)
          const windowRows = remoteAll.slice(offset, offset + limit)
          const merged = [...windowRows, ...localAll].sort(cmp)
          const got = sliceMergedPage(merged, page, size, offset)
          const want = naive.slice((page - 1) * size, page * size)
          assert.deepEqual(
            got.map(r => r.student_id),
            want.map(r => r.student_id),
            `page ${page}/${totalPages} sort=${sort} dir=${dir} remote=${nRemote} local=${nLocal}`,
          )
        }
      }
    }
  }
})

test('remoteWindowFor: collapses to plain OFFSET/LIMIT without local rows', () => {
  assert.deepEqual(remoteWindowFor(3, 50, 0), { offset: 100, limit: 50 })
  assert.deepEqual(remoteWindowFor(1, 50, 16), { offset: 0, limit: 82 })
})
