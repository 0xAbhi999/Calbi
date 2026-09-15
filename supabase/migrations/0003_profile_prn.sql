-- ============================================================================
-- Migration 0003 — profiles.prn (college PRN / registration number, optional)
-- Run in the Supabase SQL editor (or `supabase db push`). Idempotent.
--
-- Colleges match a CalibiAI record to their own student register by PRN, so the
-- profile now carries one. It is OPTIONAL: a student who leaves it blank is
-- still fully onboarded, and the unique index below is a partial one so any
-- number of blank PRNs can coexist.
--
-- The `student_profiles_full` export view is re-created (not replaced) because
-- the new column sits in the middle of its column list, which
-- `create or replace view` refuses to do (42P16: cannot drop columns from
-- view). The drop cascades: projects built from supabase/schema.sql, or a
-- re-run of this chain after 0006, already have the `admin_stats` view
-- depending on this one; migration 0006 re-creates `admin_stats` afterwards.
-- ============================================================================

alter table public.profiles
  add column if not exists prn text;

comment on column public.profiles.prn is
  'College PRN / permanent registration number. Optional (4-20 letters/numbers when supplied); stored upper case.';

-- One student per PRN; blanks are exempt because the field is optional.
create unique index if not exists profiles_prn_unique_idx
  on public.profiles (prn)
  where prn is not null and btrim(prn) <> '';

-- ---------------------------------------------------------------------------
-- Re-create the download view with the PRN column included.
-- ---------------------------------------------------------------------------
drop view if exists public.student_profiles_full cascade;

create view public.student_profiles_full
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
  a.created_at            as assessment_created_at
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

comment on view public.student_profiles_full is
  'One row per student: profile + latest resume analysis + latest assessment result. Use the Supabase table editor export (CSV/Excel/JSON) to download all data.';
