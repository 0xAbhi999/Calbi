/**
 * The browser half of the fix: `authFetch` must put the signed-in student's
 * access token on every API call, because the server can only satisfy the
 * `auth.uid() = id` RLS policies when the caller's JWT is forwarded.
 *
 * Runs a real supabase-js client (session installed with `setSession`, exactly
 * like app/login/page.tsx does) against an in-process server that records the
 * headers it receives.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54396'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { authFetch, authHeaders } from '../apiFetch.ts'
import { getAccessToken, getSupabase } from '../supabase.ts'

const PORT = 54396
const UID = '11111111-1111-4111-8111-111111111111'
const seen: Array<{ url: string; authorization?: string; contentType?: string }> = []

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const ACCESS_TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
  sub: UID, role: 'authenticated', email: 'aarti@example.com', exp: now + 3600, iat: now,
})}.c2lnbmF0dXJl`  // base64url length must be 0/2/3 mod 4, like a real signature

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    if (req.url?.startsWith('/auth/v1/user')) {
      // supabase-js validates the session it was handed by fetching the user.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ id: UID, email: 'aarti@example.com', user_metadata: {} }))
    }
    seen.push({
      url: req.url || '',
      authorization: req.headers.authorization as string | undefined,
      contentType: req.headers['content-type'] as string | undefined,
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
})

before(async () => {
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
})
after(() => server.close())

const url = () => `http://127.0.0.1:${PORT}/api/user/profile`
const last = () => seen[seen.length - 1]

test('signed out, authFetch is a plain fetch (demo mode unaffected)', async () => {
  assert.equal(await getAccessToken(), null)
  const res = await authFetch(url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(res.status, 200)
  assert.equal(last().authorization, undefined)
  assert.equal(last().contentType, 'application/json', 'caller headers are preserved')
})

test('once supabase-js holds the session, every call carries the access token', async () => {
  const sb = getSupabase()
  assert.ok(sb, 'Supabase is configured for this test')
  const { error } = await sb!.auth.setSession({ access_token: ACCESS_TOKEN, refresh_token: 'refresh-token' })
  assert.equal(error, null, `setSession must succeed: ${error?.message}`)

  assert.equal(await getAccessToken(), ACCESS_TOKEN)

  const res = await authFetch(url(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: UID }),
  })
  assert.equal(res.status, 200)
  assert.equal(last().authorization, `Bearer ${ACCESS_TOKEN}`)
  assert.equal(last().contentType, 'application/json')

  // GETs are RLS-scoped too (that is why login reported has_onboarding: false).
  await authFetch(`${url()}?user_id=${UID}`)
  assert.equal(last().authorization, `Bearer ${ACCESS_TOKEN}`)
})

test('an Authorization header the caller set is never overwritten', async () => {
  await authFetch(url(), { headers: { Authorization: 'Bearer explicit' } })
  assert.equal(last().authorization, 'Bearer explicit')
})

test('authHeaders returns the same token for hand-built RequestInit', async () => {
  const headers = await authHeaders({ 'Content-Type': 'application/json' })
  assert.equal(headers.Authorization, `Bearer ${ACCESS_TOKEN}`)
  assert.equal(headers['Content-Type'], 'application/json')
})
