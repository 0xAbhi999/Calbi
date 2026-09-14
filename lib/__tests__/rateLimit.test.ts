import test from 'node:test'
import assert from 'node:assert/strict'

import { checkRateLimit, resetRateLimits, getClientIp } from '../rateLimit.ts'

test('fixed window allows up to the limit then blocks', () => {
  resetRateLimits()
  const key = 'ip:1.2.3.4'
  const now = 1_000_000
  for (let i = 0; i < 3; i++) {
    assert.equal(checkRateLimit(key, 3, 1000, now).allowed, true)
  }
  const blocked = checkRateLimit(key, 3, 1000, now)
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.remaining, 0)
  assert.equal(blocked.retryAfterSec, 1)
})

test('windows reset after the window elapses', () => {
  resetRateLimits()
  const key = 'ip:9.9.9.9'
  assert.equal(checkRateLimit(key, 1, 1000, 0).allowed, true)
  assert.equal(checkRateLimit(key, 1, 1000, 0).allowed, false)
  assert.equal(checkRateLimit(key, 1, 1000, 1001).allowed, true)
})

test('keys are independent', () => {
  resetRateLimits()
  assert.equal(checkRateLimit('a', 1, 1000, 0).allowed, true)
  assert.equal(checkRateLimit('b', 1, 1000, 0).allowed, true)
  assert.equal(checkRateLimit('a', 1, 1000, 0).allowed, false)
})

test('getClientIp prefers x-forwarded-for then x-real-ip', () => {
  const r1 = new Request('http://localhost/', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } })
  assert.equal(getClientIp(r1), '203.0.113.9')
  const r2 = new Request('http://localhost/', { headers: { 'x-real-ip': '198.51.100.7' } })
  assert.equal(getClientIp(r2), '198.51.100.7')
  const r3 = new Request('http://localhost/')
  assert.equal(getClientIp(r3), 'unknown')
})
