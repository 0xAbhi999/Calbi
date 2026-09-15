// "Your details are saved here, but the Supabase write failed."
//
// The API routes answer with `sync_warning` when Supabase is configured and a
// write was rejected (usually RLS — see lib/supabaseServer.ts). Nothing is lost
// locally, but the student must not be told "Saved" while Postgres still holds
// only the name and email the sign-up trigger seeded. The warning is kept in
// localStorage with a TTL so it survives the redirect that follows a save and
// can be shown on the next page the student lands on.
const SYNC_WARNING_KEY = 'calibiai_sync_warning'
/** Don't nag about a failure that happened more than a day ago. */
export const SYNC_WARNING_TTL_MS = 24 * 60 * 60 * 1000

export interface SyncWarning {
  message: string
  at: number
}

type StorageLike = {
  read: (k: string) => string | null
  write: (k: string, v: string) => void
  remove: (k: string) => void
}

function browserStorage(): StorageLike | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  return {
    read: (k) => window.localStorage.getItem(k),
    write: (k, v) => window.localStorage.setItem(k, v),
    remove: (k) => window.localStorage.removeItem(k),
  }
}

/** Keeps the newest warning; an empty/absent value clears it. */
export function rememberSyncWarning(message: string | null | undefined, storage?: StorageLike | null, now = Date.now()): void {
  const store = storage === undefined ? browserStorage() : storage
  if (!store) return
  const text = String(message ?? '').trim()
  if (!text) {
    store.remove(SYNC_WARNING_KEY)
    return
  }
  try {
    store.write(SYNC_WARNING_KEY, JSON.stringify({ message: text, at: now } satisfies SyncWarning))
  } catch {
    /* storage full / private mode — the API response already logged it */
  }
}

/** Records the warning an API route returned (`{ sync_warning }`), if any. */
export function noteSyncWarning(data: any, storage?: StorageLike | null, now = Date.now()): string | null {
  const message = typeof data?.sync_warning === 'string' ? data.sync_warning : null
  if (message) rememberSyncWarning(message, storage, now)
  return message
}

export function readSyncWarning(storage?: StorageLike | null, now = Date.now()): SyncWarning | null {
  const store = storage === undefined ? browserStorage() : storage
  if (!store) return null
  try {
    const raw = store.read(SYNC_WARNING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SyncWarning
    if (!parsed?.message) return null
    if (!Number.isFinite(parsed.at) || now - parsed.at > SYNC_WARNING_TTL_MS) {
      store.remove(SYNC_WARNING_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function clearSyncWarning(storage?: StorageLike | null): void {
  const store = storage === undefined ? browserStorage() : storage
  store?.remove(SYNC_WARNING_KEY)
}
