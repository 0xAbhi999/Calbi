/**
 * Server-side Supabase writes must go out AS the signed-in student.
 *
 * `profiles` / `resume_analyses` / `tracking_events` / `assessment_*` are all
 * RLS-scoped to `auth.uid() = id`, so a server client built from the anon key
 * alone has no `auth.uid()` and every write is rejected with 42501 — the
 * student saw "Saved" while Postgres kept only the name/email seeded by the
 * sign-up trigger. These tests pin the two halves of the fix:
 *
 *   1. lib/supabaseServer.ts forwards the caller's access token (real
 *      supabase-js client → in-process PostgREST stand-in that records headers).
 *   2. lib/persist.ts reports WHY a write failed instead of swallowing it.
 *
 * Separate file on purpose: getServerClient() memoises per process and the
 * Supabase env must be set before the module is first read.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54398'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
delete process.env.SUPABASE_SERVICE_ROLE_KEY

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  bearerToken,
  getClientForRequest,
  getClientForToken,
  hasServiceRoleKey,
  resetRequestClients,
} from '../supabaseServer.ts'
import {
  persistAssessmentResultDetailed,
  persistAssessmentSessionDetailed,
  persistProfileDetailed,
  persistTrackingEventDetailed,
  syncWarning,
} from '../persist.ts'

const PORT = 54398
/** Headers PostgREST received, per request, so the token plumbing is visible. */
const seen: Array<{ method: string; url: string; authorization?: string; apikey?: string; prefer?: string }> = []
/** When set, the mock answers every write with this Postgres error. */
let failWrites: { code: string; message: string } | null = null

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    seen.push({
      method: req.method || '',
      url: req.url || '',
      authorization: req.headers.authorization as string | undefined,
      apikey: req.headers.apikey as string | undefined,
      prefer: req.headers.prefer as string | undefined,
    })
    const isWrite = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT'
    if (isWrite && failWrites) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: failWrites.code, message: failWrites.message, details: 'Unauthorized', hint: null }))
      return
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Range': '0-0/*' })
      res.end(JSON.stringify([]))
      return
    }
    res.writeHead(201, { 'Content-Type': 'application/json', Prefer: 'return=minimal' })
    res.end('')
  })
})

before(async () => {
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
})
after(() => server.close())

const UID = '11111111-1111-4111-8111-111111111111'
const lastSeen = () => seen[seen.length - 1]

/* ------------------------------------------------------------------ */
/* 1. the caller's JWT reaches PostgREST                              */
/* ------------------------------------------------------------------ */

test('bearerToken reads a Web Request header, a plain object, and nothing', () => {
  const req = new Request('http://x/api/user/profile', { headers: { Authorization: 'Bearer abc.def.ghi' } })
  assert.equal(bearerToken(req), 'abc.def.ghi')
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi')
  assert.equal(bearerToken({ headers: { authorization: 'raw-token' } }), 'raw-token')
  assert.equal(bearerToken(new Request('http://x/')), null)
  assert.equal(bearerToken(null), null)
  assert.equal(bearerToken(undefined), null)
})

test('with no service-role key the write goes out as the caller', async () => {
  assert.equal(hasServiceRoleKey(), false, 'this test must run without SUPABASE_SERVICE_ROLE_KEY')
  resetRequestClients()
  const client = getClientForToken('user-jwt-1')
  assert.ok(client)
  const outcome = await persistProfileDetailed(client!, {
    id: UID, email: 'aarti@example.com', full_name: 'Aarti Deshmukh', phone: '9822011111',
    gender: 'female', degree: 'B.Tech CSE', college: 'PCCOE', graduation_year: 2026, cgpa: 8.7,
  })
  assert.equal(outcome.ok, true)
  const write = seen.filter((s) => s.method === 'POST').at(-1)!
  assert.equal(write.authorization, 'Bearer user-jwt-1', 'the student JWT must be forwarded')
  assert.equal(write.apikey, 'test-anon-key', 'the anon key stays in apikey')
  assert.match(write.url, /^\/rest\/v1\/profiles/)
  assert.match(write.prefer || '', /resolution=merge-duplicates/, 'still an upsert on id')
})

test('getClientForRequest takes the token from the route handler request', async () => {
  resetRequestClients()
  const req = new Request('http://x/api/user/profile', { headers: { Authorization: 'Bearer user-jwt-2' } })
  const client = getClientForRequest(req)
  assert.ok(client)
  await persistProfileDetailed(client!, { id: UID, email: 'aarti@example.com', full_name: 'Aarti D' })
  assert.equal(lastSeen().authorization, 'Bearer user-jwt-2')
})

test('a request without a token falls back to the anonymous client', async () => {
  resetRequestClients()
  const client = getClientForRequest(new Request('http://x/api/user/profile'))
  assert.ok(client)
  await persistProfileDetailed(client!, { id: UID, email: 'aarti@example.com', full_name: 'Aarti D' })
  // supabase-js always sends *something* as the bearer: with no user session it
  // is the anon key, whose JWT has no `sub`, so Postgres evaluates
  // `auth.uid() = id` as NULL and rejects the row with 42501. That is the write
  // this whole change exists to prevent.
  assert.equal(lastSeen().authorization, 'Bearer test-anon-key', 'no user identity is forwarded')
})

test('the same token reuses one client (no client per autosave)', () => {
  resetRequestClients()
  const a = getClientForToken('user-jwt-3')
  const b = getClientForToken('user-jwt-3')
  assert.equal(a, b)
  assert.notEqual(a, getClientForToken('user-jwt-4'))
})

/* ------------------------------------------------------------------ */
/* 2. a rejected write is reported, not swallowed                     */
/* ------------------------------------------------------------------ */

test('an RLS rejection explains itself instead of looking like success', async () => {
  resetRequestClients()
  failWrites = { code: '42501', message: 'new row violates row-level security policy for table "profiles"' }
  try {
    const client = getClientForToken('user-jwt-5')!
    const outcome = await persistProfileDetailed(client, { id: UID, email: 'aarti@example.com' })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.rls, true)
    assert.equal(outcome.code, '42501')
    const warning = syncWarning(outcome)!
    assert.match(warning, /row-level security/)
    assert.match(warning, /SUPABASE_SERVICE_ROLE_KEY/)
  } finally {
    failWrites = null
  }
})

test('a missing table points at the schema file', async () => {
  resetRequestClients()
  failWrites = { code: '42P01', message: 'relation "public.profiles" does not exist' }
  try {
    const outcome = await persistProfileDetailed(getClientForToken('user-jwt-6')!, { id: UID, email: 'a@b.c' })
    assert.equal(outcome.tableMissing, true)
    assert.match(syncWarning(outcome)!, /supabase\/schema\.sql/)
  } finally {
    failWrites = null
  }
})

test('a local demo id is refused before it reaches Postgres', async () => {
  resetRequestClients()
  const before = seen.length
  const outcome = await persistProfileDetailed(getClientForToken('user-jwt-7')!, {
    id: 'u_1527b6d3', email: 'demo@example.com', full_name: 'Demo',
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.notUuid, true)
  assert.equal(seen.length, before, 'no request was sent for an id Postgres could never store')
  assert.match(syncWarning(outcome)!, /local demo id/)
})

test('tracking events carry the same explanation', async () => {
  resetRequestClients()
  const client = getClientForToken('user-jwt-8')!
  const ok = await persistTrackingEventDetailed(client, { id: 'track_1', user_id: UID, action: 'join_whatsapp', completed: true })
  assert.equal(ok.ok, true)
  const bad = await persistTrackingEventDetailed(client, { id: 'track_2', user_id: 'u_abc', action: 'join_whatsapp' })
  assert.equal(bad.ok, false)
  assert.equal(bad.notUuid, true)
})

test('syncWarning is null when the write landed', () => {
  assert.equal(syncWarning({ ok: true }), null)
  assert.equal(syncWarning(null), null)
  assert.equal(syncWarning(undefined), null)
})

/* ------------------------------------------------------------------ */
/* 3. assessment sessions / results report failures the same way       */
/* ------------------------------------------------------------------ */

test('a missing profiles row (23503) says which row is missing', async () => {
  resetRequestClients()
  failWrites = {
    code: '23503',
    message: 'insert or update on table "assessment_sessions" violates foreign key constraint "assessment_sessions_student_id_fkey"',
  }
  try {
    const client = getClientForToken('user-jwt-9')!
    const outcome = await persistAssessmentSessionDetailed(client, {
      id: 'aaaaaaaa-0000-4000-8000-000000000001', student_id: UID, status: 'in_progress', answers: { q1: 'a' },
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.foreignKey, true)
    const warning = syncWarning(outcome)!
    assert.match(warning, /no profiles row/)
    assert.match(warning, /auth\.users/)
    assert.match(warning, /on_auth_user_created/)
  } finally {
    failWrites = null
  }
})

test('sessions and results land when the caller owns the row', async () => {
  resetRequestClients()
  const client = getClientForToken('user-jwt-10')!
  const session = await persistAssessmentSessionDetailed(client, {
    id: 'aaaaaaaa-0000-4000-8000-000000000002', student_id: UID, status: 'in_progress',
    answers: { q1: 'a' }, tab_switches: 0, duration_sec: 7200,
  })
  assert.equal(session.ok, true)
  const result = await persistAssessmentResultDetailed(client, {
    session_id: 'aaaaaaaa-0000-4000-8000-000000000002', student_id: UID,
    scores: { total: 760 }, total: 760, grade: 'A', percentile: 84.2,
  })
  assert.equal(result.ok, true)
  const write = seen.filter((s) => s.method === 'POST').at(-1)!
  assert.equal(write.authorization, 'Bearer user-jwt-10', 'the result write carries the student token too')
  assert.match(write.url, /^\/rest\/v1\/assessment_results/)
})

test('a session with no student id is refused before it reaches Postgres', async () => {
  resetRequestClients()
  const before = seen.length
  const outcome = await persistAssessmentSessionDetailed(getClientForToken('user-jwt-11')!, {
    id: 'aaaaaaaa-0000-4000-8000-000000000003', student_id: '', status: 'in_progress',
  })
  assert.equal(outcome.ok, false)
  assert.equal(seen.length, before, 'no request was sent')
  assert.ok(syncWarning(outcome))
})
