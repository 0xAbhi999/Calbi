-- ============================================================================
-- Calibiai Score — Supabase schema
-- Run in Supabase SQL editor (or `supabase db push`).
-- Each student gets a separate assessment session; every attempt is isolated
-- by student_id + RLS. Auth uses Supabase Auth (supabase-js signInWithPassword).
-- ============================================================================

-- Extension for unique-safe updates
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Institutions (tenant) + profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table if not exists public.institutions (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  tenant_code   text unique not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  email            text not null,
  role             text not null default 'student' check (role in ('student','faculty','institution')),
  full_name        text,
  prn              text,                      -- college PRN / registration number (optional)
  phone            text,
  dob              date,
  gender           text,
  degree           text,
  college          text,
  institution_id   uuid references public.institutions(id),
  graduation_year  int,
  cgpa             numeric(4,2),
  skills           text,
  linkedin_url     text,
  github_url       text,
  ai_avatar        jsonb,                 -- generated AI avatar config {seed, style, version, generated_at}
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Index for fast login lookup by email (used by /api/auth/login)
create index if not exists profiles_email_idx on public.profiles (email);

-- One student per PRN (partial index: blank/absent PRNs never collide, the
-- field is optional). Colleges match CalibiAI records to their own register by
-- PRN, so a duplicate would silently merge two different students.
create unique index if not exists profiles_prn_unique_idx
  on public.profiles (prn)
  where prn is not null and btrim(prn) <> '';

-- Auto-create a profile row when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name',
          coalesce(new.raw_user_meta_data->>'role','student'))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Resume analyses (parsed score/feedback from AI worker)
-- ---------------------------------------------------------------------------
create table if not exists public.resume_analyses (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles(id) on delete cascade,
  storage_key   text,                       -- minio/storage path to uploaded PDF
  resume_score  int,
  parsed        jsonb,
  feedback      jsonb,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Tracking events (WhatsApp community / LinkedIn follow steps)
-- ---------------------------------------------------------------------------
create table if not exists public.tracking_events (
  id            text primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  action        text not null,
  completed     boolean not null default false,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists tracking_events_user_idx on public.tracking_events (user_id);
create index if not exists resume_analyses_student_idx on public.resume_analyses (student_id);

-- ---------------------------------------------------------------------------
-- Assessment sessions — one per attempt, per student
-- ---------------------------------------------------------------------------
create table if not exists public.assessment_sessions (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references public.profiles(id) on delete cascade,
  started_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '120 minutes',
  duration_sec    int not null default 7200,
  status          text not null default 'in_progress'
                  check (status in ('in_progress','submitted','expired')),
  question_seed   bigint not null default (extract(epoch from now()) * 1000)::bigint, -- per-session option shuffle seed
  tab_switches    int not null default 0,
  answers         jsonb not null default '{}'::jsonb,
  submitted_at    timestamptz,
  created_at      timestamptz not null default now()
);
-- A student only ever has one active session at a time
create unique index if not exists one_active_session_per_student
  on public.assessment_sessions (student_id)
  where status = 'in_progress';

-- ---------------------------------------------------------------------------
-- Final evaluation results (scores)
-- ---------------------------------------------------------------------------
create table if not exists public.assessment_results (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null unique references public.assessment_sessions(id) on delete cascade,
  student_id          uuid not null references public.profiles(id) on delete cascade,
  scores              jsonb not null,      -- full section breakdown + behavioral profile
  total               int not null,
  grade               text,
  percentile         numeric,
  verifiable_hash     text,
  ai_feedback         jsonb,               -- CalibiAI feedback per subjective section
  report_storage_key  text,                -- PDF report path
  created_at          timestamptz not null default now()
);

create index if not exists profiles_role_college_idx on public.profiles (role, college);
create index if not exists assessment_results_student_created_idx
  on public.assessment_results (student_id, created_at desc);
create index if not exists assessment_sessions_student_created_idx
  on public.assessment_sessions (student_id, created_at desc);
create index if not exists assessment_sessions_status_student_idx
  on public.assessment_sessions (status, student_id, created_at desc);

-- ---------------------------------------------------------------------------
-- AI evaluation jobs (CalibiAI) — for speaking/writing/code/prompts
-- ---------------------------------------------------------------------------
create table if not exists public.ai_evaluation_jobs (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.assessment_sessions(id) on delete cascade,
  section       text not null check (section in ('speaking','writing','debugging','feature','prompt')),
  ref_id        text,                       -- question/task id
  payload       jsonb not null,            -- transcript / code / prompt text
  status        text not null default 'pending' check (status in ('pending','done','error')),
  result        jsonb,                      -- {score, rubric:{...}, feedback}
  model         text default 'deepseek-chat',
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.profiles           enable row level security;
alter table public.resume_analyses    enable row level security;
alter table public.tracking_events    enable row level security;
alter table public.assessment_sessions enable row level security;
alter table public.assessment_results enable row level security;
alter table public.ai_evaluation_jobs enable row level security;

-- Profiles: a user reads/updates their own row (the sign-up trigger inserts it);
-- the insert policy also covers re-creates and server-side onboarding upserts
-- made with the user's own access token.
--
-- PostgreSQL has no `create policy if not exists`, so remove only the policies
-- owned by this schema before creating them. This keeps the script safe to run
-- again in the Supabase SQL editor after a partial or previous setup.
drop policy if exists "own profile read" on public.profiles;
drop policy if exists "own profile insert" on public.profiles;
drop policy if exists "own profile update" on public.profiles;

create policy "own profile read"   on public.profiles for select using (auth.uid() = id);
create policy "own profile insert" on public.profiles for insert with check (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id);

-- Students own their rows
drop policy if exists "own resumes" on public.resume_analyses;
drop policy if exists "own tracking" on public.tracking_events;
drop policy if exists "own sessions" on public.assessment_sessions;
drop policy if exists "own results" on public.assessment_results;
drop policy if exists "own ai jobs" on public.ai_evaluation_jobs;

create policy "own resumes"   on public.resume_analyses    for all using (auth.uid() = student_id);
create policy "own tracking"  on public.tracking_events    for all using (auth.uid() = user_id);
create policy "own sessions"  on public.assessment_sessions for all using (auth.uid() = student_id);
create policy "own results"   on public.assessment_results  for all using (auth.uid() = student_id);
create policy "own ai jobs"   on public.ai_evaluation_jobs  for all using (
  exists (select 1 from public.assessment_sessions s
          where s.id = session_id and s.student_id = auth.uid())
);

-- Faculty/institution dashboards: read within the same institution
drop policy if exists "tenant results read" on public.assessment_results;
create policy "tenant results read" on public.assessment_results for select using (
  exists (select 1 from public.profiles p
          where p.id = assessment_results.student_id
            and p.institution_id = (select institution_id from public.profiles where id = auth.uid()))
);

-- ============================================================================
-- Storage buckets (resumes, speaking audio, PDF reports)
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('resumes','resumes', false),
       ('speaking','speaking', false),
       ('reports','reports', false)
on conflict (id) do nothing;

-- Users can upload/read only files whose path starts with their uid: "{uid}/..."
-- Keep this schema rerunnable as well; `create policy` itself has no
-- `if not exists` form.
drop policy if exists "own files" on storage.objects;
create policy "own files" on storage.objects for all using (
  bucket_id in ('resumes','speaking','reports')
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================================
-- Download view — one row per student: profile + latest resume analysis +
-- latest assessment result. Export from the Supabase table editor
-- (CSV / Excel / JSON) to download all data in one click.
-- (Also provided as standalone migrations: 0002_profile_avatar_and_full_view.sql,
--  0003_profile_prn.sql, and 0006_admin_attempted_and_stats.sql which adds
--  assessment_attempted plus the admin_stats view below.)
-- ============================================================================
create or replace view public.student_profiles_full
with (security_invoker = on)   -- RLS of the underlying tables still applies
as
select
  p.id                    as student_id,
  p.email,
  p.role,
  p.full_name,
  p.prn,
  p.phone,
  p.dob,
  p.gender,
  p.degree,
  p.college,
  p.institution_id,
  p.graduation_year,
  p.cgpa,
  p.skills,
  p.linkedin_url,
  p.github_url,
  p.ai_avatar,
  p.created_at            as profile_created_at,
  p.updated_at            as profile_updated_at,
  r.id                    as resume_id,
  r.storage_key           as resume_storage_key,
  r.resume_score,
  r.parsed                as resume_parsed,
  r.feedback              as resume_feedback,
  r.created_at            as resume_created_at,
  a.session_id            as assessment_session_id,
  a.total                 as talent_score,
  a.grade,
  a.percentile,
  a.scores                as assessment_scores,
  a.ai_feedback           as assessment_ai_feedback,
  a.verifiable_hash,
  a.report_storage_key    as report_storage_key,
  a.created_at            as assessment_created_at,
  (a.session_id is not null
    or exists (
      select 1 from public.assessment_sessions s
      where s.student_id = p.id
        and (s.status in ('submitted', 'expired') or s.submitted_at is not null)
    )
  )                       as assessment_attempted
from public.profiles p
left join lateral (
  select ra.*
  from public.resume_analyses ra
  where ra.student_id = p.id
  order by ra.created_at desc
  limit 1
) r on true
left join lateral (
  select ar.*
  from public.assessment_results ar
  where ar.student_id = p.id
  order by ar.created_at desc
  limit 1
) a on true;

-- Single-row dashboard aggregates for GET /api/admin/meta (stat cards +
-- college dropdown in one ~200-byte row instead of a full-table scan).
create or replace view public.admin_stats
with (security_invoker = on)   -- RLS of the underlying tables still applies
as
select
  count(*)::int                                                     as total_students,
  count(*) filter (where v.assessment_attempted)::int               as assessed_students,
  count(v.talent_score)::int                                        as scored_students,
  round(avg(v.talent_score))::int                                   as avg_score,
  coalesce(
    array_agg(distinct btrim(v.college))
      filter (where v.college is not null and btrim(v.college) <> ''),
    '{}'
  )                                                                 as colleges
from public.student_profiles_full v
where v.role = 'student';

-- ---------------------------------------------------------------------------
-- Feedback submissions (post-assessment candidate feedback)
-- "Which candidate gave which feedback" — written by /api/feedback, read back
-- per student by the admin dashboard. Kept here as well as in
-- supabase/migrations/0004_feedback_submissions.sql (that file is the one to
-- run against an existing database).

create table if not exists public.feedback_submissions (
  id           uuid primary key default gen_random_uuid(),
  -- Real Supabase user (null for local demo ids — see student_ref).
  student_id   uuid references public.profiles(id) on delete set null,
  -- Raw candidate id as sent by the client (`u_84368932`, a UUID, …).
  student_ref  text,
  email        text,
  session_id   text,
  rating       int  not null check (rating between 1 and 5),
  message      text not null check (char_length(btrim(message)) >= 10),
  source       text not null default 'web',
  created_at   timestamptz not null default now()
);

create index if not exists feedback_submissions_student_id_idx
  on public.feedback_submissions (student_id);
create index if not exists feedback_submissions_student_ref_idx
  on public.feedback_submissions (lower(student_ref));
create index if not exists feedback_submissions_email_idx
  on public.feedback_submissions (lower(email));
create index if not exists feedback_submissions_created_at_idx
  on public.feedback_submissions (created_at desc);
create index if not exists feedback_submissions_student_ref_created_idx
  on public.feedback_submissions (student_ref, created_at desc);
create index if not exists feedback_submissions_email_created_idx
  on public.feedback_submissions (lower(email), created_at desc);

alter table public.feedback_submissions enable row level security;

drop policy if exists feedback_insert_any on public.feedback_submissions;
create policy feedback_insert_any on public.feedback_submissions
  for insert with check (true);

drop policy if exists feedback_select_own on public.feedback_submissions;
create policy feedback_select_own on public.feedback_submissions
  for select using (student_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Help requests (in-app support form)
-- Written by POST /api/help. Kept here as well as in
-- supabase/migrations/0005_help_requests.sql (that file is the one to run
-- against an existing database). Replaces the old direct browser POST to an
-- external form service, which had a monthly submission limit.
-- ---------------------------------------------------------------------------
create table if not exists public.help_requests (
  id           uuid primary key default gen_random_uuid(),
  -- Real Supabase user (null when the request came from a local/demo id).
  student_id   uuid references public.profiles(id) on delete set null,
  -- Raw candidate id as sent by the client (`u_84368932`, a UUID, …).
  student_ref  text,
  email        text not null,
  phone        text,
  message      text not null check (char_length(btrim(message)) >= 10),
  page         text,
  source       text not null default 'web',
  created_at   timestamptz not null default now()
);

create index if not exists help_requests_email_idx       on public.help_requests (lower(email));
create index if not exists help_requests_created_at_idx  on public.help_requests (created_at desc);

alter table public.help_requests enable row level security;

-- Anyone may submit (contact form); the app writes with INSERT only, so no
-- update policy exists and a submitted request cannot be rewritten.
drop policy if exists help_requests_insert_any on public.help_requests;
create policy help_requests_insert_any on public.help_requests
  for insert with check (true);

drop policy if exists help_requests_select_own on public.help_requests;
create policy help_requests_select_own on public.help_requests
  for select using (student_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Low-egress admin change probe (migration 0007)
-- ---------------------------------------------------------------------------
create or replace view public.admin_change_probe
with (security_invoker = on)
as
select
  (select count(*)::int from public.profiles where role = 'student') as profiles_count,
  (select count(*)::int from public.assessment_results) as results_count,
  (select count(*)::int from public.resume_analyses) as resumes_count,
  (select count(*)::int from public.assessment_sessions) as sessions_count,
  (select count(*)::int from public.feedback_submissions) as feedback_count,
  (select max(updated_at) from public.profiles where role = 'student') as profiles_stamp,
  (select max(created_at) from public.assessment_results) as results_stamp,
  (select max(created_at) from public.resume_analyses) as resumes_stamp,
  (select max(coalesce(submitted_at, created_at)) from public.assessment_sessions) as sessions_stamp,
  (select max(created_at) from public.feedback_submissions) as feedback_stamp;
