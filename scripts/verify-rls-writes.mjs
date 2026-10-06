/**
 * Proves the profile-sync bug — and its fix — against REAL PostgreSQL RLS.
 *
 * Symptom this reproduces: a student signs up, fills in onboarding, sees
 * "Saved", and nothing but name + email ever appears in Supabase.
 *
 * Cause: `profiles` is protected by `auth.uid() = id`. The server client built
 * from the anon key has no session, so `auth.uid()` is NULL and Postgres
 * rejects the upsert with 42501. Only a service-role key or a request carrying
 * the student's own access token can write the row.
 *
 * There is no Postgres in CI, so this uses PGlite (Postgres compiled to WASM)
 * built from the repo's own supabase/schema.sql, with the same auth.uid() stub
 * scripts/verify-student-report.mjs uses, and runs the very statements
 * lib/persist.ts sends.
 *
 *   npm run verify:rls
 *
 * Exits non-zero if any check fails.
 */
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')

let failures = 0
function check(name, condition, extra = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const db = await PGlite.create()

// --- Supabase platform stubs (auth schema + auth.uid()) -------------------
await db.exec(`
  create schema if not exists auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    email_confirmed_at timestamptz,
    created_at timestamptz default now()
  );
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
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

// The shipped schema (pgcrypto is preinstalled on Supabase; PGlite has no such file).
await db.exec(read('supabase/schema.sql').replace(/create extension if not exists "pgcrypto";/gi, ''))

// Supabase grants the API roles the tables; RLS then decides row by row.
await db.exec(`
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
`)

const UID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

console.log('\n1. sign-up')
await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values
  ('${UID}', 'aarti@example.com', '{"full_name":"Aarti Deshmukh","role":"student"}'::jsonb),
  ('${OTHER}', 'rohan@example.com', '{"full_name":"Rohan Kulkarni","role":"student"}'::jsonb);`)
const seeded = (await db.query('select id, email, full_name, phone, college, gender from public.profiles order by email')).rows
check('on_auth_user_created seeds a profiles row', seeded.length === 2)
check('…with name + email only', seeded.every((r) => r.phone === null && r.college === null), JSON.stringify(seeded[0]))

// The upsert lib/persist.ts persistProfileDetailed() sends.
const onboardingUpsert = (id) => `
  insert into public.profiles as p (id, email, full_name, phone, gender, degree, college, graduation_year, cgpa, updated_at)
  values ('${id}', 'aarti@example.com', 'Aarti Deshmukh', '9822011111', 'female', 'B.Tech CSE', 'PCCOE', 2026, 8.70, now())
  on conflict (id) do update set
    email = excluded.email, full_name = excluded.full_name, phone = excluded.phone,
    gender = excluded.gender, degree = excluded.degree, college = excluded.college,
    graduation_year = excluded.graduation_year, cgpa = excluded.cgpa, updated_at = excluded.updated_at;`

/** Run a statement as a Supabase role, with or without a JWT subject. */
async function as(role, sub, statement) {
  await db.exec(`set role ${role};`)
  await db.exec(sub ? `set request.jwt.claim.sub = '${sub}';` : `select set_config('request.jwt.claim.sub', '', false);`)
  try {
    await db.exec(statement)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: String(e.message).split('\n')[0] }
  } finally {
    await db.exec('set role none;')
  }
}

/** Same, but returns the rows a SELECT can see under that role's RLS view. */
async function asQuery(role, sub, statement) {
  await db.exec(`set role ${role};`)
  await db.exec(sub ? `set request.jwt.claim.sub = '${sub}';` : `select set_config('request.jwt.claim.sub', '', false);`)
  try {
    return (await db.query(statement)).rows
  } catch (e) {
    return [{ error: String(e.message).split('\n')[0] }]
  } finally {
    await db.exec('set role none;')
  }
}

const rowOf = async (id) =>
  (await db.query(`select email, full_name, phone, gender, degree, college, graduation_year, cgpa
                   from public.profiles where id = '${id}'`)).rows[0]

console.log('\n2. the bug — server client from the anon key, no session')
const anonWrite = await as('anon', null, onboardingUpsert(UID))
check('anon write is rejected by RLS (42501)', !anonWrite.ok && /row-level security/.test(anonWrite.message), anonWrite.message)
const afterAnon = await rowOf(UID)
check('…so Postgres still has no phone/college/gender', afterAnon.phone === null && afterAnon.college === null,
  JSON.stringify(afterAnon))
const anonVisible = await asQuery('anon', null, `select id from public.profiles where id = '${UID}'`)
check('…and an anon read of the profile returns nothing (why has_onboarding was always false)',
  anonVisible.length === 0, JSON.stringify(anonVisible))
const userVisible = await asQuery('authenticated', UID, `select id, full_name from public.profiles where id = '${UID}'`)
check('…while the student\'s own token can read it', userVisible.length === 1 && userVisible[0].full_name === 'Aarti Deshmukh',
  JSON.stringify(userVisible))

console.log('\n3. the fix — the same write carrying the student\'s own access token')
const userWrite = await as('authenticated', UID, onboardingUpsert(UID))
check('authenticated write succeeds', userWrite.ok, userWrite.message)
const afterUser = await rowOf(UID)
check('…phone landed', afterUser.phone === '9822011111', JSON.stringify(afterUser))
check('…college landed', afterUser.college === 'PCCOE')
check('…gender/degree/cgpa landed', afterUser.gender === 'female' && afterUser.degree === 'B.Tech CSE' && Number(afterUser.cgpa) === 8.7)

console.log('\n4. the fix does not weaken isolation')
const crossWrite = await as('authenticated', OTHER, onboardingUpsert(UID))
check('another student cannot overwrite this row', !crossWrite.ok && /row-level security/.test(crossWrite.message),
  crossWrite.message)
const untouched = await rowOf(UID)
check('…the row is unchanged', untouched.phone === '9822011111' && untouched.college === 'PCCOE')

console.log('\n5. service-role key (the other supported configuration)')
const serviceWrite = await as('service_role', null, onboardingUpsert(OTHER))
check('service_role bypasses RLS', serviceWrite.ok, serviceWrite.message)
check('…and wrote the other student', (await rowOf(OTHER)).college === 'PCCOE')

console.log('\n6. tracking events + resume analyses behave the same way')
const trackAnon = await as('anon', null,
  `insert into public.tracking_events (id, user_id, action, completed) values ('track_1','${UID}','join_whatsapp',true)
   on conflict (id) do update set completed = excluded.completed;`)
check('tracking write is rejected without the JWT', !trackAnon.ok && /row-level security/.test(trackAnon.message),
  trackAnon.message)
const trackUser = await as('authenticated', UID,
  `insert into public.tracking_events (id, user_id, action, completed) values ('track_1','${UID}','join_whatsapp',true)
   on conflict (id) do update set completed = excluded.completed;`)
check('tracking write lands with the JWT', trackUser.ok, trackUser.message)
const resumeUser = await as('authenticated', UID,
  `insert into public.resume_analyses (student_id, resume_score, parsed, feedback)
   values ('${UID}', 82, '{"skills":["Python"]}'::jsonb, '{"strengths":["impact"]}'::jsonb);`)
check('resume write lands with the JWT', resumeUser.ok, resumeUser.message)

console.log('\n7. an assessment session needs the profile row to exist first')
const orphanSession = await as('authenticated', UID,
  `insert into public.assessment_sessions (id, student_id) values ('aaaaaaaa-0000-4000-8000-000000000009','99999999-9999-4999-8999-999999999999');`)
check('a session for an unknown student is refused (FK)', !orphanSession.ok, orphanSession.message)
const ownSession = await as('authenticated', UID,
  `insert into public.assessment_sessions (id, student_id) values ('aaaaaaaa-0000-4000-8000-000000000001','${UID}');`)
check('a session for the signed-in student is accepted', ownSession.ok, ownSession.message)

console.log('')
if (failures) {
  console.log(`✗ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✓ all RLS write checks passed')
