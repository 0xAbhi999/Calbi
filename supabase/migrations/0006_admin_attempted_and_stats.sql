-- ============================================================================
-- Migration 0006 — `assessment_attempted` on the export view + `admin_stats`
-- Run in the Supabase SQL editor (or `supabase db push`). Idempotent.
--
-- 1. `student_profiles_full` gains `assessment_attempted` (boolean): true when
--    the student has an assessment result OR a submitted/expired session —
--    exactly the "Taken" display rule the dashboard has always used. The
--    paginated admin table filters "assessed only" on this column in SQL.
-- 2. `admin_stats` is a new single-row view (totals + average + college list)
--    so the dashboard's stat cards and college dropdown cost one ~200-byte row
--    instead of a full-table scan.
--
-- The app works WITHOUT this migration (it probes for the new column/view and
-- falls back to talent-only filtering and narrow scans), but running it makes
-- the "assessed only" filter exact and the dashboard cheaper. Restart the app
-- server afterwards so the column probe re-runs immediately.
-- ============================================================================

-- Drop the dependent stats view first so re-running this migration never fails
-- on the view dependency, then re-create both below.
drop view if exists public.admin_stats;
drop view if exists public.student_profiles_full;

-- Re-create the export view with `assessment_attempted`, preserving whichever
-- shape is current: with the latest-feedback join when migration 0004 has been
-- applied (feedback table exists), without it otherwise.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'feedback_submissions'
  ) then
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
      a.created_at            as assessment_created_at,
      (a.session_id is not null
        or exists (
          select 1 from public.assessment_sessions s
          where s.student_id = p.id
            and (s.status in ('submitted', 'expired') or s.submitted_at is not null)
        )
      )                       as assessment_attempted,
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
  else
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
  end if;
end $$;

comment on view public.student_profiles_full is
  'One row per student: profile + latest resume analysis + latest assessment result + latest feedback. assessment_attempted is true with a result or a submitted/expired session. Used by the /admin dashboard and CSV export.';

-- ---------------------------------------------------------------------------
-- Single-row dashboard aggregates for /api/admin/meta.
-- ---------------------------------------------------------------------------
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

comment on view public.admin_stats is
  'Single-row aggregates for the /admin stat cards and college dropdown (total / assessed / scored / average score / distinct colleges). Read by GET /api/admin/meta.';
