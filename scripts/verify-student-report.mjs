/**
 * Verifies supabase/queries/student_full_report.sql against a REAL PostgreSQL.
 *
 * There is no Postgres in CI, so this uses PGlite (Postgres 18 compiled to WASM):
 * it builds a database from the repo's own supabase/schema.sql + migrations,
 * seeds realistic students (scored, partially submitted, not started; feedback
 * matched by id AND by email-only; a help request; tracking events), then runs
 * the shipped query text verbatim and asserts the columns come back right.
 *
 *   npm i -D @electric-sql/pglite        # one-off, not in package.json
 *   node scripts/verify-student-report.mjs
 *
 * Exits non-zero if any check fails.
 */
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')

const db = await PGlite.create()

// --- Supabase platform stubs (auth schema + auth.uid()) -------------------
await db.exec(`
  create schema if not exists auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    email_confirmed_at timestamptz,
    last_sign_in_at timestamptz,
    created_at timestamptz default now()
  );
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;

  -- Supabase Storage stub (schema.sql seeds buckets + a storage.objects policy)
  create schema if not exists storage;
  create table storage.buckets (id text primary key, name text, public boolean default false);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text, name text, owner uuid
  );
  alter table storage.objects enable row level security;
  create or replace function storage.foldername(name text) returns text[]
    language sql immutable as $fn$ select string_to_array(name, '/') $fn$;
`)

// --- the real schema + every migration, in order --------------------------
// Fresh-project path (what the README documents for a new Supabase project):
// schema.sql already contains 0002/0003, then the two feedback/help migrations.
const files = [
  'supabase/schema.sql',
  'supabase/migrations/0004_feedback_submissions.sql',
  'supabase/migrations/0005_help_requests.sql',
  'supabase/migrations/0006_admin_attempted_and_stats.sql',
  // Twice on purpose: every migration must be idempotent (safe to re-run).
  'supabase/migrations/0006_admin_attempted_and_stats.sql',
]
for (const f of files) {
  // pgcrypto is preinstalled on Supabase; PGlite has no such extension file.
  const sql = read(f).replace(/create extension if not exists "pgcrypto";/gi, '')
  await db.exec(sql)
  console.log(`loaded ${f}`)
}

// --- seed: three students -------------------------------------------------
const scores = (over = {}) => ({
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
    traitLabels: { teamwork: 'Teamwork' },
  },
  detail: {
    listeningCorrect: 7, listeningTotal: 10, readingCorrect: 9, readingTotal: 10,
    problemCorrect: 6, problemTotal: 8, logicalCorrect: 5, logicalTotal: 7,
    debugPer: 66.7, promptPer: 82, featureScore100: 71, speakingCount: 3,
  },
  total: 760, grade: 'A', percentile: 84.2,
  verifiable_hash: 'sha256:demo-1234',
  ...over,
})

await db.exec(`
  insert into public.institutions (id, name, tenant_code)
  values ('00000000-0000-4000-8000-000000000001', 'PCCOE', 'pccoe');

  -- auth.users insert fires the on_auth_user_created trigger, which creates the
  -- profiles row (verified below); the rest of the profile is then filled in.
  insert into auth.users (id, email, email_confirmed_at, last_sign_in_at, raw_user_meta_data) values
    ('11111111-1111-4111-8111-111111111111', 'aarti@example.com', now() - interval '9 days', now() - interval '2 hours', '{"full_name":"Aarti Deshmukh","role":"student"}'::jsonb),
    ('22222222-2222-4222-8222-222222222222', 'rohan@example.com', now() - interval '5 days', now() - interval '1 day', '{"full_name":"Rohan Kulkarni","role":"student"}'::jsonb),
    ('33333333-3333-4333-8333-333333333333', 'newbie@example.com', null, null, '{"full_name":"Neha Patil","role":"student"}'::jsonb);

  update public.profiles set
    prn = 'PCCOE2021045', phone = '+91 98220 11111', dob = '2003-04-11', gender = 'female',
    degree = 'B.Tech CSE', college = 'PCCOE', institution_id = '00000000-0000-4000-8000-000000000001',
    graduation_year = 2026, cgpa = 8.7, skills = 'Python, React, SQL',
    linkedin_url = 'https://linkedin.com/in/aarti', github_url = 'https://github.com/aarti',
    created_at = now() - interval '9 days', updated_at = now() - interval '9 days'
  where id = '11111111-1111-4111-8111-111111111111';

  update public.profiles set
    prn = 'PCCOE2021077', phone = '+91 98220 22222', dob = '2002-11-02', gender = 'male',
    degree = 'B.Tech IT', college = 'PCCOE', institution_id = '00000000-0000-4000-8000-000000000001',
    graduation_year = 2026, cgpa = 7.9, skills = 'Java, Docker',
    created_at = now() - interval '5 days', updated_at = now() - interval '4 days'
  where id = '22222222-2222-4222-8222-222222222222';

  update public.profiles set
    skills = 'SQL', created_at = now() - interval '1 day', updated_at = now() - interval '1 day'
  where id = '33333333-3333-4333-8333-333333333333';

  insert into public.assessment_sessions
    (id, student_id, started_at, expires_at, duration_sec, status, tab_switches, answers, submitted_at, created_at)
  values
    ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111', now() - interval '8 days', now() - interval '8 days' + interval '120 minutes', 7200,'submitted',1,'{"EL1":"b","RD2":"a"}'::jsonb, now() - interval '8 days' + interval '94 minutes', now() - interval '8 days'),
    ('aaaaaaaa-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222', now() - interval '4 days', now() - interval '4 days' + interval '120 minutes', 7200,'submitted',0,'{}'::jsonb, now() - interval '4 days' + interval '118 minutes', now() - interval '4 days');

  insert into public.assessment_results
    (session_id, student_id, scores, total, grade, percentile, verifiable_hash, ai_feedback, report_storage_key, created_at)
  values
    ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111', $json1$${JSON.stringify(scores())}$json1$::jsonb, 760,'A',84.2,'sha256:demo-1234','{"writing":{"score":38,"notes":"Clear structure"}}'::jsonb,'reports/aarti.pdf', now() - interval '8 days'),
    ('aaaaaaaa-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222', $json2$${JSON.stringify(scores({ english: { listening: 30, speaking: 28, reading: 33, writing: 31, total: 122, max: 200 }, total: 610, grade: 'B', percentile: 55 }))}$json2$::jsonb, 610,'B',55.0,'sha256:demo-5678',null,null, now() - interval '4 days');

  -- A 4th student: session submitted, but no result row (partial submission).
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
    ('44444444-4444-4444-8444-444444444444','partial@example.com', now(), '{"full_name":"Sameer Joshi","role":"student"}'::jsonb);
  insert into public.assessment_sessions
    (id, student_id, started_at, expires_at, duration_sec, status, tab_switches, answers, submitted_at, created_at)
  values
    ('aaaaaaaa-0000-4000-8000-000000000003','44444444-4444-4444-8444-444444444444', now() - interval '2 days', now() - interval '2 days' + interval '120 minutes', 7200,'submitted',0,'{}'::jsonb, now() - interval '2 days' + interval '120 minutes', now() - interval '2 days');

  insert into public.resume_analyses (student_id, storage_key, resume_score, parsed, feedback, created_at)
  values
    ('11111111-1111-4111-8111-111111111111','resumes/aarti.pdf',82,'{"name":"Aarti Deshmukh","experience_years":1,"projects":4,"skills":["Python","React","SQL"],"engine":"mammoth","name_match":true,"word_count":512,"file_name":"Aarti_Resume.pdf","summary":"Final-year CSE student"}'::jsonb,'{"strengths":["Quantified impact"]}'::jsonb, now() - interval '9 days'),
    ('22222222-2222-4222-8222-222222222222','resumes/rohan.pdf',64,'{"name":"Rohan Kulkarni","experience_years":0,"projects":2,"skills":["Java","Docker"],"engine":"mammoth","name_match":false,"word_count":310,"file_name":"resume.pdf"}'::jsonb,'{}'::jsonb, now() - interval '5 days');

  -- Aarti: feedback matched by student_id. Rohan: matched by EMAIL only,
  -- because the seeded/demo rows carry a non-UUID student_ref.
  insert into public.feedback_submissions (student_id, student_ref, email, session_id, rating, message, source, created_at)
  values
    ('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','aarti@example.com','aaaaaaaa-0000-4000-8000-000000000001',5,'Good assessment, up to the mark.','web', now() - interval '8 days'),
    ('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','aarti@example.com','aaaaaaaa-0000-4000-8000-000000000001',4,'Second submission to prove the count.','web', now() - interval '7 days'),
    (null,'u_84368932','rohan@example.com','sess_demo',2,'Could be better — clearer questions please.','web', now() - interval '4 days');

  insert into public.help_requests (student_id, student_ref, email, phone, message, page, source, created_at)
  values
    ('22222222-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222222','rohan@example.com','+91 98220 22222','The speaking section would not record my answer.','/assessment','web', now() - interval '4 days');

  insert into public.tracking_events (id, user_id, action, completed, completed_at, created_at)
  values
    ('evt-1','11111111-1111-4111-8111-111111111111','join_whatsapp',true, now() - interval '8 days', now() - interval '8 days'),
    ('evt-2','11111111-1111-4111-8111-111111111111','follow_linkedin',true, now() - interval '8 days', now() - interval '8 days'),
    ('evt-3','22222222-2222-4222-8222-222222222222','join_whatsapp',true, now() - interval '4 days', now() - interval '4 days');
`)
const triggerCheck = await db.query('select count(*)::int as n from public.profiles')
console.log(`auth trigger auto-created ${triggerCheck.rows[0].n} profiles (expected 4)`)
console.log('seeded 4 students (2 scored, 1 session-without-result, 1 not started)')

// --- extract the shipped QUERY 1 verbatim and run it ----------------------
const file = read('supabase/queries/student_full_report.sql')
const start = file.indexOf('-- QUERY 1 — one row per student')
const end = file.indexOf('-- QUERY 2 —')
const query1 = file
  .slice(file.indexOf('select', start), end)
  .replace(/;\s*$/, '')
  .trim()
if (!query1.startsWith('select') || end < 0) throw new Error('could not extract QUERY 1 (end=' + end + ')')

const res = await db.query(query1)
console.log(`\nQUERY 1 ran: ${res.rows.length} rows, ${res.fields.length} columns\n`)

const pick = ['name','email','prn','college','has_assessment','calibiai_score','grade','percentile',
  'english_total','english_listening','problem_solving','ai_debugging','prompt_engineering',
  'cognitive_total','teamwork','listening_correct','listening_total','resume_score',
  'feedback_rating','feedback_submissions','help_requests','joined_whatsapp','followed_linkedin']
console.table(res.rows.map(r => Object.fromEntries(pick.map(k => [k, r[k]]))))

console.log('\nfull column list:')
console.log(res.fields.map(f => f.name).join(', '))

const aarti = res.rows.find(r => r.email === 'aarti@example.com')
const rohan = res.rows.find(r => r.email === 'rohan@example.com')
const neha = res.rows.find(r => r.email === 'newbie@example.com')

const checks = [
  ['Aarti: score + every module expanded', Number(aarti.calibiai_score) === 760 && Number(aarti.english_listening) === 42 && Number(aarti.teamwork) === 20 && Number(aarti.debugging_percent) === 66.7],
  ['Aarti: feedback matched by student_id, count = 2', Number(aarti.feedback_rating) === 4 && Number(aarti.feedback_submissions) === 2],
  ['Rohan: feedback matched by EMAIL only (student_id null)', Number(rohan.feedback_rating) === 2 && rohan.feedback_message.startsWith('Could be better')],
  ['Rohan: help request attached', Number(rohan.help_requests) === 1 && rohan.latest_help_message.includes('speaking section')],
  ['Rohan: latest result wins (610, grade B)', Number(rohan.calibiai_score) === 610 && rohan.grade === 'B'],
  ['Neha: appears with no assessment, NULL scores', neha.has_assessment === 'No' && neha.calibiai_score === null && neha.english_total === null],
  ['Ordered by score desc, NULLs last', res.rows.map(r => r.email).join(',') === 'aarti@example.com,rohan@example.com,partial@example.com,newbie@example.com'],
  ['Sameer: session without a result is flagged, scores NULL', (() => { const s = res.rows.find(r => r.email === 'partial@example.com'); return s.has_assessment === 'Attempted (no result saved)' && s.session_id !== null && s.calibiai_score === null })()],
  ['Tracking flags', aarti.joined_whatsapp === true && aarti.followed_linkedin === true && rohan.followed_linkedin === false],
]
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}

// --- QUERY 3 (the existing view) -----------------------------------------
const viewRes = await db.query('select * from public.student_profiles_full order by assessment_created_at desc nulls last')
console.log(`\nQUERY 3 (student_profiles_full): ${viewRes.rows.length} rows`)
console.log('view columns:', viewRes.fields.map(f => f.name).join(', '))
checks.push(['0006: assessment_attempted on the view (scored→true, attempted→true, fresh→false)',
  viewRes.rows.find(r => r.email === 'aarti@example.com').assessment_attempted === true &&
  viewRes.rows.find(r => r.email === 'partial@example.com').assessment_attempted === true &&
  viewRes.rows.find(r => r.email === 'newbie@example.com').assessment_attempted === false])

// --- 0006: admin_stats single-row aggregates ------------------------------
const stats = await db.query('select * from public.admin_stats')
console.log('\nadmin_stats:')
console.table(stats.rows)
checks.push(['0006: admin_stats aggregates (total 4, assessed 3, scored 2, avg 685, colleges [PCCOE])',
  stats.rows.length === 1 &&
  Number(stats.rows[0].total_students) === 4 &&
  Number(stats.rows[0].assessed_students) === 3 &&
  Number(stats.rows[0].scored_students) === 2 &&
  Number(stats.rows[0].avg_score) === 685 &&
  JSON.stringify([...stats.rows[0].colleges].sort()) === JSON.stringify(['PCCOE'])])

// --- QUERY 5 aggregate block ---------------------------------------------
const agg = await db.query(`
  select p.college, count(*) as students_assessed, round(avg(r.total),1) as avg_score,
         min(r.total) as lowest, max(r.total) as highest, round(avg(f.rating),2) as avg_feedback_rating
  from public.assessment_results r
  join public.profiles p on p.id = r.student_id
  left join lateral (
    select f.rating from public.feedback_submissions f
    where f.student_id = p.id or lower(f.email) = lower(p.email)
    order by f.created_at desc limit 1
  ) f on true
  group by p.college order by avg_score desc nulls last`)
console.log('\nQUERY 5 (college aggregates):')
console.table(agg.rows)

// --- QUERY 5: raw JSONB blocks, extracted verbatim from the file ----------
const q5 = file.slice(file.indexOf('-- QUERY 5 —'))
const answersSql = q5
  .slice(q5.indexOf('select s.id as session_id'), q5.indexOf('-- Score distribution'))
  .split('\n').map(l => l.replace(/^-- ?/, '')).join('\n')
  .replace(/lower\('student@example\.com'\)/, "lower('aarti@example.com')")
  .replace(/;\s*$/, '')
const answers = await db.query(answersSql)
console.log('\nQUERY 5 (answers of one session):')
console.table(answers.rows)
checks.push(['QUERY 5: answers expanded one row per question', answers.rows.length === 2 && answers.rows.every(r => r.session_id && r.question_id && r.answer)])

const scoresSql = q5
  .slice(q5.indexOf('select p.full_name'), q5.indexOf('-- Every submitted answer'))
  .split('\n').map(l => l.replace(/^-- ?/, '')).join('\n')
  .replace(/;\s*$/, '')
const rawScores = await db.query(scoresSql)
console.log('QUERY 5 (raw scores JSON):', rawScores.rows.length, 'rows; sample keys:', Object.keys(rawScores.rows[0].full_scores_json).join(','))
checks.push(['QUERY 5: raw scores JSONB returned', rawScores.rows.length === 2 && !!rawScores.rows[0].full_scores_json.english])

// --- QUERY 4: install QUERY 1 as a view, then read it back ----------------
await db.exec(`create view public.student_reports_full with (security_invoker = on) as ${query1}`)
const viewBack = await db.query('select name, calibiai_score, feedback_rating, help_requests from public.student_reports_full order by calibiai_score desc nulls last')
console.log('\nQUERY 4 (installed as a view):')
console.table(viewBack.rows)

for (const [name, ok] of checks.slice(9)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
