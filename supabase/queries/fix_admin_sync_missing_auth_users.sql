-- ============================================================================
-- Admin sync FK failures — diagnose + fix (run in the Supabase SQL Editor)
--
-- Symptom: "Write candidates into Supabase" fails with
--   insert or update on table "profiles" violates foreign key constraint
--   "profiles_id_fkey"
-- Cause: profiles.id references auth.users(id). The sync's deterministic UUIDs
--   exist only in the seed plan — no auth.users row was created with that id —
--   so every profiles / sessions / results / resumes upsert fails the FK check
--   and nothing shows in the Admin dashboard.
--
-- The 11 ids below are NOT guesses: they are what lib/supabaseSeed.ts derives
-- for the candidates in calibiai_db.json — seedUuid('profile', <email>):
--   node -e "import('./lib/supabaseSeed.ts').then(m=>console.log(m.seedUuid('profile','test3@test.com')))"
--
-- What this file fixes compared with the first draft of the fix:
--   1. auth.identities.id is `uuid` on current Supabase projects (it used to be
--      `text`), so `u.id::text` fails with
--        42804: column "id" is of type uuid but expression is of type text
--      STEP 4 inspects the column type and inserts the right one, so the script
--      works on both old and new projects.
--   2. provider_id must be unique PER USER. The draft set it to the literal
--      'email' for every row, which collides with identities' unique
--      (provider_id, provider) constraint on the second row. GoTrue itself
--      stores the user's UUID there for email identities, so that is used.
--   3. Passwords are hashed with gen_salt('bf') — bcrypt. crypt(pw,
--      gen_random_uuid()::text) produces a DES hash that GoTrue cannot verify,
--      so the accounts would exist but nobody could sign in with them.
--   4. confirmation_token / recovery_token / email_change_token_new are left
--      NULL, not ''. Those columns carry unique indexes; several '' rows can
--      collide, while NULLs never do.
--   5. No temp tables / session state: every step repeats the candidate list,
--      so the steps can be run in any order, one at a time or all together.
--
-- Order: STEP 1 (diagnose) → STEP 2 → STEP 3 → STEP 4 (verify) → re-run
-- "Write candidates into Supabase" in the Admin dashboard. STEP 5 only if
-- STEP 1 reported ID MISMATCH rows. Everything is idempotent.
-- ============================================================================


-- ============================================================================
-- STEP 1 — DIAGNOSE (read this before running the fix)
-- ============================================================================
with expected(id, email, full_name) as (
  values
    ('df972f0a-cc01-53d6-b489-32369ef9695b'::uuid, 'testuser@example.com',        'Test User'),
    ('859808e1-deb9-5a9d-bc3f-6aba2a409e05'::uuid, 'prajwal@gmail.com',           'Prajwal'),
    ('46288f57-0fa2-57a6-af1f-670d3f2c0701'::uuid, 'priya@iitm.ac.in',            'priya'),
    ('a36c171e-ac6a-42ff-a859-6f992a8c25a1'::uuid, 'prajwalen100@gmail.com',      'Prajwal Gulhane'),
    ('bfc9db91-165b-4a5a-91a7-1259d8a321dc'::uuid, 'prajwalgu90@gmail.com',       'Prajwal Gulhane'),
    ('ebb27f12-3e7c-43a5-b430-1d2cf92c8bc3'::uuid, 'thakareatharva61@gmail.com',  'atharvathakare'),
    ('230e1c01-43c9-5bb8-bd51-509453ff3e0e'::uuid, 'prajwalgulhane85@gmail.com',  'Prajwal Gulhane'),
    ('6c236d21-e771-43ff-a8a4-9115d454ac89'::uuid, 'prajwalgu16@gmail.com',       'Prajwal'),
    ('f40db342-cf5e-5e6d-b297-da47cf34fd47'::uuid, 'priya.newstudent@iitm.ac.in', 'Priya Sharma'),
    ('0ccd82d4-b76e-536c-85ff-fccb116261fc'::uuid, 'test3@test.com',              'test3'),
    ('e80bff16-bf67-5fd2-b102-c716cbc9aed2'::uuid, 'senofa8782@94an.com',         'Sanika')
)
select
  e.email,
  e.full_name,
  e.id                          as expected_id,
  case
    when u_id.id is not null    then 'OK — auth user exists with the expected id'
    when u_mail.id is not null  then 'ID MISMATCH — auth user exists under a different id (see actual_auth_user_id; run STEP 5)'
    else                             'MISSING — no auth user for this email (this is why the FK failed)'
  end                           as diagnosis,
  u_mail.id                     as actual_auth_user_id,
  u_mail.email_confirmed_at     as confirmed_at,
  (p.id is not null)            as profile_row_exists,
  (i.user_id is not null)       as email_identity_exists
from expected e
left join auth.users       u_id   on u_id.id  = e.id
left join auth.users       u_mail on lower(u_mail.email) = e.email
left join public.profiles  p      on p.id     = e.id
left join auth.identities  i      on i.user_id = e.id and i.provider = 'email'
order by diagnosis desc, e.email;

-- What actually landed in Supabase (what the dashboard sees):
select
  (select count(*) from auth.users)                         as auth_users,
  (select count(*) from public.profiles)                    as profile_rows,
  (select count(*) from public.profiles p
     join auth.users u on u.id = p.id)                      as profiles_linked_to_auth,
  (select count(*) from auth.identities)                    as auth_identities,
  (select count(*) from public.assessment_sessions)         as assessment_sessions,
  (select count(*) from public.assessment_results)          as assessment_results,
  (select count(*) from public.resume_analyses)             as resume_analyses,
  (select count(*) from public.feedback_submissions)        as feedback_submissions,
  (select count(*) from public.help_requests)               as help_requests;

-- Exact rows the Admin dashboard reads:
-- select * from public.student_profiles_full order by email;


-- ============================================================================
-- STEP 2 — create the MISSING auth users with the EXACT expected ids
-- Idempotent: only emails that are not already in auth.users. The
-- on_auth_user_created trigger then creates each profiles row.
-- Password: CalibiDemo@123 (the lib/supabaseSeed.ts default).
-- ============================================================================
with expected(id, email, full_name) as (
  values
    ('df972f0a-cc01-53d6-b489-32369ef9695b'::uuid, 'testuser@example.com',        'Test User'),
    ('859808e1-deb9-5a9d-bc3f-6aba2a409e05'::uuid, 'prajwal@gmail.com',           'Prajwal'),
    ('46288f57-0fa2-57a6-af1f-670d3f2c0701'::uuid, 'priya@iitm.ac.in',            'priya'),
    ('a36c171e-ac6a-42ff-a859-6f992a8c25a1'::uuid, 'prajwalen100@gmail.com',      'Prajwal Gulhane'),
    ('bfc9db91-165b-4a5a-91a7-1259d8a321dc'::uuid, 'prajwalgu90@gmail.com',       'Prajwal Gulhane'),
    ('ebb27f12-3e7c-43a5-b430-1d2cf92c8bc3'::uuid, 'thakareatharva61@gmail.com',  'atharvathakare'),
    ('230e1c01-43c9-5bb8-bd51-509453ff3e0e'::uuid, 'prajwalgulhane85@gmail.com',  'Prajwal Gulhane'),
    ('6c236d21-e771-43ff-a8a4-9115d454ac89'::uuid, 'prajwalgu16@gmail.com',       'Prajwal'),
    ('f40db342-cf5e-5e6d-b297-da47cf34fd47'::uuid, 'priya.newstudent@iitm.ac.in', 'Priya Sharma'),
    ('0ccd82d4-b76e-536c-85ff-fccb116261fc'::uuid, 'test3@test.com',              'test3'),
    ('e80bff16-bf67-5fd2-b102-c716cbc9aed2'::uuid, 'senofa8782@94an.com',         'Sanika')
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
  null,                                       -- instance_id is nullable
  m.id,
  'authenticated',
  'authenticated',
  lower(m.email),
  crypt('CalibiDemo@123', gen_salt('bf')),    -- bcrypt, so GoTrue can verify it
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', m.full_name, 'role', 'student', 'seeded', true),
  now(),
  now(),
  null, null, null, null                      -- NOT '': these columns have unique indexes
from missing m;


-- ============================================================================
-- STEP 3 — matching auth.identities rows (required to sign in with a password)
--
-- Adapts to the column type: current projects have `id uuid`, older ones have
-- `id text` — that mismatch is exactly the 42804 error. provider_id is the
-- user's UUID as text, which is unique per user (what GoTrue writes itself).
-- ============================================================================
do $$
declare
  id_type  text;
  inserted int := 0;
begin
  select format_type(a.atttypid, a.atttypmod)
    into id_type
    from pg_attribute a
   where a.attrelid = 'auth.identities'::regclass
     and a.attname  = 'id'
     and a.attnum   > 0;

  if id_type is null then
    raise notice 'auth.identities has no "id" column — skipping';
    return;
  end if;

  if id_type = 'uuid' then
    insert into auth.identities (id, user_id, provider_id, provider, identity_data,
                                 last_sign_in_at, created_at, updated_at)
    select u.id, u.id, u.id::text, 'email',
           jsonb_build_object('sub', u.id::text, 'email', u.email,
                              'email_verified', true, 'phone_verified', false),
           now(), now(), now()
      from auth.users u
      join (values
              ('testuser@example.com'), ('prajwal@gmail.com'), ('priya@iitm.ac.in'),
              ('prajwalen100@gmail.com'), ('prajwalgu90@gmail.com'), ('thakareatharva61@gmail.com'),
              ('prajwalgulhane85@gmail.com'), ('prajwalgu16@gmail.com'),
              ('priya.newstudent@iitm.ac.in'), ('test3@test.com'), ('senofa8782@94an.com')
           ) as e(email) on lower(e.email) = lower(u.email)
     where not exists (select 1 from auth.identities i
                        where i.user_id = u.id and i.provider = 'email')
       and not exists (select 1 from auth.identities i
                        where i.provider = 'email' and i.provider_id = u.id::text);
  else
    insert into auth.identities (id, user_id, provider_id, provider, identity_data,
                                 last_sign_in_at, created_at, updated_at)
    select u.id::text, u.id, u.id::text, 'email',
           jsonb_build_object('sub', u.id::text, 'email', u.email,
                              'email_verified', true, 'phone_verified', false),
           now(), now(), now()
      from auth.users u
      join (values
              ('testuser@example.com'), ('prajwal@gmail.com'), ('priya@iitm.ac.in'),
              ('prajwalen100@gmail.com'), ('prajwalgu90@gmail.com'), ('thakareatharva61@gmail.com'),
              ('prajwalgulhane85@gmail.com'), ('prajwalgu16@gmail.com'),
              ('priya.newstudent@iitm.ac.in'), ('test3@test.com'), ('senofa8782@94an.com')
           ) as e(email) on lower(e.email) = lower(u.email)
     where not exists (select 1 from auth.identities i
                        where i.user_id = u.id and i.provider = 'email')
       and not exists (select 1 from auth.identities i
                        where i.provider = 'email' and i.provider_id = u.id::text);
  end if;

  get diagnostics inserted = row_count;
  raise notice 'auth.identities.id is % — % row(s) inserted', id_type, inserted;
end $$;


-- ============================================================================
-- STEP 4 — VERIFY: every candidate must be true in every column
-- hash_kind must be $2a$ / $2b$ (bcrypt) or the account cannot sign in.
-- ============================================================================
with expected(id, email) as (
  values
    ('df972f0a-cc01-53d6-b489-32369ef9695b'::uuid, 'testuser@example.com'),
    ('859808e1-deb9-5a9d-bc3f-6aba2a409e05'::uuid, 'prajwal@gmail.com'),
    ('46288f57-0fa2-57a6-af1f-670d3f2c0701'::uuid, 'priya@iitm.ac.in'),
    ('a36c171e-ac6a-42ff-a859-6f992a8c25a1'::uuid, 'prajwalen100@gmail.com'),
    ('bfc9db91-165b-4a5a-91a7-1259d8a321dc'::uuid, 'prajwalgu90@gmail.com'),
    ('ebb27f12-3e7c-43a5-b430-1d2cf92c8bc3'::uuid, 'thakareatharva61@gmail.com'),
    ('230e1c01-43c9-5bb8-bd51-509453ff3e0e'::uuid, 'prajwalgulhane85@gmail.com'),
    ('6c236d21-e771-43ff-a8a4-9115d454ac89'::uuid, 'prajwalgu16@gmail.com'),
    ('f40db342-cf5e-5e6d-b297-da47cf34fd47'::uuid, 'priya.newstudent@iitm.ac.in'),
    ('0ccd82d4-b76e-536c-85ff-fccb116261fc'::uuid, 'test3@test.com'),
    ('e80bff16-bf67-5fd2-b102-c716cbc9aed2'::uuid, 'senofa8782@94an.com')
)
select
  e.email,
  e.id                                        as expected_id,
  (u.id is not null)                          as auth_user_with_expected_id,
  (i.user_id is not null)                     as can_sign_in_with_password,
  (p.id is not null)                          as profile_row_exists,
  left(u.encrypted_password, 4)               as hash_kind,
  (u.encrypted_password is not null
     and crypt('CalibiDemo@123', u.encrypted_password) = u.encrypted_password)
                                              as password_verifies
from expected e
left join auth.users      u on u.id = e.id
left join auth.identities i on i.user_id = e.id and i.provider = 'email'
left join public.profiles p on p.id = e.id
order by e.email;


-- ============================================================================
-- STEP 5 — (ONLY IF STEP 1 SHOWED "ID MISMATCH" ROWS) OPTIONAL CLEANUP
--
-- The email already exists under a RANDOM id from an earlier sign-up/sync, so
-- the deterministic id can never be inserted. These accounts own no data, so
-- the empty shell is deleted and STEP 2 + STEP 3 are re-run to insert it with
-- the right id. The `not exists` guards keep any account that already has data.
-- ============================================================================
-- begin;
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
--     from auth.users u
--     join expected e on lower(u.email) = e.email
--    where u.id <> e.id
--      and not exists (select 1 from public.profiles p            where p.id = u.id)
--      and not exists (select 1 from public.assessment_sessions s where s.student_id = u.id)
--      and not exists (select 1 from public.resume_analyses r     where r.student_id = u.id)
-- )
-- delete from auth.users where id in (select id from stale);
-- commit;
--
-- After STEP 2 + STEP 3 (+ STEP 5 if needed): re-run "Write candidates into
-- Supabase" in the Admin dashboard, then re-run STEP 1 — every row should say
-- "OK — auth user exists with the expected id".
