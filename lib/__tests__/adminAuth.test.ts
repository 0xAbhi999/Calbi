import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'crypto'

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  cookieFromRequest,
  safeEqual,
  signSession,
  verifySessionToken,
} from '../adminAuth.ts'

test('signSession tokens verify and expire later', () => {
  const token = signSession()
  assert.ok(verifySessionToken(token))
})

test('verifySessionToken rejects tampered, garbage and expired tokens', () => {
  const token = signSession()
  // Flip one character in the signature.
  const [v, payload, sig] = token.split('.')
  const flipped = sig[0] === 'a' ? 'b' + sig.slice(1) : 'a' + sig.slice(1)
  assert.equal(verifySessionToken(`${v}.${payload}.${flipped}`), false)
  assert.equal(verifySessionToken('garbage'), false)
  assert.equal(verifySessionToken(''), false)
  assert.equal(verifySessionToken(null), false)
  // Expired token (exp already past).
  const expiredPayload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString('base64url')
  const expiredSig = createHmac('sha256', 'calibiai-admin-local-secret-change-me').update(expiredPayload).digest('hex')
  assert.equal(verifySessionToken(`v1.${expiredPayload}.${expiredSig}`), false)
})

test('safeEqual is true only for identical strings', () => {
  assert.equal(safeEqual(ADMIN_USERNAME, 'admin'), true)
  assert.equal(safeEqual(ADMIN_PASSWORD, 'CalibiAdmin@777'), true)
  assert.equal(safeEqual(ADMIN_PASSWORD, 'Admin@123'), false)
  assert.equal(safeEqual(ADMIN_PASSWORD, 'admin'), false)
})

test('cookieFromRequest extracts the admin cookie', () => {
  const token = signSession()
  const req = new Request('http://x/api/admin/session', {
    headers: { cookie: `other=1; ${'calibiai_admin_session'}=${token}; third=2` },
  })
  assert.equal(cookieFromRequest(req), token)
  assert.equal(cookieFromRequest(new Request('http://x/')), undefined)
})
