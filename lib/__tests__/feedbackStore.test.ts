import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { flushQueuedFeedback, normaliseFeedback, saveFeedbackSubmission } from '../feedbackStore.ts'
import { flushDB, getAllFeedback, getUnsyncedFeedback, setDbDirectory } from '../db.ts'

/* ------------------------------------------------------------------ */
/* A fake Supabase client that records every write                     */
/* ------------------------------------------------------------------ */

interface Call {
  table: string
  op: 'insert' | 'upsert'
  row: any
  options?: any
}

type Responder = (row: any, table: string) => { error?: any }

function fakeClient(handlers: { insert?: Responder; upsert?: Responder } = {}) {
  const calls: Call[] = []
  const client: any = {
    from(table: string) {
      return {
        insert: async (row: any) => {
          calls.push({ table, op: 'insert', row })
          return handlers.insert ? handlers.insert(row, table) : { error: null }
        },
        upsert: async (row: any, options: any) => {
          calls.push({ table, op: 'upsert', row, options })
          return handlers.upsert ? handlers.upsert(row, table) : { error: null }
        },
      }
    },
  }
  return { client, calls }
}

const RLS_ERROR = { code: '42501', message: 'new row violates row-level security policy for table "feedback_submissions"' }
const MISSING_TABLE = { code: '42P01', message: 'relation "public.feedback_submissions" does not exist' }
const DUPLICATE = { code: '23505', message: 'duplicate key value violates unique constraint "feedback_submissions_pkey"' }
const FK_ERROR = { code: '23503', message: 'insert or update on table "feedback_submissions" violates foreign key constraint' }

const validBody = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  student_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  email: 'Candidate@Example.com',
  session_id: 'sess_99',
  rating: 5,
  message: 'Good assessment, up to the mark.',
}

/**
 * Each test gets its own store directory so nothing leaks between cases. The
 * returned cleanup waits for the coalesced write flush first — deleting the
 * directory while a scheduled flush is still pending makes the store throw
 * after the test has ended.
 */
function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibiai-test-'))
  setDbDirectory(dir)
  return async () => {
    await flushDB()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

test('invalid feedback is rejected before anything is stored', async () => {
  const cleanup = useTempStore()
  const { client, calls } = fakeClient()
  const result: any = await saveFeedbackSubmission({ ...validBody, message: 'short' }, client)
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.equal(calls.length, 0)
  assert.equal(getAllFeedback().length, 0)
  await cleanup()
})

test('the stored row normalises id, email and source', () => {
  const parsed: any = normaliseFeedback({ rating: '4', message: '  Plenty of text here  ', email: ' A@B.com ' })
  assert.equal(parsed.submission.rating, 4)
  assert.equal(parsed.submission.email, 'a@b.com')
  assert.equal(parsed.submission.message, 'Plenty of text here')
  assert.equal(parsed.submission.source, 'web')
  assert.ok(parsed.submission.id)
  assert.equal(parsed.submission.student_id, 'sess_demo')
})

/* ------------------------------------------------------------------ */
/* The write path                                                      */
/* ------------------------------------------------------------------ */

test('a working database stores the feedback in Supabase (insert, not upsert)', async () => {
  const cleanup = useTempStore()
  const { client, calls } = fakeClient()
  const result: any = await saveFeedbackSubmission(validBody, client)

  assert.equal(result.ok, true)
  assert.equal(result.stored, 'supabase')
  assert.equal(calls.length, 1, 'a healthy database needs exactly one write')
  assert.equal(calls[0].op, 'insert')
  assert.equal(calls[0].table, 'feedback_submissions')
  assert.equal(calls[0].row.id, validBody.id, 'the client id is reused so retries cannot duplicate')
  assert.equal(calls[0].row.email, 'candidate@example.com')
  // The local copy is marked delivered so the queue stays empty.
  const rows = getAllFeedback()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].synced, true)
  assert.equal(getUnsyncedFeedback().length, 0)
  await cleanup()
})

test('an anon-key RLS rejection no longer fails the save', async () => {
  // The bug: `.upsert()` sends ON CONFLICT DO UPDATE, which needs an UPDATE
  // policy the table does not have, so the write failed with 42501 and the
  // candidate was told their feedback could not be saved.
  const cleanup = useTempStore()
  const { client, calls } = fakeClient({
    insert: () => ({ error: RLS_ERROR }),
  })
  const first: any = await saveFeedbackSubmission(validBody, client)
  // First attempt: insert blocked → the ignore-duplicates upsert recovers it.
  assert.equal(first.ok, true)
  assert.equal(first.stored, 'supabase')
  assert.deepEqual(calls.map(c => c.op), ['insert', 'upsert'])
  assert.equal(calls[1].options.ignoreDuplicates, true)
  assert.equal(calls[1].options.onConflict, 'id')

  // A retry of the same submission id is a duplicate, not an error.
  calls.length = 0
  const retryClient = fakeClient({ insert: () => ({ error: DUPLICATE }) })
  const retry: any = await saveFeedbackSubmission({ ...validBody, source: 'retry' }, retryClient.client)
  assert.equal(retry.ok, true)
  assert.equal(retry.stored, 'supabase')
  assert.equal(retry.duplicate, true)
  await cleanup()
})

test('a missing feedback table queues the row and still answers ok', async () => {
  const cleanup = useTempStore()
  const { client } = fakeClient({ insert: () => ({ error: MISSING_TABLE }), upsert: () => ({ error: MISSING_TABLE }) })
  const result: any = await saveFeedbackSubmission(validBody, client)

  assert.equal(result.ok, true, 'the candidate is never blocked on the database')
  assert.equal(result.stored, 'queue')
  assert.match(result.reason, /0004_feedback_submissions/)

  const queued = getUnsyncedFeedback()
  assert.equal(queued.length, 1)
  assert.equal(queued[0].synced, false)
  assert.match(String(queued[0].sync_error), /42P01/)
  await cleanup()
})

test('a candidate whose profile is missing from Postgres still gets the feedback stored', async () => {
  const cleanup = useTempStore()
  const { client, calls } = fakeClient({
    insert: (row) => ({ error: row.student_id ? FK_ERROR : null }),
    upsert: () => ({ error: FK_ERROR }),
  })
  const result: any = await saveFeedbackSubmission(validBody, client)

  assert.equal(result.ok, true)
  assert.equal(result.stored, 'supabase')
  const detached = calls.filter(c => c.row.student_id === null)
  assert.equal(detached.length, 1, 'the FK is dropped and the row is written again')
  assert.equal(detached[0].row.student_ref, validBody.student_id, 'the raw id is kept for matching')
  await cleanup()
})

test('with no Supabase configured the submission is kept locally and queued', async () => {
  const cleanup = useTempStore()
  const result: any = await saveFeedbackSubmission(validBody, null)
  assert.equal(result.ok, true)
  assert.equal(result.stored, 'queue')
  assert.equal(getUnsyncedFeedback().length, 1)
  await cleanup()
})

/* ------------------------------------------------------------------ */
/* The retry queue                                                     */
/* ------------------------------------------------------------------ */

test('flushQueuedFeedback delivers queued rows once the database answers', async () => {
  const cleanup = useTempStore()
  // 1. The database is down.
  const down = fakeClient({ insert: () => ({ error: MISSING_TABLE }), upsert: () => ({ error: MISSING_TABLE }) })
  await saveFeedbackSubmission(validBody, down.client)
  await saveFeedbackSubmission({ ...validBody, id: 'aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee', rating: 2, message: 'Needs more practical questions.' }, down.client)
  assert.equal(getUnsyncedFeedback().length, 2)

  // 2. It comes back: everything queued is delivered and marked synced.
  const up = fakeClient()
  const flushed = await flushQueuedFeedback(up.client)
  assert.equal(flushed.attempted, 2)
  assert.equal(flushed.synced, 2)
  assert.equal(flushed.failed, 0)
  assert.equal(getUnsyncedFeedback().length, 0)
  assert.equal(up.calls.length, 2)
  assert.equal(getAllFeedback().every(f => f.synced === true), true)

  // 3. And a flush with nothing queued does nothing.
  const idle = fakeClient()
  const again = await flushQueuedFeedback(idle.client)
  assert.deepEqual(again, { attempted: 0, synced: 0, failed: 0 })
  assert.equal(idle.calls.length, 0)
  await cleanup()
})

test('a failed flush keeps the row queued with the reason recorded', async () => {
  const cleanup = useTempStore()
  const down = fakeClient({ insert: () => ({ error: RLS_ERROR }), upsert: () => ({ error: MISSING_TABLE }) })
  await saveFeedbackSubmission(validBody, null) // queued (demo mode)
  const flushed = await flushQueuedFeedback(down.client)
  assert.equal(flushed.synced, 0)
  assert.equal(flushed.failed, 1)
  const queued = getUnsyncedFeedback()
  assert.equal(queued.length, 1)
  assert.match(String(queued[0].sync_error), /42P01/)
  assert.equal(queued[0].attempts, 1)
  await cleanup()
})
