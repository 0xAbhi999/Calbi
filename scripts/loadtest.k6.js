// k6 load test — realistic 5000-candidate exam ramp.
//
// Run (after installing k6: https://k6.io/docs/get-started/installation):
//   k6 run scripts/loadtest.k6.js --vus 5000 --duration 2m -e TARGET=http://localhost:3000
//
// It ramps users up like a real exam start (everyone logs in within the first
// minutes), then holds. Thresholds fail the run if the box degrades.

import http from 'k6/http'
import { check, sleep } from 'k6'

const TARGET = __ENV.TARGET || 'http://localhost:3000'

export const options = {
  scenarios: {
    exam_burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 5000 }, // 5000 candidates start within a minute
        { duration: '3m', target: 5000 }, // hold the full exam window
        { duration: '1m', target: 0 },    // drain
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],   // 95% of requests under 500ms
    http_req_failed: ['rate<0.01'],     // under 1% failures
    'http_req_duration{staticAsset:true}': ['p(95)<300'],
  },
}

function autosaveBody() {
  return JSON.stringify({
    session_id: 'sess_k6_' + (__VU + '-' + __ITER),
    answers: {
      WRITING: 'Dear client, thank you for your patience. The release timeline has shifted due to an unexpected outage. We are mitigating the impact by reallocating resources and will deliver a revised timeline shortly. Regards, Candidate '.repeat(3),
    },
    status: 'in_progress',
  })
}

export default function () {
  // 1. The candidate loads the exam.
  const page = http.get(TARGET + '/', { tags: { name: 'assessment_page' } })
  check(page, { 'page 200': (r) => r.status === 200 })

  // 2. Autosave (the write-heavy path).
  const save = http.post(TARGET + '/api/user/assessment', autosaveBody(), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'autosave' },
  })
  check(save, { 'autosave ok': (r) => r.status === 200 })

  // 3. An AI evaluation (heuristic fallback when no key is set).
  const evalBody = JSON.stringify({
    kind: 'writing',
    text: 'Dear client, we sincerely apologise for the delay. The unexpected outage impacted our pipeline; we are mitigating by adding redundancy and will share a revised timeline within 24 hours. Best regards, Candidate '.repeat(2),
    scenario: 'A client escalation about a delayed release.',
  })
  const ev = http.post(TARGET + '/api/ai/evaluate', evalBody, {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'ai_evaluate' },
  })
  check(ev, { 'eval ok': (r) => r.status === 200 })

  // 4. Health probe (what the LB watches).
  const health = http.get(TARGET + '/api/health', { tags: { name: 'health' } })
  check(health, { 'health ok': (r) => r.status === 200 })

  sleep(3) // each candidate acts every ~3s
}
