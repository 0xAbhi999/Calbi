import test from 'node:test'
import assert from 'node:assert/strict'

import { createLimiter } from '../concurrency.ts'

test('limiter allows up to max, then rejects until a release', () => {
  const limiter = createLimiter(2)
  assert.equal(limiter.active(), 0)
  assert.equal(limiter.tryAcquire(), true)
  assert.equal(limiter.tryAcquire(), true)
  assert.equal(limiter.tryAcquire(), false) // saturated
  assert.equal(limiter.active(), 2)
  limiter.release()
  assert.equal(limiter.active(), 1)
  assert.equal(limiter.tryAcquire(), true)
  assert.equal(limiter.tryAcquire(), false)
  assert.equal(limiter.max(), 2)
})

test('limiter never releases below zero (release is safe to over-call)', () => {
  const limiter = createLimiter(1)
  limiter.release()
  limiter.release()
  assert.equal(limiter.active(), 0)
})
