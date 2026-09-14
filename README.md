# CALIBIAI SCORE — Global Student Assessment & Placement Readiness Platform

> **The credit score for employability. 1000-point unified, portable, trusted standard.**  
> Architected from day one for 100M+ students across 50+ countries — zero external SaaS, fully self-hosted, multi-region, horizontally scalable.

[![Architecture](docs/ARCHITECTURE.md)] [![DB](docs/DATABASE.md)] [![API](docs/API_SPEC.md)] [![Scoring](docs/SCORING.md)]

---

## 🚀 Quick Start (Local Parity)

```bash
npm install
npm run dev   # http://localhost:3000  (binds 0.0.0.0, preview at https://3000-*.e2b.app)
```

**Demo flow:** `/login` → (new account: signed in and sent straight to `/onboarding`) → Profile → Resume (mock LLaMA analysis) → WhatsApp → LinkedIn → Confirmation → Instructions → **Start 120-min timer** → 6 modules → Submit → **Student dashboard** (`/dashboard/student`, with the CalibiAI Score /1000, full report + PDF right there)

No external keys required. With no keys set the app runs in **fully local demo mode** (localStorage + built-in rule-based scoring); add keys to switch on real persistence and AI grading.

### 🔐 Admin dashboard — `/admin`

Admin-only view of **every student** (works on any domain — `http://localhost:3000/admin` locally, `https://<your-domain>/admin` when deployed):

- **Login:** username `admin`, password `CalibiAdmin@777` (fixed; session is an HttpOnly signed cookie, expires after 8 h).
- **Filters:** by college (dropdown) and free search across name / email / PRN / mobile / college, plus an "assessed only" toggle.
- **Candidate feedback:** every candidate's post-assessment feedback (1–5 stars + comment, from `/feedback`) is written by `POST /api/feedback` to Supabase (`feedback_submissions`) — the database is the only destination, there is no third-party form service in the path — and shown per student: star rating in the table row, full rating/comment/date/count in the expanded row, plus 4 columns in the CSV. Feedback is matched to a student by id **or** email, so it works whether the candidate is a Supabase account or a local demo id. A submission is never lost and never blocks the candidate: if Postgres is unreachable the row is queued server-side (`synced: false`) and `POST /api/feedback/flush` delivers it on the next visit, while the candidate still gets a `200` and goes straight to their dashboard and report.
- **Help requests:** messages from the in-app help form go to `POST /api/help` → Supabase (`help_requests`) — no external form provider, so no monthly submission limit — and are listed in a **Help requests** panel at the bottom of `/admin`. Same queue-and-retry behaviour as feedback.
- **Download CSV:** one click exports the full dataset or the currently filtered view — Name, PRN, mobile number, email, college, degree, CGPA, profile + resume + merged skills, resume score, **every** CalibiAI module/sub-skill score (English listening/speaking/reading/writing, Problem Solving, AI Debugging, AI Feature, Prompt Eng, Cognitive grid/logical + 6 behavioural traits), percentile, grade, assessment date and the candidate's own feedback (52 columns, Excel/Sheets ready).
- **Live:** the table checks for new data every 30 s while the tab is open (and on tab focus), so new sign-ups, scores and resumes appear without a manual reload. Each check is a ~1 KB fingerprint probe (`GET /api/admin/students?check=1`) — the full dataset is re-downloaded only when something actually changed, and the server caches the full payload for 20 s, so an idle admin tab costs almost zero Supabase egress. Set `NEXT_PUBLIC_ADMIN_REFRESH_MS` (e.g. `5000` for 5 s) to change the interval. A `Live` badge shows the last sync time. See `docs/SUPABASE_FREE_TIER.md` for the full egress-optimisation guide.
- **Both stores, merged:** the dashboard reads Supabase (`student_profiles_full` view) **and** the local JSON store (`calibiai_db.json` / `calibiai_db.runtime.json`) on every load, then merges them, so nothing is hidden by picking one backend: `profiles` rows that only exist in Postgres (students who signed up through the app) and candidates that only exist in the local file (the seeded/demo accounts, whose `u_…` ids are not valid UUIDs and were never inserted into Postgres) all appear together. A live row always wins over a local row for the same student (matched by id, or by email when the ids differ). The "Total students" card shows the split (`N live · M local`) and a banner spells it out; the CSV export contains the same merged set.
- Supabase is queried first; if the view has not been created yet the dashboard falls back to joining the `profiles` / `resume_analyses` / `assessment_results` tables directly (and shows an explanatory banner). A Supabase error no longer hides the local rows — the notice and the local candidates are shown together. To read **every** live student the admin should use a `SUPABASE_SERVICE_ROLE_KEY` — without it the anon key is used and Row Level Security can hide rows from the admin.
- **Write the local candidates into Supabase** (one click, or from the CLI): when candidates exist only locally the dashboard shows a **“Write candidates into Supabase”** button. It creates a real auth account per candidate (grouped by email — Supabase allows one account per email, so the newest profile/session/result/resume/feedback per email is used), then upserts their profile, assessment sessions/results, resume analyses and feedback. It is **idempotent** (ids are derived deterministically from the local ids) and needs the service-role key, because only the Auth Admin API can create accounts. The same job from a shell:
  ```bash
  SUPABASE_SERVICE_ROLE_KEY=… NEXT_PUBLIC_SUPABASE_URL=… npm run seed:supabase          # apply
  SUPABASE_SERVICE_ROLE_KEY=… NEXT_PUBLIC_SUPABASE_URL=… npm run seed:supabase -- --dry # preview
  ```
  API: `GET /api/admin/sync` (dry-run plan) and `POST /api/admin/sync` (apply), both cookie-protected.
- **Database setup:** run `supabase/schema.sql` on a fresh project, or the migrations in `supabase/migrations/` in order on an existing one. `0004_feedback_submissions.sql` adds the `feedback_submissions` table the dashboard's feedback column needs, `0005_help_requests.sql` adds `help_requests` for the help form, and `0006_admin_attempted_and_stats.sql` adds the `assessment_attempted` flag plus the `admin_stats` aggregate the admin dashboard pages against (the app keeps working without any of them — those submissions are queued until the table exists — the dashboard just falls back to scanning more rows until they are applied).
- Raw data is also served at `GET /api/admin/export?scope=all|filtered&college=&q=` (cookie-protected).
- **Pull everything straight out of Supabase:** `supabase/queries/student_full_report.sql` is a ready-to-run SQL file for the Supabase SQL editor — one row per student with the CalibiAI Score, grade, percentile, **every** module and behavioural score expanded out of the `scores` JSONB, raw correct/total counts, AI feedback, resume score and parsed skills, the candidate's feedback (matched by id **or** email) and their help requests, plus auth status and community steps. It includes ready filters (one student / one college / score band / not-yet-assessed), an optional `create view public.student_reports_full`, and a college-averages aggregate. `npm run verify:sql` runs that file against a real PostgreSQL (PGlite — Postgres in WASM, built from `supabase/schema.sql` + the migrations, seeded with scored / partially-submitted / not-started students) and asserts every column: 9 checks.
- Set `ADMIN_SECRET` (any long random string) in production to sign admin sessions.

### Student self-service (`/dashboard/student` → Edit / Resume)

- **Edit profile →** `/edit-profile` is a dedicated, one-page editor (not the onboarding wizard). Returning users edit any field, it saves to the same backend, and they land back on their dashboard. Onboarding stays a **one-time** step: the routing logic (`lib/nextStep.ts`, `/register` login/Google paths, and the `/onboarding` guard) never sends a user whose profile is already complete back into the onboarding flow.
- **Update resume →** `/resume?edit=1` is the standalone "update your resume" view (no onboarding stepper, no WhatsApp continue step). The `?edit=1` flag keeps the linear onboarding flow (`/onboarding` → `/resume` → WhatsApp) intact for new users while giving returning users a focused update page.
- Scores are live: the student dashboard re-fetches profile / resume / scores on window focus (and on mount), and the edit/update pages write through the shared store, so a change shows up immediately.

### Optional configuration (`.env.local`)

Copy `.env.example` → `.env.local`:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Auth + Postgres (sessions, profiles, results) + Storage (resumes, speaking audio). Run `supabase/schema.sql` in the Supabase SQL editor first. |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional, server-side only. Lets the API routes create confirmed users and mirror onboarding (mobile, gender, degree…), resume analyses and tracking events into Postgres bypassing RLS. Never expose it client-side. |
| `CALIBIAI_API_KEY` | CalibiAI AI grading of writing / speaking transcript / debugging / feature / prompts. **Server-side only** (`/api/ai/evaluate`); falls back to a rule engine when absent. |

When Supabase is configured: email + password live in **Supabase Auth** (`auth.users`), a `profiles` row is auto-created on sign-up and every onboarding field (mobile number, PRN, gender, degree, college, CGPA, skills, links), resume analysis and WhatsApp/LinkedIn tracking event is mirrored to Postgres by the API routes (service-role writes when `SUPABASE_SERVICE_ROLE_KEY` is set). The browser session is handed to supabase-js after login so RLS and Storage uploads work client-side. **Each student gets their own isolated assessment session** (server-side row, one active session per student, RLS-protected), answers + results persist to Postgres and recordings/resumes go to Storage buckets. When the CalibiAI grader is configured, every subjective section shows an "✨ Evaluate with AI" button that returns a rubric score, strengths and improvement notes (otherwise a deterministic heuristic runs).

### Google sign-in & custom domains

Google login is Supabase OAuth with the **PKCE** grant (`flowType: 'pkce'` in `lib/supabase.ts`), so Supabase returns `?code=` to `/auth/callback` and `app/auth/callback/page.tsx` exchanges it for a session. PKCE is pinned explicitly because supabase-js defaults to the *implicit* grant, which returns the session in the URL **fragment** (`#access_token=…`) — the callback exchanges a `?code=`, so under the default every Google login silently bounced back to `/login`. The callback still handles the implicit fragment as a fallback, and any failure is now shown on screen instead of being swallowed.

No domain is hard-coded anywhere: `redirectTo` is built from `window.location.origin` (`app/login/page.tsx`) and every other navigation is a relative path. Deploying to a new domain therefore requires **only** a Supabase dashboard change — Auth → URL Configuration:

| Setting | Value |
|---|---|
| Site URL | `https://assessment.calibiai.com` |
| Redirect URLs | `http://localhost:3000/auth/callback`, `https://assessment.calibiai.com/auth/callback` |

Add one Redirect URL entry per origin the app is served from. A `redirectTo` that is not on the list is ignored and Supabase falls back to the Site URL, which reproduces the login loop. Google Cloud Console needs no per-domain change — Supabase is the OAuth client, so its Authorized redirect URI stays `https://<project-ref>.supabase.co/auth/v1/callback`.

`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` must also be set on the hosting platform; without the two public ones `lib/supabase.ts` degrades to local demo mode and the Google button reports "not configured".



- All questions live in **`data/questions.json`** (the database seed source) — medium-to-hard, organized in the 6 stages / suggested allocation 15+20+20+25+15+25 = 120 min.
- **Listening** uses real, playable audio (`public/audio/`) with a **2-play limit** per clip.
- **Speaking** records the microphone (MediaRecorder) and uploads to Supabase Storage; production pipeline is recording → Whisper transcript → CalibiAI rubric.
- **MCQ options are shuffled per session**: every session gets a random `question_seed`; option order is derived deterministically from that seed (stable for the student, different across students, re-render safe). Answers are stored as the option *text*, so shuffling never affects scoring.

---

## 🎯 Flowstrict (Millions Concurrent)

```
LOGIN → PROFILE → RESUME UPLOAD → RESUME ANALYSIS (AI) → JOIN WHATSAPP (tracked) → FOLLOW LINKEDIN (tracked) → CONFIRMATION → INSTRUCTIONS → START 120-MIN TIMER (server-controlled) → 6 MODULES → SUBMIT → AI+EVALUATION (queue) → CALIBIAI /1000 → PDF → DASHBOARDS (Student/Faculty/Institution)
```

**Modules:** English (Listening/Speaking/Reading/Writing), Problem Solving, AI Debugging, AI Feature Dev, Prompt Eng, Cognitive (Motion Grid + Logical + Behavioral).

---

## 📚 Deliverables (Production-Ready)

| Doc | Description |
|-----|-------------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Multi-region, multi-tenant, zero-SaaS topology (Anycast, Kong, sharding, Redpanda, MinIO, GPU fleet) |
| [DATABASE.md](docs/DATABASE.md) | Postgres 16 schema + 1024 logical shards → 32 physical, partitioning, Redpanda topics |
| [API_SPEC.md](docs/API_SPEC.md) | REST endpoints (auth, profile, resume, tracking, assessment, scores, reports, dashboards, enterprise verify) |
| [AI_EVALUATION.md](docs/AI_EVALUATION.md) | Rule + self-hosted LLM/Whisper pipeline, Triton/vLLM, batch, autoscaling, pseudo-code |
| [SCORING.md](docs/SCORING.md) | Weighted formula: Eng 200 + PS 200 + Debug 150 + Feature 150 + Prompt 100 + Cognitive 200 = 1000 |
| [UI_SPEC.md](docs/UI_SPEC.md) | Screen breakdown for all roles, timer, grid, editor, audio |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Self-hosted K8s, Terraform, Harbor, Vault, Mimir/Loki/Jaeger, blue-green, DR |
| [FOLDER_STRUCTURE.md](docs/FOLDER_STRUCTURE.md) | Frontend + backend microservices layout |
| [SUPABASE_FREE_TIER.md](docs/SUPABASE_FREE_TIER.md) | Staying on Supabase free: egress optimisation, quotas, free storage/DB alternatives |
| [SAMPLE_RESPONSES.md](docs/SAMPLE_RESPONSES.md) | JSON samples for every endpoint |

---

## 🧱 Tech (Mandatory, Hyperscale Day 0)

**Frontend:** Next.js 14 (self-hosted, edge-cached, owned CDN) • React • Tailwind • Recharts • jsPDF  
**Backend:** Node.js microservices (Kong gateway, regional sharding) • Python eval workers  
**DB:** PostgreSQL 16 Patroni + read replicas + sharding (100M+), Redpanda (Kafka), Redis Cluster, ClickHouse  
**AI:** Self-hosted LLaMA 3.1 8B/70B (vLLM+Triton) + Whisper Large v3 (faster-whisper), GPU autoscaling via KEDA  
**Storage:** MinIO (S3, erasure 8+4, CDN-fronted, multi-region)  
**Auth:** Custom JWT RS256 + Argon2id, Vault, institutional SAML/OIDC federation (no Auth0)

---

## 🔐 Security & Control

- Timer **server-controlled** (NTP, HMAC-signed, Redis cache but Postgres source, reconciled 5s, clock-skew-resistant)
- Tab-switch / anomaly detection (Isolation Forest on owned behavioral data)
- Full audit trail (Kafka → ClickHouse, 7yr)
- Encryption at rest + in transit + column-level, data-residency aware (list partition)

---

## 📊 Dashboards

- **Student:** score breakdown, radar, strengths/weaknesses, resume feedback, history, improvement plan
- **Faculty:** batch avg, median, top performer, distribution, student table, module heatmap, bulk PDF zip
- **Institution/Enterprise:** cross-institution benchmarking, cohort analytics, bulk hiring pipeline (min_score filter), **verified score API** + webhook + API key

---

## 📄 PDF Report (Async)

`POST /reports/:id/generate` → queue → Puppeteer/jsPDF worker → MinIO → CDN. Includes student details, section scores, cognitive profile, behavioral insights, strengths/weaknesses, hiring recommendation, verifiable hash QR.

---

## 🌍 Deployment (Self-Hosted, Multi-Region)

```bash
# Local parity — all services
docker-compose up --build

# Prod — Terraform + ArgoCD
terraform -chdir=infra/terraform/regions apply
kubectl apply -k infra/k8s/
```

3 active-active regions (us-east-1, eu-west-1, ap-south-1) • GeoDNS Anycast • RTO 60s • RPO <5s • KEDA autoscaling (exam windows: 5M concurrent, 480 GPUs pre-warmed).

---

## 🧪 Scoring Example

```
Priya: Eng 172 + PS 168 + Debug 132 + Feature 128 + Prompt 88 + Cognitive 154 = 842 /1000 → Grade A (92.4 percentile)
Behavioral: Adaptability 88, Accountability 91, Teamwork 76 → Recommendation: Interview-ready
Verifiable: sha256(user:score:salt) → enterprise POST /enterprise/verify
```

See [SCORING.md](docs/SCORING.md) + [lib/scoring.ts](lib/scoring.ts).

---

## 🔬 No External SaaS

No Firebase, Auth0, OpenAI, managed Whisper. All IP owned — unit economics hold at 100M users. Search `lib/scoring.ts` or `docs/AI_EVALUATION.md` for self-hosted interfaces.

---

## 📦 Workshop

- `lib/scoring.ts` — auditable, deterministic engine used client+server
- `lib/mockData.ts` — versioned question banks
- `lib/store.tsx` — JWT + tenant isolation

---

## 🏛️ Path to IPO

Built for Series-A→IPO scaling: sharding, event streaming, owned inference, verifiable credential infra that other EdTech/HR-tech plug into. The default readiness layer between education and hiring.

---

**Live preview:** `npm run dev` then open preview host (port 3000). All docs in `/docs`.
