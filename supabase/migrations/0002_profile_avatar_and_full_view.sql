-- ============================================================================
-- Migration 0002 — profile avatar + one-table "download everything" view
-- Run in the Supabase SQL editor (or `supabase db push`). Idempotent.
--
-- 1. public.profiles.ai_avatar  — the generated AI avatar config
--    ({ seed, style, version, generated_at }) so the same animated avatar
--    renders identically on every device and can be exported/downloaded.
-- 2. public.student_profiles_full — a read-only view that flattens a student's
--    profile + latest resume analysis + latest assessment result into ONE row.
--    Open it in the Supabase table editor and use "Export CSV / Excel / JSON"
--    to download every student's complete record in a single click.
-- ============================================================================

alter table public.profiles
  add column if not exists ai_avatar jsonb;

comment on column public.profiles.ai_avatar is
  'Generated AI avatar config: { seed:number, style:"aura"|"emerald"|"sunset"|"cyber", version:number, generated_at:iso8601 }';

-- Only install the view when it is missing. Later migrations deliberately
-- change its shape: 0003 inserts `prn` in the middle of the column list,
-- 0004 appends feedback_* columns and 0006 appends assessment_attempted.
-- `create or replace view` can only ADD columns at the end, so replacing a
-- newer view with this original shape fails with "42P16: cannot drop columns
-- from view" (the same error hits a re-run of this migration after 0003+).
-- A view that already exists is therefore left untouched — the newest
-- migration (or supabase/schema.sql) owns the current definition.
do $$
begin
  if not exists (
    select 1 from information_schema.views
    where table_schema = 'public' and table_name = 'student_profiles_full'
  ) then
    create view public.student_profiles_full
    with (security_invoker = on)   -- RLS of the underlying tables still applies
    as
    select
      p.id                    as student_id,
      p.email,
      p.role,
      p.full_name,
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
      -- latest resume analysis (one row per student)
      r.id                    as resume_id,
      r.storage_key           as resume_storage_key,
      r.resume_score,
      r.parsed                as resume_parsed,
      r.feedback              as resume_feedback,
      r.created_at            as resume_created_at,
      -- latest assessment result (one row per student)
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
  end if;
end $$;
