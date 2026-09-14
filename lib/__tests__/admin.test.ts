import test from 'node:test'
import assert from 'node:assert/strict'

import { CSV_COLUMNS, rowsToCsv, downloadFilename } from '../csv.ts'
import { filterRows } from '../adminFilters.ts'
import { buildRow, fillAssessmentFrom, mergeSkills, mergeStudentRows } from '../studentRows.ts'

/* ------------------------------------------------------------------ */
/* mergeSkills                                                         */
/* ------------------------------------------------------------------ */

test('mergeSkills dedupes profile + resume skills case-insensitively', () => {
  const out = mergeSkills('Python, React, SQL', { skills: ['python', 'Docker', ' SQL'] })
  assert.equal(out.skills, 'Python, React, SQL')
  assert.equal(out.resume_skills, 'python, Docker, SQL')
  assert.equal(out.all_skills, 'Python, React, SQL, Docker')
})

test('mergeSkills tolerates empty profile / resume', () => {
  const empty = mergeSkills('', {})
  assert.equal(empty.skills, '')
  assert.equal(empty.resume_skills, '')
  assert.equal(empty.all_skills, '')
})

/* ------------------------------------------------------------------ */
/* buildRow                                                            */
/* ------------------------------------------------------------------ */

test('buildRow maps a scored student into a flat export row', () => {
  const row = buildRow({
    student_id: 'u_abc',
    email: 'priya@college.edu',
    profile: {
      full_name: 'Priya Sharma',
      prn: '21CS1042',
      phone: '9876543210',
      degree: 'B.Tech CSE',
      college: 'COEP Pune',
      cgpa: 8.7,
      skills: 'Python, React',
    },
    scores: {
      total: 842,
      grade: 'A',
      percentile: 88,
      verifiable_hash: 'sha256:abc',
      created_at: '2026-09-06T10:11:55.315Z',
      scores: {
        total: 842,
        grade: 'A',
        percentile: 88,
        english: { total: 168, listening: 45, speaking: 40, reading: 43, writing: 40, max: 200 },
        problem_solving: 170,
        ai_debugging: 120,
        ai_feature: 130,
        prompt_engineering: 84,
        cognitive: {
          total: 170, grid: 24, logical: 61, behavioral_total: 85, max: 200,
          behavioral: { teamwork: 80, accountability: 90, adaptability: 70, responsible_ai: 95, decision_making: 85, learning_mindset: 90 },
        },
        detail: { listeningCorrect: 7, listeningTotal: 8, readingCorrect: 5, readingTotal: 6, problemCorrect: 9, problemTotal: 10, logicalCorrect: 6, logicalTotal: 7 },
      },
    },
    resume_score: 78,
    resume_parsed: { skills: ['Python', 'SQL'] },
    verifiable_hash: 'sha256:abc',
    assessed_at: '2026-09-06T10:11:55.315Z',
  })

  assert.equal(row.name, 'Priya Sharma')
  assert.equal(row.prn, '21CS1042')
  assert.equal(row.phone, '9876543210')
  assert.equal(row.score, '842')
  assert.equal(row.grade, 'A')
  assert.equal(row.english, '168')
  assert.equal(row.english_listening, '45')
  assert.equal(row.problem_solving, '170')
  assert.equal(row.cognitive, '170')
  assert.equal(row.teamwork, '80')
  assert.equal(row.all_skills, 'Python, React, SQL')
  assert.equal(row.has_assessment, 'Yes')
  assert.equal(row.resume_score, '78')
})

test('buildRow leaves an unassessed student blank rather than zeroed', () => {
  const row = buildRow({
    student_id: 'u_xyz',
    email: 'new@college.edu',
    profile: { full_name: 'New Student', college: 'VIT' },
    scores: null,
  })
  assert.equal(row.has_assessment, 'No')
  assert.equal(row.score, '')
  assert.equal(row.grade, '')
  assert.equal(row.english, '')
  assert.equal(row.resume_score, '')
})

test('buildRow marks a submitted session as taken even when the result is pending', () => {
  const row = buildRow({
    student_id: 'u_submitted',
    email: 'submitted@college.edu',
    profile: { full_name: 'Submitted Student' },
    scores: null,
    assessment_attempted: true,
  })
  assert.equal(row.has_assessment, 'Yes')
  assert.equal(row.score, '')
})

test('fillAssessmentFrom keeps a completed local result when the live profile has no result yet', () => {
  const live = buildRow({
    student_id: '11111111-1111-1111-1111-111111111111',
    email: 'same@college.edu',
    profile: { full_name: 'Live Student' },
    scores: null,
  })
  const local = buildRow({
    student_id: 'u_same',
    email: 'same@college.edu',
    profile: { full_name: 'Local Student' },
    scores: { total: 780, grade: 'A', percentile: 90 },
  })
  const merged = fillAssessmentFrom(live, local)
  assert.equal(merged.has_assessment, 'Yes')
  assert.equal(merged.score, '780')
  assert.equal(merged.grade, 'A')
})

/* ------------------------------------------------------------------ */
/* filterRows                                                          */
/* ------------------------------------------------------------------ */

const three = [
  { college: 'COEP Pune', name: 'Priya Sharma', email: 'p@c.com', prn: 'P1', phone: '111' },
  { college: 'VIT Pune', name: 'Rohan Mehta', email: 'r@v.com', prn: 'P2', phone: '222' },
  { college: 'COEP Pune', name: 'Aarav Joshi', email: 'a@c.com', prn: 'P3', phone: '333' },
]

test('filterRows narrows by college (case-insensitive) and free search', () => {
  assert.equal(filterRows(three, { college: 'coep pune' }).length, 2)
  assert.equal(filterRows(three, { q: 'rohan' }).length, 1)
  assert.equal(filterRows(three, { q: 'P2' }).length, 1)
  assert.equal(filterRows(three, { college: 'COEP Pune', q: 'aarav' }).length, 1)
  assert.equal(filterRows(three, {}).length, 3)
  assert.equal(filterRows(three, { q: 'nobody' }).length, 0)
})

/* ------------------------------------------------------------------ */
/* rowsToCsv                                                           */
/* ------------------------------------------------------------------ */

test('CSV columns cover personal, skills, resume and all module scores', () => {
  const labels = CSV_COLUMNS.map(c => c.label)
  for (const required of ['Name', 'PRN', 'Mobile Number', 'College', 'Profile Skills', 'All Skills', 'CalibiAI Score (/1000)', 'English (/200)', 'Cognitive (/200)', 'Feedback Rating (1-5)', 'Feedback Comment']) {
    assert.ok(labels.includes(required), `missing column ${required}`)
  }
  assert.equal(CSV_COLUMNS.length, 52)
})

test('rowsToCsv adds BOM, CRLF, quotes and guards formula injection', () => {
  const csv = rowsToCsv([
    {
      name: 'Priya, "RI" Sharma', email: 'p@c.com', prn: 'P1', phone: '9876', college: 'COEP',
      score: '=HYPERLINK("evil")', grade: 'A',
    } as any,
  ])
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes('\r\n'))
  assert.ok(csv.includes('"Priya, ""RI"" Sharma"'))
  // CSV injection cell gets a leading apostrophe
  assert.ok(csv.includes("'=HYPERLINK"))
})

test('downloadFilename embeds scope and today date', () => {
  const name = downloadFilename('all')
  assert.match(name, /^calibiai_students_all_\d{4}-\d{2}-\d{2}\.csv$/)
})

// ---------------------------------------------------------------------------
// Merging the two stores the admin now reads (Supabase + local JSON demo file).
// Students seeded into calibiai_db.json were never written to Postgres, and
// students who signed up through the app exist only in Postgres — the dashboard
// must show both without double-counting anyone.

const mk = (student_id: string, email: string, name: string, score = '') =>
  buildRow({
    student_id,
    email,
    profile: { full_name: name },
    scores: score ? { total: Number(score) } : null,
  })

test('mergeStudentRows keeps live rows and adds local-only candidates', () => {
  const remote = [mk('11111111-1111-1111-1111-111111111111', 'live@x.com', 'Live Student', '90')]
  const local = [mk('u_1', 'seed1@y.com', 'Seed One'), mk('u_2', 'seed2@y.com', 'Seed Two', '40')]
  const merged = mergeStudentRows(remote, local)
  assert.equal(merged.remote, 1)
  assert.equal(merged.local, 2)
  assert.equal(merged.rows.length, 3)
  assert.deepEqual(merged.rows.map(r => r.name).sort(), ['Live Student', 'Seed One', 'Seed Two'])
  // The live row keeps its score, the local one keeps its own.
  assert.equal(merged.rows.find(r => r.name === 'Live Student')?.score, '90')
  assert.equal(merged.rows.find(r => r.name === 'Seed One')?.score, '')
})

test('mergeStudentRows de-dupes the same student id, and the live row wins', () => {
  const id = '22222222-2222-2222-2222-222222222222'
  const remote = [mk(id, 'same@x.com', 'Live Name', '88')]
  const local = [mk(id, 'same@x.com', 'Local Name', '11')]
  const merged = mergeStudentRows(remote, local)
  assert.equal(merged.local, 0)
  assert.equal(merged.rows.length, 1)
  assert.equal(merged.rows[0].name, 'Live Name')
  assert.equal(merged.rows[0].score, '88')
})

test('mergeStudentRows de-dupes the same person when the ids differ (id vs email)', () => {
  // The same human as a real Supabase UUID and as a legacy `u_…` demo id.
  const remote = [mk('33333333-3333-3333-3333-333333333333', 'Prajwal@Gmail.com', 'Prajwal (live)', '95')]
  const local = [mk('u_84368932', 'prajwal@gmail.com', 'Prajwal (demo)', '60')]
  const merged = mergeStudentRows(remote, local)
  assert.equal(merged.remote, 1)
  assert.equal(merged.local, 0)
  assert.equal(merged.rows.length, 1)
  assert.equal(merged.rows[0].name, 'Prajwal (live)')
})

test('mergeStudentRows never drops local rows that share an email with each other', () => {
  // The seeded store legitimately holds several attempts per email; they have
  // always been listed separately and must stay that way.
  const remote: ReturnType<typeof mk>[] = []
  const local = [
    mk('u_a', 'repeat@y.com', 'Repeat A', '40'),
    mk('u_b', 'repeat@y.com', 'Repeat B', '96'),
  ]
  const merged = mergeStudentRows(remote, local)
  assert.equal(merged.local, 2)
  assert.equal(merged.rows.length, 2)
})

test('mergeStudentRows tolerates blank ids/emails without merging unrelated rows', () => {
  const merged = mergeStudentRows([], [mk('', '', 'No Id'), mk('u_c', '', 'No Email')])
  assert.equal(merged.local, 2)
  assert.equal(merged.rows.length, 2)
})
