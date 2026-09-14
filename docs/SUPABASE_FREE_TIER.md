# Staying on Supabase Free — Egress & Quota Guide

How to keep this app (Calibiai Score) inside the Supabase **free plan**,
what burns egress, what was already optimised in code, and which free
services (Cloudflare R2, Neon, Oracle, Azure…) to use when you outgrow a quota.

## 1. The free plan limits (2026)

Per project, on the $0 plan ([source](https://selfhost.dev/blog/supabase-pricing-explained/),
[comparison](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/)):

| Resource | Free limit | What happens when you hit it |
|---|---|---|
| Database size | **500 MB** Postgres | Project goes read-only until you delete data |
| Egress (uncached: DB/API/Auth/Storage out) | **5 GB / month** | Throttled / must upgrade |
| Cached egress (CDN) | **5 GB / month** | Same pool idea, via cache headers |
| File storage | **1 GB** | Uploads rejected |
| Auth MAUs | **50,000 / month** | You have a hit product — upgrade |
| Realtime | 200 concurrent conns, 2 M msgs/mo | Connections refused |
| Edge Functions | 500 k invocations/mo | — |
| API requests | **Unlimited** | — |
| Projects | 2 active | — |
| Inactivity | **Paused after 7 days** with no traffic | Manual resume in dashboard |

Key insight: **API requests are unlimited — bytes out are not.** Ten thousand
tiny queries are free-ish; one 5 MB download repeated 1,000× blows the month.
So the game is: *transfer fewer bytes, not fewer requests.*

## 2. Where YOUR egress goes (ranked)

Measured against this codebase:

### 🔴 #1 — Admin dashboard auto-refresh (was ~99% of egress)

`app/admin/page.tsx` re-downloaded the **entire student dataset** every 15 s:
full `student_profiles_full` view (profile + `assessment_scores` JSONB +
`resume_parsed` JSONB + `ai_feedback` JSONB per student) + all sessions + all
feedback rows.

The math that kills the free plan:

| Students | Payload/poll | 15 s polling, 8 h/day tab open | Monthly egress |
|---|---|---|---|
| 100 | ~0.5 MB | ~1 GB/day | **~22 GB — 4× over quota** |
| 1,000 | ~5 MB | ~10 GB/day | **~220 GB** |

One admin leaving the tab open overnight could burn the whole 5 GB alone.

**Fixed in code** (see §3): 30 s interval, ~1 KB fingerprint probe per tick,
full download only when data actually changed, 20 s server cache.

### 🟡 #2 — `select('*')` on tables with big JSONB

`assessment_results.scores`, `assessment_results.ai_feedback`,
`resume_analyses.parsed/feedback` and `assessment_sessions.answers` are large
JSON blobs. Any `select('*')` over many rows multiplies them.

**Fixed in code** for the admin paths (narrow column lists). Single-row
per-student reads (`/api/user/scores`, `/api/user/profile`) are small and fine.

### 🟡 #3 — Speaking-audio uploads → Storage

Uploads are *ingress* (free), but they consume the **1 GB storage quota** and
any future playback/download is *egress*. At browser-default ~128 kbps, one
2-minute answer ≈ 1.9 MB → ~500 answers fills the bucket.

**Fixed in code**: recordings are now 32 kbps Opus (~0.5 MB per 2 min, ~4×
smaller). For the long term, move audio out of Supabase — see §5.

### 🟢 #4 — Everything else (negligible today)

- Auth (login/signup/OAuth): a few KB per user. 50 k MAUs included.
- Profile/resume/tracking writes: small rows, writes don't count as egress
  (only the tiny response does).
- Student dashboard refetches: 3 small single-row reads; throttled to
  one re-sync per minute on window focus.
- Realtime: **not used** by this app — nothing to pay here. Do not enable it
  on tables unless you need it (each broadcast counts).

## 3. Code optimisations already applied

| # | Change | Files | Saving |
|---|---|---|---|
| 1 | Check-then-fetch admin polling: `GET /api/admin/students?check=1` returns a ~1 KB fingerprint (counts + latest timestamps); full dataset only on change | `app/admin/page.tsx`, `app/api/admin/students/route.ts`, `lib/adminStudents.ts` (`fetchStudentsFingerprint`) | ~99% of admin egress when idle |
| 2 | Default refresh 15 s → 30 s (still overridable via `NEXT_PUBLIC_ADMIN_REFRESH_MS`) | `app/admin/page.tsx`, `.env.example` | 2× fewer polls |
| 3 | 20 s server-side cache on the full admin payload (collapses concurrent tabs/admins into one Supabase read) | `app/api/admin/students/route.ts` | Nx fewer upstream reads |
| 4 | Narrow view columns: skip unused `resume_feedback` + `assessment_ai_feedback` JSONB; legacy revisions retry with another bounded projection, never `select=*` | `lib/adminStudents.ts` (`VIEW_COLUMNS`) | ~20–40% smaller full payload |
| 5 | Missing-view/schema failures fail closed to local rows instead of downloading all base-table history | `lib/adminStudents.ts` | Prevents outage-amplifying fallback reads |
| 6 | Student dashboard focus re-sync throttled to 1/minute | `app/dashboard/student/page.tsx` | Idle-tab reads |
| 7 | Speaking recordings: 32 kbps Opus + correct extension | `app/assessment/page.tsx` | ~4× smaller audio |

With these, realistic usage fits comfortably: even 2,000 students × ~5 KB
rows ≈ 10 MB per *changed* admin refresh, and idle polling is ~1 KB × 120/h
≈ 3.6 MB/month.

## 4. Supabase dashboard checklist (do this once)

1. **Usage page first**: Supabase Dashboard → your project → *Usage*.
   Watch *Egress*, *Database size*, *Storage* weekly. Spikes almost always
   mean "a client is fetching too much" — now fixed for the admin.
2. **Keep the project alive**: free projects **pause after 7 days without
   traffic**. If this is a live college deployment, any real usage prevents
   it. For staging/idle periods, a free UptimeRobot/cron ping to
   `GET /api/health` every few hours keeps it warm.
3. **Do NOT enable Realtime** on `profiles` / `assessment_*` (Database →
   Replication). The app polls; realtime would duplicate every write as
   billed broadcast messages for zero benefit.
4. **Storage**: create the `speaking` bucket as **private** (admin never
   plays these back today, so no public downloads). If you add playback,
   serve via the CDN/cache headers so it counts as *cached* egress.
5. **Backups**: free plan has none. Export critical data periodically:
   `GET /api/admin/export?scope=all` (CSV) or `pg_dump` via the connection
   string. Keep a copy outside Supabase.
6. **One project, not two**: dev + prod in one free project (or local demo
   mode for dev — this repo runs fully offline with no env vars) to avoid
   splitting quotas.

## 5. File storage: move audio (and resume PDFs) to Cloudflare R2

Supabase gives you **1 GB** of storage. Cloudflare R2's free tier gives you
**10 GB storage + 1 M writes + 10 M reads/month with $0 egress forever**
([pricing](https://leanopstech.com/blog/cloudflare-r2-pricing-2026/),
[free tier](https://nubbo.app/blog/cloudflare-r2-free-tier/)). It speaks the
S3 API, so migration is small:

1. Create a Cloudflare account → R2 → bucket `calibiai-audio` (free tier
   auto-applies, no card needed for free usage).
2. Create an API token (R2 → Manage API tokens) with read/write on that bucket.
3. Server-side, upload via any S3 client (`@aws-sdk/client-s3` pointed at
   `https://<account-id>.r2.cloudflarestorage.com`) — either proxy the
   browser upload through `/api/user/audio` or mint presigned PUT URLs.
4. Keep only the **R2 object key** in Postgres (`storage_key` columns already
   exist for this) — the DB stays tiny.
5. Serve playback through a Worker or presigned GET URLs (still $0 egress).

Rule of thumb: **bytes that users upload/download → R2; rows the app queries
→ Postgres.** This single move removes both the 1 GB storage cap and all
storage egress from Supabase.

## 6. If the database outgrows 500 MB — free options compared

Postgres rows for this app are small (profiles ~1 KB, results ~5–20 KB with
scores JSON). 500 MB holds roughly **25,000–50,000 assessed students**.
If you approach it:

| Option | Free tier (2026) | Fit for this app |
|---|---|---|
| **Stay on Supabase + prune** | 500 MB | Archive old `assessment_sessions.answers` JSONB (the biggest column) to R2 as JSON files, keep scores in Postgres. Often enough forever. |
| **Neon (serverless Postgres)** | 0.5 GB storage + 100 compute-hours/mo per project ([pricing](https://vela.run/articles/neon-serverless-postgres-pricing-2026/)) | Same Postgres wire protocol — nearly a connection-string swap. But same 0.5 GB cap, so a *second* free DB rather than a bigger one. Cold starts (~300 ms) after idle. |
| **Oracle Cloud Always Free** | 2× AMD micro VMs *or* up to 2–4 ARM OCPUs + 12–24 GB RAM, **200 GB disk, 10 TB/mo egress**, 2× 20 GB Autonomous DBs ([limits](https://cloudpricecheck.com/free-tier/oracle)) — with reports the ARM slice was halved to 2 OCPU/12 GB in 2026 ([note](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/)) | The strongest "free forever" box: self-host Postgres (+ the Next.js app itself) on one ARM VM. Most work, zero $ and huge headroom. |
| **Azure Cosmos DB free tier** | 1,000 RU/s + 25 GB **forever**, no expiry ([MS Q&A](https://learn.microsoft.com/en-us/answers/questions/5789143/azure-free-tier-dropped-from-1000-ru-s-included-to)) | NoSQL/document API — would require rewriting queries; only worth it if you're already committed to Azure. |
| **Azure free account** | $200 credit (30 days) + 12 months of B1S VM / 5 GB Blob / SQL 250 GB, then paid ([overview](https://klymentiev.com/blog/free-azure-credits)); Students get $100, no card | Good for a 1-year runway, not "free forever". |
| **Self-host Supabase** | Unlimited (your hardware) | Same API, zero quotas — needs a VPS (Oracle free VM above, or ~₹400/mo Hetzner). Best when you need Supabase Auth/Storage APIs at scale. |

 Honest recommendation for *this* app, in order:

1. **Now**: stay on Supabase free (fits with the §3 fixes) + move audio to R2.
2. **At ~400 MB DB**: archive `answers` JSONB to R2, keep everything else.
   Stays free indefinitely for most colleges.
3. **At real scale (50 k+ students)**: self-host Postgres on an Oracle Always
   Free ARM VM (or one cheap VPS) and point the server client at it; keep
   Supabase Auth or switch to any JWT auth. Files stay on R2 either way.

## 7. Egress hygiene rules (for future code)

1. **Never `select('*')` on a table with JSONB in a loop or poll.** List columns.
2. **Never poll a full dataset.** Poll a count/hash/fingerprint; fetch full on change.
3. **Paginate admin tables** once you pass ~5,000 students (server-side
   `range()` + search in SQL instead of shipping all rows to the browser).
4. **Uploads go to R2; Postgres stores keys, not bytes.**
5. **Cache aggressively**: the 20 s admin cache pattern works for any
   dashboard endpoint. API requests are unlimited — bytes are not.
6. **Watch Usage weekly** after every deploy that touches data fetching.
