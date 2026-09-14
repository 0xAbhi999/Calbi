# Running 5,000 concurrent assessments without breaking (MilesWeb Node.js plan)

> Senior-architect review of what would break under a 5,000-candidate exam
> window, what was fixed in this repo, and how to verify + operate it.

---

## 1. What actually runs in production (vs. what the docs dream about)

The `docs/DEPLOYMENT.md` / `docs/ARCHITECTURE.md` files describe an aspirational
Kubernetes + Kong + Redpanda + GPU stack. **None of that is wired to the running
code.** What actually ships to MilesWeb is a single Next.js app:

```
GitHub Actions → SSH → npm ci && npm run build → `next start` (ONE Node process)
```

A single `next start` process uses **one CPU core** and has no protection
against concurrent writes. At 5,000 simultaneous candidates that means:

| # | Failure point | Symptom at 5k users |
|---|---|---|
| 1 | One Node process | Box saturates 1 core; every other core idles → timeouts |
| 2 | `lib/db.ts` JSON store | Every autosave/session/submit did a full **synchronous** read + rewrite of one file with **no locking** → lost updates, torn files, event-loop stalls |
| 3 | `/runtests` forks a subprocess | Unbounded forks → process-table exhaustion / fork bomb |
| 4 | AI endpoints, no timeout | A hung LLM pins request handlers → connection-pool exhaustion |
| 5 | Autosave on every keystroke | Write storm on the store |
| 6 | `/api/health` returns hardcoded "all up" | A load balancer can't trust it |

This doc covers the fixes for each.

---

## 2. What was changed (in this repo)

### 2.1 Load balancer (the "if not implemented" ask)

- **`ecosystem.config.cjs` (new)** — PM2 **cluster mode**, `instances: 'max'`
  (one Next.js server per CPU core). PM2's built-in round-robin is the load
  balancer that actually works on a single MilesWeb Node box. Set
  `WEB_CONCURRENCY=n` in the server `.env` to pin an exact worker count on
  small shared plans.
- **`infra/nginx.conf` (new)** — the next step when one box isn't enough:
  reverse-proxy + `least_conn` load balancing across **multiple app
  instances/boxes**, TLS, static-asset caching, request buffering, body limits,
  a whole-box rate limit, and health-aware draining.
- **`.github/workflows/deploy.yml`** — now restarts with
  `pm2 startOrReload` (zero-downtime rolling restart), falling back to the old
  single-process restart if PM2 isn't installed.

### 2.2 Concurrency-safe data store (`lib/db.ts`)

The old store was rewritten to be safe under concurrent writes **with the same
public API** (zero changes needed in callers):

- **In-memory cache** — reads are O(1) after first load (mtime revalidated so
  other workers' writes stay visible).
- **Coalesced writes** — a keystroke burst collapses into one flush instead of
  one per event.
- **Cross-process mutex** — an O_EXCL lockfile serialises writers *across* PM2
  workers (atomic on Linux, with stale-lock recovery).
- **Atomic writes** — temp file + rename, so a crash can never leave a torn
  file and readers never see a half-written JSON.
- **Merge-by-id** — a worker never erases another worker's concurrently
  inserted rows.
- **`flushDB()`** — the session-start and final-submit routes await a forced
  flush, so the two writes that must not be lost are durable before responding.

> Note: the JSON store is now *correct* and *fast*, but it is still a single
> file. For 5,000 concurrent it is fine. For 50,000+, move the store to
> Supabase Postgres (already supported — set `NEXT_PUBLIC_SUPABASE_URL` /
> `SUPABASE_SERVICE_ROLE_KEY`) and the JSON file becomes the demo fallback.

### 2.3 Resource ceilings (graceful degradation instead of crashes)

- **`/api/user/assessment/runtests`** — capped at **8 concurrent subprocesses
  per worker**; beyond that returns `429 + Retry-After` instead of forking.
- **`/api/user/resume/analyze`** — capped at **4 concurrent parses per
  worker**.
- **`/api/ai/evaluate`**, **`/api/ai/assistant`**, **`/api/user/resume/analyze`**
  — outbound LLM calls now have a **hard timeout** (15–20s) via
  `lib/fetchTimeout.ts`; on timeout they fall back to the local heuristic
  engine instead of hanging.

### 2.4 Rate limiting (`lib/rateLimit.ts`)

- **Per-email** brute-force backstop on `/api/auth/login` (10/min) and
  `/api/auth/signup` (5/min).
- **Per-IP abuse backstops** on the hot exam endpoints — deliberately
  *generous* (1000–2000/min) because **a whole college often sits behind one
  NAT IP**, and per-IP throttling must never punish innocent candidates. The
  fair gate is the per-process concurrency limiters above, not the IP limit.

### 2.5 Client autosave debounce

`app/assessment/page.tsx` now debounces the server autosave ~1.5s after the
last keystroke (was: one POST per keystroke). The final submit persists
everything, so nothing is lost — this alone removes most of the write load.

### 2.6 Honest health endpoint

`/api/health` now reports real state (store writable, memory, uptime, pid) and
returns **503 when the worker can't write its store**, so nginx/PM2/ALB can
drain a bad node instead of routing to it.

---

## 3. Capacity math for 5,000 concurrent

Assume a mid VPS: 8 vCPU / 16 GB.

- **Workers:** `instances: 'max'` → 8 workers. ~625 candidates per worker.
- **Autosave rate:** 5,000 students typing → ~1 debounced save every ~2–3s
  each ≈ **~2,000 writes/sec** peak, spread over 8 workers = 250/s each. Each
  write is now an in-memory mutation + one coalesced atomic file write — well
  within budget.
- **Grading:** heuristic grading is CPU-light; AI grading is bounded by the
  upstream + 15s timeout. The 8-slot runtests limiter means at most 64
  subprocesses box-wide at once (8 workers × 8) — safe.
- **Rule of thumb:** p95 < 500ms and < 1% errors at your target concurrency
  means you have headroom. If not, add workers/boxes behind nginx.

---

## 4. Verify it end to end (the "check end to end" ask)

### 4.1 Unit + type + build gates (CI)

```bash
npm test            # 115 tests incl. store/concurrency/rate-limit
npx tsc --noEmit    # type-check
npm run build       # production build
```

### 4.2 Load test — no dependencies

```bash
npm run build && npm run start           # or: pm2 startOrReload ecosystem.config.cjs

# 5000 users for 60s against localhost:
USERS=5000 DURATION_SEC=60 RAMP_SEC=20 TARGET=http://localhost:3000 npm run loadtest
```

### 4.3 Load test — k6 (full exam ramp, thresholds)

```bash
k6 run scripts/loadtest.k6.js --vus 5000 --duration 2m -e TARGET=http://localhost:3000
```

Read the output for p95 latency, error rate, and the 429 count (429 with
`Retry-After` is *backpressure working as designed*, not a crash).

---

## 5. Server setup (one time)

```bash
# On the MilesWeb Node box:
npm i -g pm2
cd ~/know-yourself
npm ci --include=dev && npm run build
mkdir -p logs
pm2 startOrReload ecosystem.config.cjs   # cluster mode, one worker per core
pm2 save && pm2 startup                  # survive reboots
```

If the shared plan is small, cap workers in the server `.env`:
`WEB_CONCURRENCY=2`.

---

## 6. Failure-mode playbook

| Symptom | Cause | Fix |
|---|---|---|
| `429 Too Many Requests` on runtests/evaluate | Concurrency/rate limiter (by design) | It's backpressure; the client retries. Raise the cap only if you have headroom. |
| `/api/health` returns 503 | Worker can't write its store (disk full/read-only) | Free disk, fix permissions; LB auto-drains it. |
| High latency, low CPU | One process (PM2 not used) | `pm2 startOrReload ecosystem.config.cjs`. |
| Box at 100% CPU | Need more than one box | Add instances to `infra/nginx.conf` upstream. |
| Upstream LLM down | Timeout → heuristic fallback | Candidates still get rule-based scores; fix the key/endpoint. |
| Runtime JSON file corrupt | Crash mid-write (should no longer happen) | Atomic rename prevents torn writes; delete `calibiai_db.runtime.json` to reseed from `calibiai_db.json`. |

---

## 7. Pre-exam checklist

- [ ] `npm test` + `tsc --noEmit` + `npm run build` green.
- [ ] PM2 cluster running (`pm2 status` shows N workers, no restarts).
- [ ] `curl -s localhost:3000/api/health` → `{"status":"ok","ready":true}`.
- [ ] Ran `npm run loadtest` at 1.5× expected concurrency; p95 < 500ms, errors < 1%.
- [ ] (Multi-box) nginx upstream health checks passing.
- [ ] `WEB_CONCURRENCY` sized to the plan's CPU/process limits.
- [ ] Supabase configured if you expect > ~10k concurrent or need cross-box data.
