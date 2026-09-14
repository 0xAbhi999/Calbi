-- ============================================================================
-- Migration 0007 — egress + admin query hardening
-- Run after 0001–0006 in the Supabase SQL editor. Idempotent.
--
-- Root cause addressed by this migration:
--   * the admin live view previously ran eight count/MAX queries per poll;
--   * latest-per-student lateral joins and assessment filters lacked supporting
--     indexes, making refreshes slow and more likely to retry/fan out;
--   * a transient paged-query failure in the app could fall back to reading the
--     entire student/result/resume history.
--
-- The application now uses admin_change_probe (one small response), caches the
-- probe, pages the student view, and serves stale pages during short outages.
-- This SQL makes the one probe and the paged view cheap at the database too.
-- ============================================================================

create index if not exists profiles_role_college_idx
  on public.profiles (role, college);

create index if not exists assessment_results_student_created_idx
  on public.assessment_results (student_id, created_at desc);

create index if not exists assessment_sessions_student_created_idx
  on public.assessment_sessions (student_id, created_at desc);

create index if not exists assessment_sessions_status_student_idx
  on public.assessment_sessions (status, student_id, created_at desc);

create index if not exists feedback_submissions_student_ref_created_idx
  on public.feedback_submissions (student_ref, created_at desc);

create index if not exists feedback_submissions_email_created_idx
  on public.feedback_submissions (lower(email), created_at desc);

-- One-row change probe for the admin dashboard. It deliberately contains only
-- counts and timestamps, never student data or JSONB. `security_invoker` keeps
-- RLS semantics for non-service-role clients; the server admin client should
-- use SUPABASE_SERVICE_ROLE_KEY.
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

comment on view public.admin_change_probe is
  'Small change probe for the admin live dashboard; contains no student payloads or JSONB.';
