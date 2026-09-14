import test from 'node:test'
import assert from 'node:assert/strict'
import { feedbackOptions, validFeedback } from '../feedback.ts'

test('each star supplies ready-to-submit editable wording', () => {
  assert.equal(feedbackOptions.length, 5)
  feedbackOptions.forEach((option, index) => {
    assert.ok(option.label)
    assert.equal(validFeedback(index + 1, option.text), true)
  })
})

test('feedback requires a whole-number rating and meaningful bounded text', () => {
  for (const rating of [0, 6, -1, 1.5, '5', null, undefined, NaN]) {
    assert.equal(validFeedback(rating, feedbackOptions[4].text), false)
  }
  for (const message of ['', 'short', '          ', 'x'.repeat(1001), null, 42]) {
    assert.equal(validFeedback(5, message), false)
  }
  assert.equal(validFeedback(1, 'x'.repeat(10)), true)
  assert.equal(validFeedback(5, 'x'.repeat(1000)), true)
})

/* ------------------------------------------------------------------ */
/* The pending ticket (what decides whether /feedback holds a student) */
/* ------------------------------------------------------------------ */

import {
  FEEDBACK_DRAFT_KEY,
  FEEDBACK_PENDING_KEY,
  FEEDBACK_PENDING_TTL_MS,
  clearFeedbackDraft,
  clearFeedbackPending,
  markFeedbackPending,
  parseFeedbackPending,
  readFeedbackDraft,
  readFeedbackPending,
  writeFeedbackDraft,
} from '../feedback.ts'

const NOW = 1_800_000_000_000

function memoryStorage(): {
  read: (k: string) => string | null
  write: (k: string, v: string) => void
  remove: (k: string) => void
  map: Map<string, string>
} {
  const map = new Map<string, string>()
  return {
    map,
    read: (k: string) => (map.has(k) ? map.get(k)! : null),
    write: (k: string, v: string) => { map.set(k, v) },
    remove: (k: string) => { map.delete(k) },
  }
}

test('a submission leaves a timestamped ticket the gate can read back', () => {
  const s = memoryStorage()
  markFeedbackPending('sess_42', s.write, NOW)
  assert.equal(s.map.get(FEEDBACK_PENDING_KEY), JSON.stringify({ session_id: 'sess_42', at: NOW }))
  assert.deepEqual(readFeedbackPending(s.read, NOW), { session_id: 'sess_42', at: NOW })
})

test('the ticket expires instead of holding the candidate on /feedback forever', () => {
  const raw = JSON.stringify({ session_id: 'sess_42', at: NOW })
  assert.notEqual(parseFeedbackPending(raw, NOW + FEEDBACK_PENDING_TTL_MS - 1000), null)
  assert.equal(parseFeedbackPending(raw, NOW + FEEDBACK_PENDING_TTL_MS), null)
})

test('a ticket written by the old build (no timestamp) releases the candidate', () => {
  // This is the exact value the previous build stored; it could never expire,
  // so a single failed save left the dashboard/report unreachable.
  const legacy = JSON.stringify({ session_id: 'sess_42' })
  assert.equal(parseFeedbackPending(legacy, NOW), null)
  const s = memoryStorage()
  s.write(FEEDBACK_PENDING_KEY, legacy)
  assert.equal(readFeedbackPending(s.read, NOW), null)
})

test('garbage in storage is treated as "nothing pending"', () => {
  for (const raw of ['', 'not json', 'null', '[]', '"x"', JSON.stringify({ at: 'soon' }), JSON.stringify({ at: -5 })]) {
    assert.equal(parseFeedbackPending(raw, NOW), null, `${JSON.stringify(raw)} must not gate anyone`)
  }
  assert.equal(parseFeedbackPending(null, NOW), null)
})

test('clearing the ticket lets the candidate through', () => {
  const s = memoryStorage()
  markFeedbackPending('sess_42', s.write, NOW)
  clearFeedbackPending(s.remove)
  assert.equal(s.map.has(FEEDBACK_PENDING_KEY), false)
  assert.equal(readFeedbackPending(s.read, NOW), null)
})

test('a deferred attempt keeps its draft so nothing typed is lost', () => {
  const s = memoryStorage()
  writeFeedbackDraft({ rating: 4, message: 'Good, but the timer was tight', session_id: 'sess_42' }, s.write, NOW)
  const draft = readFeedbackDraft(s.read, NOW)
  assert.equal(draft?.rating, 4)
  assert.equal(draft?.message, 'Good, but the timer was tight')
  assert.equal(draft?.session_id, 'sess_42')
  clearFeedbackDraft(s.remove)
  assert.equal(s.map.has(FEEDBACK_DRAFT_KEY), false)
  assert.equal(readFeedbackDraft(s.read, NOW), null)
})

test('a draft with an impossible rating is read back without the rating', () => {
  const s = memoryStorage()
  s.write(FEEDBACK_DRAFT_KEY, JSON.stringify({ rating: 9, message: 'x', at: NOW }))
  assert.equal(readFeedbackDraft(s.read, NOW)?.rating, undefined)
  s.write(FEEDBACK_DRAFT_KEY, 'not json')
  assert.equal(readFeedbackDraft(s.read, NOW), null)
})

/* ------------------------------------------------------------------ */
/* The default storage path (what the browser actually runs)           */
/* ------------------------------------------------------------------ */

function stubLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const g = globalThis as any
  g.window = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
    },
  }
  return {
    store,
    restore: () => { delete g.window },
  }
}

test('the shipped gate logic releases a candidate the old build trapped', () => {
  // Exactly what the previous build left in localStorage after a failed save.
  const shim = stubLocalStorage({ [FEEDBACK_PENDING_KEY]: JSON.stringify({ session_id: 'sess_demo' }) })
  try {
    // readFeedbackPending with no injected reader = the real browser path used
    // by FeedbackGate; null means "show the dashboard", not "go to /feedback".
    assert.equal(readFeedbackPending(), null)
    clearFeedbackPending()
    assert.equal(shim.store.has(FEEDBACK_PENDING_KEY), false)
  } finally {
    shim.restore()
  }
})

test('a fresh submission is honoured through the same default path', () => {
  const shim = stubLocalStorage()
  try {
    markFeedbackPending('sess_77')
    assert.equal(readFeedbackPending()?.session_id, 'sess_77')
    clearFeedbackPending()
    assert.equal(readFeedbackPending(), null)
  } finally {
    shim.restore()
  }
})

test('the gate survives a browser that throws on every storage access', () => {
  const g = globalThis as any
  g.window = {
    localStorage: {
      getItem: () => { throw new Error('SecurityError: storage is blocked') },
      setItem: () => { throw new Error('SecurityError: storage is blocked') },
      removeItem: () => { throw new Error('SecurityError: storage is blocked') },
    },
  }
  try {
    markFeedbackPending('sess_77')
    assert.equal(readFeedbackPending(), null)
    clearFeedbackPending()
  } finally {
    delete g.window
  }
})

test('an old draft expires so the dashboard stops nudging about it', () => {
  const s = memoryStorage()
  writeFeedbackDraft({ rating: 3, message: 'Reasonable, could be tougher' }, s.write, NOW)
  assert.notEqual(readFeedbackDraft(s.read, NOW + FEEDBACK_PENDING_TTL_MS - 1000), null)
  assert.equal(readFeedbackDraft(s.read, NOW + FEEDBACK_PENDING_TTL_MS), null)
  s.write(FEEDBACK_DRAFT_KEY, JSON.stringify({ rating: 3, message: 'no timestamp' }))
  assert.equal(readFeedbackDraft(s.read, NOW), null)
})
