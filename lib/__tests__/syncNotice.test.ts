/**
 * The "saved here, but the Supabase write failed" notice.
 *
 * The bug this guards: `/api/user/profile` answered `{ saved: true }` while
 * Postgres had rejected the row (RLS), so the student was told everything was
 * saved and nothing ever showed up in Supabase. The route now returns
 * `sync_warning`, and these helpers are what carry it to the next page.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SYNC_WARNING_TTL_MS,
  clearSyncWarning,
  noteSyncWarning,
  readSyncWarning,
  rememberSyncWarning,
} from '../syncNotice.ts'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    read: (k: string) => (map.has(k) ? map.get(k)! : null),
    write: (k: string, v: string) => void map.set(k, v),
    remove: (k: string) => void map.delete(k),
    size: () => map.size,
  }
}

const NOW = 1_800_000_000_000

test('a warning from an API response is kept and can be read back', () => {
  const store = memoryStorage()
  const message = 'Saved on this device, but Supabase rejected the write (row-level security).'
  assert.equal(noteSyncWarning({ saved: true, supabase: false, sync_warning: message }, store, NOW), message)
  assert.deepEqual(readSyncWarning(store, NOW), { message, at: NOW })
})

test('a clean save records nothing', () => {
  const store = memoryStorage()
  assert.equal(noteSyncWarning({ saved: true, supabase: true, sync_warning: null }, store, NOW), null)
  assert.equal(noteSyncWarning({ saved: true }, store, NOW), null)
  assert.equal(noteSyncWarning(null, store, NOW), null)
  assert.equal(readSyncWarning(store, NOW), null)
  assert.equal(store.size(), 0)
})

test('an empty warning clears a previous one', () => {
  const store = memoryStorage()
  rememberSyncWarning('older failure', store, NOW)
  rememberSyncWarning('', store, NOW)
  assert.equal(readSyncWarning(store, NOW), null)
})

test('a stale warning is dropped instead of nagging forever', () => {
  const store = memoryStorage()
  rememberSyncWarning('yesterday\'s failure', store, NOW)
  assert.ok(readSyncWarning(store, NOW + SYNC_WARNING_TTL_MS - 1000))
  assert.equal(readSyncWarning(store, NOW + SYNC_WARNING_TTL_MS + 1000), null)
  assert.equal(store.size(), 0, 'the expired entry is removed, not just hidden')
})

test('corrupt storage never throws into the page', () => {
  const store = memoryStorage()
  store.write('calibiai_sync_warning', '{not json')
  assert.equal(readSyncWarning(store, NOW), null)
})

test('dismiss clears it', () => {
  const store = memoryStorage()
  rememberSyncWarning('failure', store, NOW)
  clearSyncWarning(store)
  assert.equal(readSyncWarning(store, NOW), null)
})
