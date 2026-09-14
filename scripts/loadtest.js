#!/usr/bin/env node
/**
 * Zero-dependency load test for CalibiAI Score.
 *
 * Simulates N concurrent candidates against a running server and reports
 * throughput + latency percentiles + error breakdown. Use it BEFORE an exam
 * window to prove the box survives the expected concurrency.
 *
 * Usage:
 *   node scripts/loadtest.js                          # defaults: 2000 users, 30s
 *   USERS=5000 DURATION_SEC=60 TARGET=http://localhost:3000 node scripts/loadtest.js
 *
 * It exercises the three hot paths that matter at exam time:
 *   - GET  /api/health                    (LB probe / connectivity)
 *   - POST /api/user/assessment           (autosave — the write-heavy path)
 *   - POST /api/ai/evaluate               (grading — heuristic, no key needed)
 *
 * These don't need auth, so it works against a fresh deploy. Each "user" also
 * calls GET / once (the assessment page) to exercise page serving.
 */

const TARGET = (process.env.TARGET || 'http://localhost:3000').replace(/\/+$/, '')
const USERS = parseInt(process.env.USERS || '2000', 10)
const DURATION_SEC = parseInt(process.env.DURATION_SEC || '30', 10)
const RAMP_SEC = parseInt(process.env.RAMP_SEC || '10', 10)

const samples = []
const statusCounts = new Map()
let errors = 0
let requests = 0

function pct(p) {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

async function request(path, opts) {
  const t0 = process.hrtime.bigint()
  let status = 0
  try {
    const res = await fetch(TARGET + path, opts)
    status = res.status
    await res.arrayBuffer().catch(() => {})
    if (status >= 500) errors += 1
    else if (status === 429) errors += 1 // rate-limited counts as "backpressure", still flagged
  } catch (e) {
    errors += 1
    status = -1
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  samples.push(ms)
  statusCounts.set(status, (statusCounts.get(status) || 0) + 1)
  requests += 1
}

function autosaveBody() {
  return {
    session_id: 'sess_loadtest_' + Math.random().toString(36).slice(2, 10),
    answers: {
      WRITING: 'Dear client, thank you for your patience. The release timeline has shifted due to an unexpected outage. We are mitigating the impact by reallocating resources and will deliver a revised timeline shortly. Regards, Candidate '.repeat(3),
    },
    status: 'in_progress',
  }
}

async function oneUser(id) {
  // First request: the page + a warm-up autosave.
  await request('/', { method: 'GET' })
  await request('/api/user/assessment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(autosaveBody()),
  })
  const end = Date.now() + DURATION_SEC * 1000
  let i = 0
  while (Date.now() < end) {
    const kind = i % 4
    if (kind === 0) await request('/api/health')
    else if (kind === 1) {
      await request('/api/user/assessment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(autosaveBody()),
      })
    } else if (kind === 2) {
      await request('/api/ai/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'writing', text: 'Dear client, we sincerely apologise for the delay. The unexpected outage impacted our pipeline; we are mitigating by adding redundancy and will share a revised timeline within 24 hours. Best regards, Candidate '.repeat(2), scenario: 'A client escalation about a delayed release.' }),
      })
    } else {
      await request('/', { method: 'GET' })
    }
    i += 1
  }
}

async function main() {
  console.log(`Load test → ${TARGET}`)
  console.log(`users=${USERS}  duration=${DURATION_SEC}s  ramp=${RAMP_SEC}s`)
  const t0 = Date.now()

  // Ramp users in over RAMP_SEC.
  const workers = []
  let spawned = 0
  const rampInterval = RAMP_SEC > 0 ? RAMP_SEC * 1000 / USERS : 0
  await new Promise((resolve) => {
    const spawner = setInterval(() => {
      if (spawned >= USERS) {
        clearInterval(spawner)
        resolve()
        return
      }
      workers.push(oneUser(spawned))
      spawned += 1
    }, rampInterval || 1)
  })

  await Promise.all(workers)
  const elapsedSec = (Date.now() - t0) / 1000

  console.log('\n================ RESULTS ================')
  console.log(`Total requests : ${requests}`)
  console.log(`Throughput     : ${(requests / elapsedSec).toFixed(1)} req/s`)
  console.log(`Errors         : ${errors} (${((errors / Math.max(1, requests)) * 100).toFixed(2)}%)`)
  console.log(`Latency p50    : ${pct(50).toFixed(0)} ms`)
  console.log(`Latency p90    : ${pct(90).toFixed(0)} ms`)
  console.log(`Latency p95    : ${pct(95).toFixed(0)} ms`)
  console.log(`Latency p99    : ${pct(99).toFixed(0)} ms`)
  console.log(`Latency max    : ${Math.max(...samples).toFixed(0)} ms`)
  console.log('\nHTTP status breakdown:')
  for (const [s, n] of [...statusCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${s === -1 ? 'connection-error' : s}  ${n}`)
  }
  console.log('\nGuideline: p95 < 500ms and errors < 1% means the box is healthy at this concurrency.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
