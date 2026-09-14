// Test-runner endpoint for the coding modules. Runs the candidate's submitted
// code against the real hidden tests in an isolated subprocess and returns the
// actual pass count (never a length-based guess).
//
// Load hardening: this endpoint forks a `node`/`python3` child per call, so it
// is the most dangerous thing to let run unbounded during a 5000-candidate
// burst (process-table exhaustion / fork bomb). It is therefore capped by:
//   - a per-process concurrency limiter (beyond which we 429 + Retry-After), and
//   - a per-IP rate limit.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { runTests } from '@/lib/runTests'
import { createLimiter } from '@/lib/concurrency'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'

// At most N concurrent subprocesses per Node worker (per PM2 instance). 8 ×
// workers keeps a busy box responsive while still serving hundreds/sec.
const TEST_RUNNER_LIMIT = 8
const testLimiter = createLimiter(TEST_RUNNER_LIMIT)

// Per-IP *abuse backstop* only. Candidates often share one college/NAT egress
// IP, so this must stay generous — the real, fair gate is the concurrency
// limiter above (it caps how many subprocesses run at once regardless of who
// sends them). This just stops a single scripted source from hammering us.
const RATE_LIMIT = 2000
const RATE_WINDOW_MS = 60_000
// Ignore implausibly large code payloads outright (protects parsing + the child).
const MAX_CODE_BYTES = 64 * 1024

export async function POST(req: Request) {
  const ip = getClientIp(req)
  const rl = checkRateLimit(`runtests:${ip}`, RATE_LIMIT, RATE_WINDOW_MS)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many test runs — slow down.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const taskId = String(body?.task_id || '').trim()
  const code = String(body?.code || '')
  if (!taskId) return NextResponse.json({ error: 'Missing task_id' }, { status: 400 })
  if (code.length > MAX_CODE_BYTES) {
    return NextResponse.json({ error: 'Code is too large to run.' }, { status: 413 })
  }

  if (!testLimiter.tryAcquire()) {
    return NextResponse.json(
      { error: 'Test runner is busy — please try again in a few seconds.' },
      { status: 429, headers: { 'Retry-After': '3' } },
    )
  }
  try {
    const result = await runTests(taskId, code)
    return NextResponse.json({ ok: true, ...result })
  } catch (e: any) {
    return NextResponse.json({ error: 'test run failed', detail: String(e?.message || e) }, { status: 500 })
  } finally {
    testLimiter.release()
  }
}
