-- ============================================================================
-- Admin sync FK failures — diagnose + fix (run in the Supabase SQL Editor)
--
-- Error: insert or update on table "profiles" violates foreign key
--        constraint "profiles_id_fkey"
-- Cause: profiles.id references auth.users(id). The sync's deterministic
--        UUIDs exist only in the seed plan — no auth.users row was created
--        with that id, so every profiles / sessions / results / resumes
--        upsert fails the FK check and nothing shows in the Admin dashboard.
-- ============================================================================


-- ============================================================================
-- QUERY 1 — DIAGNOSE (run this first)
-- For every candidate the sync expects: does the auth user exist with the
-- expected id? Does it exist under a DIFFERENT id? Does a profile row exist?
-- ============================================================================
with expected(id, email, full_name) as (
  values
    ('df972f0a-cc01-53d6-b489-32369ef9695b'::uuid, 'testuser@example.com',       'Test User'),
    ('859808e1-deb9-5a9d-bc3f-6aba2a409e05'::uuid, 'prajwal@gmail.com',          'Prajwal'),
    ('46288f57-0fa2-57a6-af1f-670d3f2c0701'::uuid, 'priya@iitm.ac.in',           'priya'),
    ('a36c171e-ac6a-42ff-a859-6f992a8c25a1'::uuid, 'prajwalen100@gmail.com',     'Prajwal Gulhane'),
    ('bfc9db91-165b-4a5a-91a7-1259d8a321dc'::uuid, 'prajwalgu90@gmail.com',      'Prajwal Gulhane'),
    ('ebb27f12-3e7c-43a5-b430-1d2cf92c8bc3'::uuid, 'thakareatharva61@gmail.com', 'atharvathakare'),
    ('230e1c01-43c9-5bb8-bd51-509453ff3e0e'::uuid, 'prajwalgulhane85@gmail.com', 'Prajwal Gulhane'),
    ('6c236d21-e771-43ff-a8a4-9115d454ac89'::uuid, 'prajwalgu16@gmail.com',      'Prajwal'),
    ('f40db342-cf5e-5e6d-b297-da47cf34fd47'::uuid, 'priya.newstudent@iitm.ac.in','Priya Sharma'),
    ('0ccd82d4-b76e-536c-85ff-fccb116261fc'::uuid, 'test3@test.com',             'test3'),
    ('e80bff16-bf67-5fd2-b102-c716cbc9aed2'::uuid, 'senofa8782@94an.com',        'Sanika')
)
select
  e.email,
  e.full_name,
  e.id                          as expected_id,
  case
    when u_id.id is not null    then 'OK — auth user exists with expected id'
    when u_mail.id is not null  then 'ID MISMATCH — auth user exists under a different id (see actual_auth_user_id)'
    else                             'MISSING — no auth user for this email (this is why the FK failed)'
  end                           as diagnosis,
  u_mail.id                     as actual_auth_user_id,
  u_mail.email_confirmed_at     as auth_created_confirmed_at,
  u_mail.created_at             as auth_created_at,
  (p.id is not null)            as profile_row_exists
from expected e
left join auth.users      u_id   on u_id.id  = e.id
left join auth.users      u_mail on lower(u_mail.email) = e.email
left join public.profiles p      on p.id     = e.id
order by diagnosis desc, e.email;


-- ============================================================================
-- QUERY 2 — OVERVIEW: what actually landed in Supabase (what the dashboard sees)
-- ============================================================================
select
  (select count(*) from auth.users)                                     as auth_users,
  (select count(*) from public.profiles)                                as profile_rows,
  (select count(*) from public.profiles p
     join auth.users u on u.id = p.id)                                  as profiles_linked_to_auth,
  (select count(*) from public.assessment_sessions)                     as assessment_sessions,
  (select count(*) from public.assessment_results)                      as assessment_results,
  (select count(*) from public.resume_analyses)                         as resume_analyses,
  (select count(*) from public.feedback_submissions)                    as feedback_submissions,
  (select count(*) from public.help_requests)                           as help_requests;

-- Exact rows the Admin dashboard reads (profile + latest result + resume):
-- select * from public.student_profiles_full order by email;


-- ============================================================================
-- QUERY 3 — FIX: create the MISSING auth users with the EXACT expected ids
--
-- Idempotent + safe: inserts only emails that do not already exist in
-- auth.users, and always uses the deterministic id from the seed plan, so the
-- next "Write candidates into Supabase" run passes the FK and upserts
-- profiles + sessions + results + resumes.
--
-- The on_auth_user_created trigger fires and auto-creates the profile row.
-- Seeded password (matches lib/supabaseSeed.ts default): CalibiDemo@123
-- ============================================================================
with expected(id, email, full_name) as (
  values
    ('df972f0a-cc01-53d6-b489-32369ef9695b'::uuid, 'testuser@example.com',       'Test User'),
    ('859808e1-deb9-5a9d-bc3f-6aba2a409e05'::uuid, 'prajwal@gmail.com',          'Prajwal'),
    ('46288f57-0fa2-57a6-af1f-670d3f2c0701'::uuid, 'priya@iitm.ac.in',           'priya'),
    ('a36c171e-ac6a-42ff-a859-6f992a8c25a1'::uuid, 'prajwalen100@gmail.com',     'Prajwal Gulhane'),
    ('bfc9db91-165b-4a5a-91a7-1259d8a321dc'::uuid, 'prajwalgu90@gmail.com',      'Prajwal Gulhane'),
    ('ebb27f12-3e7c-43a5-b430-1d2cf92c8bc3'::uuid, 'thakareatharva61@gmail.com', 'atharvathakare'),
    ('230e1c01-43c9-5bb8-bd51-509453ff3e0e'::uuid, 'prajwalgulhane85@gmail.com', 'Prajwal Gulhane'),
    ('6c236d21-e771-43ff-a8a4-9115d454ac89'::uuid, 'prajwalgu16@gmail.com',      'Prajwal'),
    ('f40db342-cf5e-5e6d-b297-da47cf34fd47'::uuid, 'priya.newstudent@iitm.ac.in','Priya Sharma'),
    ('0ccd82d4-b76e-536c-85ff-fccb116261fc'::uuid, 'test3@test.com',             'test3'),
    ('e80bff16-bf67-5fd2-b102-c716cbc9aed2'::uuid, 'senofa8782@94an.com',        'Sanika')
),
missing as (
  select e.*
  from expected e
  where not exists (select 1 from auth.users u where lower(u.email) = e.email)
)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000',
  m.id,
  'authenticated',
  'authenticated',
  m.email,
  crypt('CalibiDemo@123', gen_random_uuid()::text),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', m.full_name, 'role', 'student', 'seeded', true),
  now(),
  now(),
  '', '', '', ''
from missing m;

-- Matching auth identity rows (required for the accounts to be sign-in-able):
insert into auth.identities (
  id, user_id, provider_id, provider, identity_data,
  last_sign_in_at, created_at, updated_at
)
select
  u.id::text, u.id, 'email', 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  now(), now(), now()
from auth.users u
where lower(u.email) in (
  'testuser@example.com','prajwal@gmail.com','priya@iitm.ac.in',
  'prajwalen100@gmail.com','prajwalgu90@gmail.com','thakareatharva61@gmail.com',
  'prajwalgulhane85@gmail.com','prajwalgu16@gmail.com','priya.newstudent@iitm.ac.in',
  'test3@test.com','senofa8782@94an.com'
)
and not exists (
  select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
);


-- ============================================================================
-- QUERY 4 — (ONLY IF QUERY 1 SHOWED "ID MISMATCH" ROWS) OPTIONAL CLEANUP
--
-- The email already exists in auth.users under a RANDOM id (from an earlier
-- sync/sign-up), so the seed id can never be inserted. These seeded accounts
-- own no real data, so delete the empty shell; then re-run Query 3 to insert
-- them with the correct id. Skips any account that already has data.
-- ============================================================================
-- with expected(id, email) as (
--   values
--     ('df972f0a-cc01-53d6-b489-32369ef9695b'::uuid, 'testuser@example.com'),
--     ('859808e1-deb9-5a9d-bc3f-6aba2a409e05'::uuid, 'prajwal@gmail.com'),
--     ('46288f57-0fa2-57a6-af1f-670d3f2c0701'::uuid, 'priya@iitm.ac.in'),
--     ('a36c171e-ac6a-42ff-a859-6f992a8c25a1'::uuid, 'prajwalen100@gmail.com'),
--     ('bfc9db91-165b-4a5a-91a7-1259d8a321dc'::uuid, 'prajwalgu90@gmail.com'),
--     ('ebb27f12-3e7c-43a5-b430-1d2cf92c8bc3'::uuid, 'thakareatharva61@gmail.com'),
--     ('230e1c01-43c9-5bb8-bd51-509453ff3e0e'::uuid, 'prajwalgulhane85@gmail.com'),
--     ('6c236d21-e771-43ff-a8a4-9115d454ac89'::uuid, 'prajwalgu16@gmail.com'),
--     ('f40db342-cf5e-5e6d-b297-da47cf34fd47'::uuid, 'priya.newstudent@iitm.ac.in'),
--     ('0ccd82d4-b76e-536c-85ff-fccb116261fc'::uuid, 'test3@test.com'),
--     ('e80bff16-bf67-5fd2-b102-c716cbc9aed2'::uuid, 'senofa8782@94an.com')
-- ),
-- stale as (
--   select u.id
--   from auth.users u
--   join expected e on lower(u.email) = e.email
--   where u.id <> e.id
--     and not exists (select 1 from public.profiles p where p.id = u.id)
-- )
-- delete from auth.users where id in (select id from stale);
--
-- After Query 3 + (optional) 4: re-run "Write candidates into Supabase" in the
-- Admin dashboard, then re-run Query 1 — every row should say
-- "OK — auth user exists with expected id".
