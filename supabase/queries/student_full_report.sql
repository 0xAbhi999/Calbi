-- ============================================================================
-- Student records — "everything, including the score"
-- ----------------------------------------------------------------------------
-- Run any block below in the Supabase SQL editor (Dashboard → SQL Editor →
-- Run). Results can be exported straight from the results grid
-- (Download → CSV / JSON).
--
--   QUERY 1  one row per student, every score column expanded  ← the main one
--   QUERY 2  ready-made filters (one student / college / score band)
--   QUERY 3  the short version, via the existing `student_profiles_full` view
--   QUERY 4  optional: install QUERY 1 as a reusable view + CSV export helper
--   QUERY 5  raw JSONB dumps (full scores object, AI feedback, answers)
--
-- Notes
--   * The SQL editor runs as `postgres`, which bypasses Row Level Security, so
--     you see EVERY student. The app's anon key does not: RLS on
--     `assessment_results` / `feedback_submissions` only exposes a user's own
--     rows. Use `SUPABASE_SERVICE_ROLE_KEY` server-side for the same reach.
--   * "Latest" resume / result / feedback = newest by `created_at`, matching
--     what `/admin` shows. Feedback is matched by `student_id` OR `email`,
--     because seeded candidates carry local `u_…` ids that are not UUIDs
--     (the same rule `lib/adminStudents.ts` uses).
--   * A student who has not taken the assessment still appears (scores NULL).
--     Filter with `where ar.total is not null` to list assessed students only.
-- ============================================================================


-- ============================================================================
-- QUERY 1 — one row per student, complete record with every score expanded
-- ============================================================================
select
  -- ── Who ────────────────────────────────────────────────────────────────
  p.full_name                                   as name,
  p.email,
  p.prn,
  p.phone,
  p.dob,
  p.gender,
  p.degree,
  p.college,
  p.graduation_year,
  p.cgpa,
  p.skills,
  p.linkedin_url,
  p.github_url,
  p.role,
  p.id                                          as student_id,
  p.created_at                                  as signed_up_at,
  p.updated_at                                  as profile_updated_at,
  u.email_confirmed_at,
  u.last_sign_in_at,

  -- ── Assessment attempt ─────────────────────────────────────────────────
  case
    when ar.id is not null then 'Yes'
    when s.id  is not null then 'Attempted (no result saved)'
    else 'No'
  end                                           as has_assessment,
  s.id                                          as session_id,
  s.status                                      as session_status,
  s.started_at                                  as started_at,
  s.submitted_at                                as submitted_at,
  s.duration_sec                                as time_limit_sec,
  s.tab_switches                                as tab_switches,

  -- ── Headline score (the CalibiAI Score, out of 1000) ───────────────────
  ar.total                                      as calibiai_score,
  ar.grade,
  ar.percentile,
  ar.verifiable_hash,
  ar.created_at                                 as assessed_at,

  -- ── English (max 200) ──────────────────────────────────────────────────
  (ar.scores -> 'english' ->> 'total')::numeric     as english_total,
  (ar.scores -> 'english' ->> 'listening')::numeric as english_listening,
  (ar.scores -> 'english' ->> 'speaking')::numeric  as english_speaking,
  (ar.scores -> 'english' ->> 'reading')::numeric   as english_reading,
  (ar.scores -> 'english' ->> 'writing')::numeric   as english_writing,

  -- ── Technical / AI modules ─────────────────────────────────────────────
  (ar.scores ->> 'problem_solving')::numeric        as problem_solving,
  (ar.scores ->> 'ai_debugging')::numeric           as ai_debugging,
  (ar.scores ->> 'ai_feature')::numeric             as ai_feature,
  (ar.scores ->> 'prompt_engineering')::numeric     as prompt_engineering,

  -- ── Cognitive + behavioural (max 200) ──────────────────────────────────
  (ar.scores -> 'cognitive' ->> 'total')::numeric            as cognitive_total,
  (ar.scores -> 'cognitive' ->> 'grid')::numeric             as cognitive_grid,
  (ar.scores -> 'cognitive' ->> 'logical')::numeric          as cognitive_logical,
  (ar.scores -> 'cognitive' ->> 'cognitive_score')::numeric  as cognitive_score,
  (ar.scores -> 'cognitive' ->> 'behavioral_total')::numeric as behavioral_total,
  (ar.scores -> 'cognitive' -> 'behavioral' ->> 'teamwork')::numeric        as teamwork,
  (ar.scores -> 'cognitive' -> 'behavioral' ->> 'accountability')::numeric  as accountability,
  (ar.scores -> 'cognitive' -> 'behavioral' ->> 'adaptability')::numeric    as adaptability,
  (ar.scores -> 'cognitive' -> 'behavioral' ->> 'responsible_ai')::numeric  as responsible_ai,
  (ar.scores -> 'cognitive' -> 'behavioral' ->> 'decision_making')::numeric as decision_making,
  (ar.scores -> 'cognitive' -> 'behavioral' ->> 'learning_mindset')::numeric as learning_mindset,

  -- ── Raw accuracy behind the scores ─────────────────────────────────────
  (ar.scores -> 'detail' ->> 'listeningCorrect')::int as listening_correct,
  (ar.scores -> 'detail' ->> 'listeningTotal')::int   as listening_total,
  (ar.scores -> 'detail' ->> 'readingCorrect')::int   as reading_correct,
  (ar.scores -> 'detail' ->> 'readingTotal')::int     as reading_total,
  (ar.scores -> 'detail' ->> 'problemCorrect')::int   as problem_correct,
  (ar.scores -> 'detail' ->> 'problemTotal')::int     as problem_total,
  (ar.scores -> 'detail' ->> 'logicalCorrect')::int   as logical_correct,
  (ar.scores -> 'detail' ->> 'logicalTotal')::int     as logical_total,
  (ar.scores -> 'detail' ->> 'debugPer')::numeric     as debugging_percent,
  (ar.scores -> 'detail' ->> 'promptPer')::numeric    as prompt_percent,
  (ar.scores -> 'detail' ->> 'featureScore100')::numeric as feature_score_100,
  (ar.scores -> 'detail' ->> 'speakingCount')::int    as speaking_answers,

  -- ── AI grader output per subjective section ────────────────────────────
  ar.ai_feedback                                as ai_feedback,
  ar.report_storage_key,

  -- ── Resume ─────────────────────────────────────────────────────────────
  ra.resume_score,
  ra.storage_key                                as resume_storage_key,
  ra.created_at                                 as resume_uploaded_at,
  ra.parsed -> 'skills'                         as resume_skills,
  (ra.parsed ->> 'experience_years')::numeric   as resume_experience_years,
  (ra.parsed ->> 'projects')::int               as resume_projects,
  (ra.parsed ->> 'word_count')::int             as resume_word_count,
  ra.parsed ->> 'file_name'                     as resume_file_name,
  ra.feedback                                   as resume_feedback,

  -- ── Feedback the candidate gave about the assessment ───────────────────
  fb.rating                                     as feedback_rating,
  fb.message                                    as feedback_message,
  fb.created_at                                 as feedback_at,
  coalesce(fbc.cnt, 0)                          as feedback_submissions,

  -- ── Help requests raised through the in-app help form ──────────────────
  coalesce(hrc.cnt, 0)                          as help_requests,
  hr.message                                    as latest_help_message,
  hr.created_at                                 as latest_help_at,

  -- ── Community steps ────────────────────────────────────────────────────
  (tw.completed_at is not null)                 as joined_whatsapp,
  (tl.completed_at is not null)                 as followed_linkedin
from public.profiles p
left join auth.users u on u.id = p.id
-- one active/latest assessment session per student
left join lateral (
  select s.*
  from public.assessment_sessions s
  where s.student_id = p.id
  order by s.created_at desc
  limit 1
) s on true
-- latest scored result
left join lateral (
  select r.*
  from public.assessment_results r
  where r.student_id = p.id
  order by r.created_at desc
  limit 1
) ar on true
-- latest resume analysis
left join lateral (
  select ra.*
  from public.resume_analyses ra
  where ra.student_id = p.id
  order by ra.created_at desc
  limit 1
) ra on true
-- latest feedback (matched by id OR email — seeded candidates use local ids)
left join lateral (
  select f.rating, f.message, f.created_at
  from public.feedback_submissions f
  where f.student_id = p.id or lower(f.email) = lower(p.email)
  order by f.created_at desc
  limit 1
) fb on true
left join lateral (
  select count(*) as cnt
  from public.feedback_submissions f
  where f.student_id = p.id or lower(f.email) = lower(p.email)
) fbc on true
-- latest help request + how many
left join lateral (
  select h.message, h.created_at
  from public.help_requests h
  where h.student_id = p.id or lower(h.email) = lower(p.email)
  order by h.created_at desc
  limit 1
) hr on true
left join lateral (
  select count(*) as cnt
  from public.help_requests h
  where h.student_id = p.id or lower(h.email) = lower(p.email)
) hrc on true
-- community tracking
left join lateral (
  select t.completed_at
  from public.tracking_events t
  where t.user_id = p.id and t.action = 'join_whatsapp' and t.completed
  order by t.completed_at desc nulls last
  limit 1
) tw on true
left join lateral (
  select t.completed_at
  from public.tracking_events t
  where t.user_id = p.id and t.action = 'follow_linkedin' and t.completed
  order by t.completed_at desc nulls last
  limit 1
) tl on true
-- ── Optional filters (uncomment what you need) ───────────────────────────
-- where ar.total is not null                     -- assessed students only
-- where p.college ilike '%pimpri%'               -- one college
-- where p.email ilike '%@gmail.com'              -- one domain
-- where ar.total >= 700                          -- a score band
order by ar.total desc nulls last, p.created_at desc;


-- ============================================================================
-- QUERY 2 — one student, or one college, or one score band
-- QUERY 1 already has the filters; uncomment the line you need just above its
-- `order by`. Every combination works, and they can be combined:
-- ============================================================================
--   where lower(p.email) = lower('student@example.com')   -- one student (email)
--   where p.id = '00000000-0000-0000-0000-000000000000'   -- one student (UUID)
--   where upper(p.prn) = 'PCCOE2021045'                   -- one student (PRN)
--   where p.college ilike '%pccoe%'                       -- one college
--   where ar.total is not null                            -- assessed students only
--   where ar.total between 700 and 1000                   -- a score band
--   where fb.rating is null                               -- never gave feedback
--
-- Tip: the SQL editor's results grid has a Download button (CSV / JSON /
-- Excel), so a filtered QUERY 1 is also a one-click export for that college.


-- ============================================================================
-- QUERY 3 — the short version: the export view the app already maintains
-- (profile + latest resume + latest result + latest feedback in one row;
--  module scores stay inside the `assessment_scores` JSONB column)
-- ============================================================================
select *
from public.student_profiles_full
order by assessment_created_at desc nulls last;


-- ============================================================================
-- QUERY 4 — optional: install QUERY 1 as a reusable view, then export it
-- Run once. Afterwards `select * from public.student_reports_full;` returns
-- the full record, and the Supabase table editor can export it as CSV/Excel.
-- ============================================================================
-- drop view if exists public.student_reports_full;
-- create view public.student_reports_full
-- with (security_invoker = on)      -- keeps the underlying RLS in force
-- as
-- <paste QUERY 1 here, without the trailing semicolon>;
--
-- comment on view public.student_reports_full is
--   'One row per student: profile, auth status, assessment session, CalibiAI Score, every module/behavioural score, resume, feedback and help requests.';


-- ============================================================================
-- QUERY 5 — raw JSONB, when you need fields the flattened list does not expose
-- ============================================================================
-- Full scores object + AI feedback for every assessed student:
-- select p.full_name, p.email, r.total, r.grade, r.percentile,
--        r.scores        as full_scores_json,
--        r.ai_feedback   as ai_feedback_json
-- from public.assessment_results r
-- join public.profiles p on p.id = r.student_id
-- order by r.created_at desc;

-- Every submitted answer of one session (one row per question):
-- select s.id as session_id, p.email, s.status,
--        q.key                  as question_id,
--        s.answers -> q.key     as answer
-- from public.assessment_sessions s
-- join public.profiles p on p.id = s.student_id
-- cross join lateral jsonb_object_keys(s.answers) as q(key)
-- where lower(p.email) = lower('student@example.com')
-- order by q.key;

-- Score distribution / college averages:
-- select p.college,
--        count(*)                 as students_assessed,
--        round(avg(r.total), 1)   as avg_score,
--        min(r.total)             as lowest,
--        max(r.total)             as highest,
--        round(avg(f.rating), 2)  as avg_feedback_rating
-- from public.assessment_results r
-- join public.profiles p on p.id = r.student_id
-- left join lateral (
--   select f.rating from public.feedback_submissions f
--   where f.student_id = p.id or lower(f.email) = lower(p.email)
--   order by f.created_at desc limit 1
-- ) f on true
-- group by p.college
-- order by avg_score desc nulls last;
