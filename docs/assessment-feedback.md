# Post-assessment feedback

Newly completed assessments (including auto-submissions) go to `/feedback` before the existing student dashboard. A **timestamped** browser marker (`calibiai_feedback_pending`, written by `markFeedbackPending`) is left after the assessment save. The dashboard and result-page gates (`components/FeedbackGate.tsx`) redirect pending candidates back to feedback without rendering the report. Existing completed assessments are not retroactively blocked, and the marker **expires after 7 days** (`FEEDBACK_PENDING_TTL_MS`) — a marker from an older build, or one the JSON parser cannot read, is cleared on the spot instead of holding the candidate.

The candidate selects 1–5 stars and reviews a 10–1,000-character message. Every rating supplies editable wording. Whatever is typed is mirrored into `calibiai_feedback_draft`, so a refresh, a crash or a "Skip for now" never costs the candidate their words; the student dashboard offers to finish it later.

## Where the feedback is stored

**Supabase `public.feedback_submissions` is the only destination.** There is no third-party form service anywhere in this path — an external provider's monthly submission limit used to surface as "Your feedback could not be saved", and because only a `2xx` cleared the pending marker the candidate was then bounced back to `/feedback` forever, with their dashboard and report unreachable.

`POST /api/feedback` now has exactly two outcomes:

| Outcome | HTTP | Body | What the candidate sees |
|---|---|---|---|
| Row written to Postgres | 200 | `stored: "supabase"` | Thank-you, continue to dashboard |
| Row accepted, Postgres unavailable | 200 | `stored: "queue"`, `reason` | Thank-you, continue to dashboard |
| Invalid rating/message | 400 | `error` | The form, with the reason |

A queue is not a copy: the row is kept in the local store as `synced: false` and `flushQueuedFeedback()` replays it into Supabase as soon as the database answers. The flush runs on every `/feedback` POST, on `POST /api/feedback/flush` (the student dashboard calls it on mount), so a submission that failed once is delivered by the next visit from *anyone* — the queue lives on the server, not in the candidate's browser. Rows are keyed by the client's submission id, so retries cannot duplicate.

### How the write reaches Postgres

`persistFeedbackDetailed()` (`lib/persist.ts`) uses a plain **`insert`**, and treats a `23505` unique violation as success. It used to call `.upsert(row, { onConflict: 'id' })`, which PostgREST sends as `INSERT … ON CONFLICT DO UPDATE`; that statement also needs an UPDATE RLS policy, and `feedback_submissions` deliberately has only insert + select-own — so with the anon key every write failed with `42501 new row violates row-level security policy`, the route answered `503`, and the candidate was stranded. Recoveries, in order:

1. `insert` — allowed by `feedback_insert_any` (postgrest-js sends no `return=representation`, so no SELECT policy is needed either).
2. `23505` → the same submission id is already there: success, `duplicate: true`.
3. any other error → `upsert(…, { ignoreDuplicates: true })`, which is `ON CONFLICT DO NOTHING` and therefore needs only INSERT.
4. `23503` (the candidate's `profiles` row is missing) → retry with `student_id` dropped; `student_ref` and `email` still let `/admin` match the feedback to the candidate.

A permissive UPDATE policy is intentionally **not** added: it would let anyone rewrite other candidates' feedback. `supabase/migrations/0005_help_requests.sql` records this decision.

`SUPABASE_SERVICE_ROLE_KEY` is still recommended (it bypasses RLS and lets the admin dashboard read every row), but the feedback write no longer depends on it.

## AI configuration

`POST /api/feedback/suggest` uses the existing server-only `CALIBIAI_API_KEY` or `DEEPSEEK_API_KEY`, with the matching optional `_BASE_URL` and `_MODEL` variables already used by the app. Default endpoint/model: `https://api.deepseek.com`, `deepseek-chat`. Never use a `NEXT_PUBLIC_` key. With no key or an upstream failure, the original wording is retained and the UI explicitly reports that AI is unavailable. Feedback submission does not depend on AI.

AI is opt-in; only the rating and comments go to the provider. Assessment feedback is sent only to `/api/feedback` and stored in Supabase.

## Verification

- Finish a manual or auto-submitted assessment: feedback appears.
- Reload or directly visit `/dashboard/student` or `/result` while pending: feedback is offered.
- Use Tab and arrow keys to select the star radio inputs; suggested text updates.
- Edit text, switch ratings, and polish with AI. Edits made while AI runs are not overwritten.
- `POST /api/feedback` with a healthy database → `200 {stored:"supabase"}` and a row in `feedback_submissions`.
- `POST /api/feedback` with the table missing / the database down → `200 {stored:"queue"}`, the candidate reaches the dashboard, and `POST /api/feedback/flush` delivers the row once the database is back.
- Repeat the same submission id → `200 {duplicate:true}`, still one row.
- "Skip for now" → dashboard and report are reachable, the draft survives, the dashboard offers to finish it.
- `npm test` covers the ticket TTL/expiry, the legacy (no-timestamp) marker, the write path, the queue and the flush (`lib/__tests__/feedback*.test.ts`).
- `scripts/mock-postgrest.mjs` reproduces the exact `42501` / `42P01` responses end-to-end against a real supabase-js client:
  ```bash
  node scripts/mock-postgrest.mjs            # healthy "database"
  MISSING_TABLE=1 node scripts/mock-postgrest.mjs   # migration not applied
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=x npm run dev
  ```
- Test mobile widths and reduced-motion preferences.

This requirement is enforced in the browser, consistent with the existing assessment navigation. It is not a server-side authorization boundary: clearing site storage or another device can bypass it. Cross-device enforcement would require a persisted feedback receipt tied to authenticated assessment records and report API checks, outside this UI-focused change.
