# Supabase egress incident runbook

## What was causing the spike

The repository did not contain the screenshot or raw hosting logs, so this diagnosis is based on the request paths in the code. The main causes were visible and independent:

1. **Admin refreshes could read the entire database.** The dashboard is long-lived and refreshes every 30 seconds. A paged query failure was treated as a reason to call `fetchAllStudents()`, which downloaded profiles, every resume/result/session row, and feedback. A transient timeout therefore became a multi-megabyte Supabase response. Multiple admin tabs multiplied it.
2. **The admin change probe fanned out into eight PostgREST requests per poll.** Four `count` queries and four newest-timestamp queries ran even when nothing changed.
3. **Feedback lookups were not scoped tightly enough.** The candidate feedback GET path downloaded the global feedback history and filtered it in Node. Feedback is user-entered and unbounded, so this grew over time.
4. **Assessment writes were duplicated.** Final submission sent the session and result through the server API, then the browser wrote both rows directly to Supabase again. This doubled database work and created races.
5. **Invalid demo IDs were converted to a new random UUID on every save.** Repeated assessment autosaves could create/expire different Postgres session rows instead of updating one row. This increased writes, table bloat and index work.
6. **Autosave was only debounced, not throttled.** Long writing answers could still generate a server/Postgres write after every short pause. The response also echoed the complete growing answer JSON back to the browser on every save.

The first item is the likely direct egress offender. The write and ID issues are the likely database-load/storage offenders and can make an incident much worse even when their response bodies are small.

## Code changes in this incident fix

- `GET /api/admin/students?check=1` is cached and coalesced; migration 0007 adds the one-row `admin_change_probe`.
- Admin table reads remain page-sized and select only fields used by the table/expanded row; heavy AI feedback, storage keys and tenant metadata are excluded.
- Transient Supabase failures no longer trigger a full-table fallback. The API serves a last-good page for up to five minutes and returns `503` with `Retry-After` after that.
- Schema/setup errors fail closed to local rows with a visible migration warning; they never trigger an unbounded base-table read. This protects the database until the missing migration is applied.
- Legacy view revisions retry with a bounded projection (never `select=*`).
- Candidate feedback GETs use student/email filters and a bounded result set instead of downloading global history.
- Assessment final persistence has one server-owned write path. The duplicate browser-side writes were removed.
- Local IDs are mapped deterministically by scope (`profile`, `session`, `result`); retries update the same row.
- Assessment checkpoints are throttled to one request per 10 seconds. LocalStorage remains the per-keystroke recovery layer and final submit remains authoritative.
- Autosave responses acknowledge metadata only; they no longer echo the growing `answers` JSON.
- Composite indexes support latest-per-student joins, assessed filtering and feedback lookups.

## Deploy immediately

1. Run `supabase/migrations/0007_egress_query_hardening.sql` in the Supabase SQL editor after migrations 0004–0006. It is idempotent.
2. Set `SUPABASE_SERVICE_ROLE_KEY` on the server only. Never put it in `NEXT_PUBLIC_*`; it is required for the admin to read all rows under RLS.
3. Deploy the application and restart all Node/PM2 workers so the new caches and query behavior are loaded.
4. Open `/admin` in one tab, confirm the warning is absent, and verify that the Network panel shows a small `?check=1` response and one page-sized `/api/admin/students` response.
5. Do not repeatedly click CSV export during an incident. Export is intentionally an explicit full-data operation and should be treated as an offline/admin job.

## Verify in Supabase

Use the Supabase dashboard's **Reports → Database → Query Performance** and **Reports → Usage** views. Confirm:

- `admin_change_probe` is one small response, not eight table requests per poll.
- `student_profiles_full` requests have a `range`/page-sized result.
- No repeated large reads of `resume_analyses`, `assessment_results` or `feedback_submissions` occur during idle admin time.
- `assessment_sessions` has one active row per student, not a new row for every autosave.
- `assessment_results` has one row per session (`session_id` unique).
- Storage egress is not the source: speaking audio is uploaded directly by the browser and should be checked separately from database egress.

Useful SQL checks:

```sql
-- Rows and approximate payload pressure
select relname, n_live_tup, pg_total_relation_size(relid) as bytes
from pg_catalog.pg_statio_user_tables
where relname in ('profiles', 'assessment_sessions', 'assessment_results', 'resume_analyses', 'feedback_submissions')
order by bytes desc;

-- Autosave/session duplication signal
select student_id, count(*)
from public.assessment_sessions
group by student_id
having count(*) > 3
order by count(*) desc;

-- The low-egress probe must return one row of scalar values only
select * from public.admin_change_probe;
```

## Operating limits to keep

- Keep the admin refresh interval at 30–60 seconds; pause it when the tab is hidden.
- Keep default table page size at 50 and cap it at 200.
- Keep search/filter/pagination server-side; never reintroduce `select('*')` over a whole table for a screen.
- Keep exports separate from interactive requests. For very large datasets, create a queued export that writes a CSV to object storage and returns a signed download URL.
- Keep user-generated JSON/text bounded and select explicit columns. Avoid returning `ai_feedback`, transcripts, resume contents or answer JSON to screens that do not render them.
- Use idempotency keys for every submission and checkpoint. Never generate a fresh UUID during a retry.
- Use a queue/worker for AI evaluation, report generation and large exports. The request path should persist a job and return quickly.
- Measure response bytes, query count, p95 latency, 5xx/429 rates and DB dead tuples. An egress alert without request-volume and response-size metrics is hard to diagnose.
- Keep RLS enabled. Use the service-role key only in server routes, never in browser code.

## Longer-term architecture

At higher volume, replace the JSON view join used by the admin with a maintained `admin_student_summary` table (one compact row per student) updated by database triggers or an event worker. Keep full JSONB result/AI payloads in detail tables and fetch them only when an admin explicitly expands a row. For exports, enqueue a job and stream the result from object storage. This separates the interactive dashboard's small read model from the assessment write model and makes egress predictable.
