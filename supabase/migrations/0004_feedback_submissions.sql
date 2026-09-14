-- ============================================================================
-- Migration 0004 — candidate feedback (`feedback_submissions`)
-- Run in the Supabase SQL editor (or `supabase db push`). Idempotent.
--
-- "Which candidate gave which feedback": the post-assessment form now writes
-- every submission here (and mirrors it into the local JSON store so demo mode
-- still works), and /admin reads it back per student. Supabase is the only
-- destination for assessment feedback; the former external notification is no
-- longer used.
--
-- Notes on the shape:
--   * `student_id` is nullable: the seeded/demo candidates carry short `u_…`
--     ids that cannot be stored in a `uuid` column, so the raw id is kept in
--     `student_ref` and the email is stored too. The dashboard matches feedback
--     to a student by id **or** email, so both cases work.
--   * `session_id` is text (assessment session ids are UUIDs for real sessions
--     but `sess_…` for the demo data).
--   * inserts are allowed for anyone (it is a feedback form, like a contact
--     form); reads are self-scoped and the admin reads with the service role.
-- ============================================================================

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

comment on table public.feedback_submissions is
  'Post-assessment feedback submitted by a candidate (rating 1-5 + comment) and shown per student in the admin dashboard.';

create index if not exists feedback_submissions_student_id_idx
  on public.feedback_submissions (student_id);
create index if not exists feedback_submissions_student_ref_idx
  on public.feedback_submissions (lower(student_ref));
create index if not exists feedback_submissions_email_idx
  on public.feedback_submissions (lower(email));
create index if not exists feedback_submissions_created_at_idx
  on public.feedback_submissions (created_at desc);

alter table public.feedback_submissions enable row level security;

-- Anyone (including the anon key the app uses when no service role is set) may
-- submit feedback; the CHECK constraints above still apply.
drop policy if exists feedback_insert_any on public.feedback_submissions;
create policy feedback_insert_any on public.feedback_submissions
  for insert with check (true);

-- A signed-in student may read back their own feedback.
drop policy if exists feedback_select_own on public.feedback_submissions;
create policy feedback_select_own on public.feedback_submissions
  for select using (student_id = auth.uid());

-- ============================================================================
-- Optional convenience: expose the latest feedback on the export view so a
-- plain `select * from public.student_profiles_full` also carries it. The app
-- does NOT depend on this — /admin joins feedback itself (so it works whether
-- or not this migration has been applied) — but it keeps the SQL view useful
-- for manual exports. Skipped automatically when migration 0003 has not run.
-- ============================================================================
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'prn'
  ) then
    -- Cascade: fresh projects built from supabase/schema.sql already have the
    -- admin_stats view (migration 0006) depending on this one; cascade drops
    -- it too and 0006 re-creates it when it runs later in the chain.
    drop view if exists public.student_profiles_full cascade;
    create view public.student_profiles_full
    with (security_invoker = on)
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
      f.rating                as feedback_rating,
      f.message               as feedback_message,
      f.created_at            as feedback_created_at
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
    ) a on true
    left join lateral (
      select fs.rating, fs.message, fs.created_at
      from public.feedback_submissions fs
      where fs.student_id = p.id or lower(fs.email) = lower(p.email)
      order by fs.created_at desc
      limit 1
    ) f on true;

    comment on view public.student_profiles_full is
      'One row per student: profile + latest resume analysis + latest assessment result + latest feedback. Used by the /admin dashboard and CSV export.';
  end if;
end $$;
