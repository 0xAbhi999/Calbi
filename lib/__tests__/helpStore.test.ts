import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { flushQueuedHelpRequests, normaliseHelpRequest, saveHelpSubmission } from '../helpStore.ts'
import { flushDB, getAllHelpRequests, getUnsyncedHelpRequests, setDbDirectory } from '../db.ts'

interface Call {
  table: string
  op: 'insert' | 'upsert'
  row: any
}

function fakeClient(handlers: { insert?: () => { error?: any }; upsert?: () => { error?: any } } = {}) {
  const calls: Call[] = []
  const client: any = {
    from(table: string) {
      return {
        insert: async (row: any) => {
          calls.push({ table, op: 'insert', row })
          return handlers.insert ? handlers.insert() : { error: null }
        },
        upsert: async (row: any) => {
          calls.push({ table, op: 'upsert', row })
          return handlers.upsert ? handlers.upsert() : { error: null }
        },
      }
    },
  }
  return { client, calls }
}

const MISSING_TABLE = { code: '42P01', message: 'relation "public.help_requests" does not exist' }

const validBody = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  student_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  email: ' Candidate@Example.com ',
  phone: '+91 98765 43210',
  message: 'The speaking section would not record my answer.',
  page: '/assessment?session=abc',
}

function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibiai-help-test-'))
  setDbDirectory(dir)
  return async () => {
    await flushDB()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('a help request is validated and trimmed before it is stored', () => {
  const parsed: any = normaliseHelpRequest(validBody)
  assert.equal(parsed.request.email, 'candidate@example.com')
  assert.equal(parsed.request.phone, '+91 98765 43210')
  // Only the pathname is kept — a query string can carry a session id.
  assert.equal(parsed.request.page, '/assessment')
  assert.equal(parsed.request.student_id, validBody.student_id)
})

test('an invalid help request is rejected with a 400 and never written', async () => {
  const cleanup = useTempStore()
  const { client, calls } = fakeClient()
  for (const bad of [
    { ...validBody, email: 'nope' },
    { ...validBody, phone: '12' },
    { ...validBody, message: 'short' },
  ]) {
    const result: any = await saveHelpSubmission(bad, client)
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
  }
  assert.equal(calls.length, 0)
  assert.equal(getAllHelpRequests().length, 0)
  await cleanup()
})

test('a help request goes to Supabase, not to an external form service', async () => {
  const cleanup = useTempStore()
  const { client, calls } = fakeClient()
  const result: any = await saveHelpSubmission(validBody, client)

  assert.equal(result.ok, true)
  assert.equal(result.stored, 'supabase')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].op, 'insert')
  assert.equal(calls[0].table, 'help_requests')
  assert.equal(calls[0].row.id, validBody.id)
  assert.equal(getAllHelpRequests()[0].synced, true)
  assert.equal(getUnsyncedHelpRequests().length, 0)
  await cleanup()
})

test('an unreachable database queues the request and the flush delivers it later', async () => {
  const cleanup = useTempStore()
  const down = fakeClient({ insert: () => ({ error: MISSING_TABLE }), upsert: () => ({ error: MISSING_TABLE }) })
  const result: any = await saveHelpSubmission(validBody, down.client)

  assert.equal(result.ok, true, 'the candidate is never shown an error for our own outage')
  assert.equal(result.stored, 'queue')
  assert.match(result.reason, /0005_help_requests/)
  assert.equal(getUnsyncedHelpRequests().length, 1)

  const up = fakeClient()
  const flushed = await flushQueuedHelpRequests(up.client)
  assert.deepEqual(flushed, { attempted: 1, synced: 1, failed: 0 })
  assert.equal(getUnsyncedHelpRequests().length, 0)
  assert.equal(getAllHelpRequests()[0].synced, true)
  await cleanup()
})

test('with no Supabase configured the request is still kept', async () => {
  const cleanup = useTempStore()
  const result: any = await saveHelpSubmission(validBody, null)
  assert.equal(result.ok, true)
  assert.equal(result.stored, 'queue')
  assert.equal(getAllHelpRequests().length, 1)
  await cleanup()
})
