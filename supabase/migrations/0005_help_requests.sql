-- ============================================================================
-- Migration 0005 — support requests (`help_requests`) + feedback write policy
-- Run in the Supabase SQL editor (or `supabase db push`). Idempotent.
--
-- 1) `help_requests` — the in-app help form ("A little help, right here") used
--    to POST straight from the browser to an external form service. That
--    endpoint has a monthly submission limit; once it was used up every
--    candidate saw "Your request could not be sent" and nothing reached the
--    database. Requests are now stored here, next to everything else.
--
-- 2) A comment on `feedback_submissions`: the app writes feedback with a plain
--    INSERT (duplicates are detected from the unique-violation error), NOT with
--    an upsert. `INSERT … ON CONFLICT DO UPDATE` — what `.upsert()` sends — also
--    needs an UPDATE policy, and this table deliberately only has insert +
--    select-own. Adding a permissive update policy would let anyone rewrite
--    other candidates' feedback, so it is intentionally NOT added; the client
--    path works with the policies below.
-- ============================================================================

create table if not exists public.help_requests (
  id           uuid primary key default gen_random_uuid(),
  -- Real Supabase user (null when the request came from a local/demo id).
  student_id   uuid references public.profiles(id) on delete set null,
  -- Raw candidate id as sent by the client (`u_84368932`, a UUID, …).
  student_ref  text,
  email        text not null,
  phone        text,
  message      text not null check (char_length(btrim(message)) >= 10),
  -- Pathname only — the app never sends a query string.
  page         text,
  source       text not null default 'web',
  created_at   timestamptz not null default now()
);

comment on table public.help_requests is
  'Support requests submitted through the in-app help form. Written by POST /api/help; queued and retried server-side when the database is unreachable.';

create index if not exists help_requests_email_idx       on public.help_requests (lower(email));
create index if not exists help_requests_created_at_idx  on public.help_requests (created_at desc);

alter table public.help_requests enable row level security;

-- Anyone may submit a help request (it is a contact form); the CHECK above
-- still applies. The app writes with INSERT only, so no update policy is
-- needed — and none is added, so a submitted request cannot be rewritten.
drop policy if exists help_requests_insert_any on public.help_requests;
create policy help_requests_insert_any on public.help_requests
  for insert with check (true);

-- A signed-in student may read back their own requests; the team reads
-- everything with the service-role key (GET /api/help is admin-cookie only).
drop policy if exists help_requests_select_own on public.help_requests;
create policy help_requests_select_own on public.help_requests
  for select using (student_id = auth.uid());
