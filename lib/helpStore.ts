/**
 * Where in-app help requests go: `public.help_requests` in Supabase.
 *
 * This replaced a direct browser → Formspree POST. Two problems with that: the
 * free tier has a monthly submission limit (once it is reached every request
 * fails with an error the candidate cannot do anything about) and the messages
 * never landed in the database the rest of the app reads from. Requests now
 * follow exactly the same path as feedback — Supabase is the destination, the
 * local store is the queue when the database is unreachable, and the candidate
 * always gets a success unless the form itself is invalid.
 */
import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getUnsyncedHelpRequests,
  markHelpRequestSynced,
  saveHelpRequest,
  type HelpRequest,
} from './db.ts'
import { validHelpMessage, validHelpPhone } from './help.ts'
import { persistHelpRequestDetailed } from './persist.ts'

export interface HelpSaved {
  ok: true
  request: HelpRequest
  stored: 'supabase' | 'queue'
  duplicate?: boolean
  reason?: string
}

export interface HelpRejected {
  ok: false
  error: string
  status: number
}

export type HelpSaveResult = HelpSaved | HelpRejected

/** Client payload → the stored row, or the validation error to show. */
export function normaliseHelpRequest(body: any): HelpSaveResult | { request: HelpRequest } {
  const email = String(body?.email ?? '').trim().toLowerCase()
  const phone = String(body?.phone ?? '').trim()
  const message = String(body?.message ?? '').trim()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { ok: false, error: 'Enter a valid email address so we can reply.', status: 400 }
  }
  if (!validHelpPhone(phone)) {
    return { ok: false, error: 'Enter a valid phone number with 7–15 digits.', status: 400 }
  }
  if (!validHelpMessage(message)) {
    return { ok: false, error: 'Please describe your issue in 10–3,000 characters.', status: 400 }
  }
  return {
    request: {
      id: String(body?.id ?? '').trim() || randomUUID(),
      student_id: String(body?.student_id ?? body?.user_id ?? '').trim() || undefined,
      email,
      phone: phone.slice(0, 30),
      message: message.slice(0, 3000),
      // Pathname only — never a query string (it can carry session ids).
      page: String(body?.page ?? '').split('?')[0].slice(0, 200) || undefined,
      source: String(body?.source ?? '').trim() || 'web',
      created_at: new Date().toISOString(),
    },
  }
}

/** Store one help request. Never throws for a database problem. */
export async function saveHelpSubmission(
  body: any,
  client: SupabaseClient | null,
): Promise<HelpSaveResult> {
  const parsed = normaliseHelpRequest(body) as HelpSaved | HelpRejected | { request: HelpRequest }
  if ('ok' in parsed) return parsed
  const request = (parsed as { request: HelpRequest }).request

  if (!client) {
    saveHelpRequest({ ...request, synced: false, sync_error: 'Supabase is not configured on this server' })
    return { ok: true, request, stored: 'queue', reason: 'Supabase is not configured on this server' }
  }

  const outcome = await persistHelpRequestDetailed(client, request)
  if (outcome.ok) {
    saveHelpRequest({ ...request, synced: true })
    return { ok: true, request, stored: 'supabase', duplicate: outcome.duplicate }
  }

  const reason = outcome.tableMissing
    ? 'help_requests is missing — run supabase/migrations/0005_help_requests.sql'
    : outcome.message || 'The Supabase write failed'
  console.warn(`[help] queued ${request.id}:`, outcome.code || '', outcome.message)
  saveHelpRequest({
    ...request,
    synced: false,
    sync_error: [outcome.code, outcome.message].filter(Boolean).join(' '),
    attempts: 1,
  })
  return { ok: true, request, stored: 'queue', reason }
}

/** Replay queued help requests into Supabase (see flushQueuedFeedback). */
export async function flushQueuedHelpRequests(
  client: SupabaseClient | null,
  limit = 25,
): Promise<{ attempted: number; synced: number; failed: number }> {
  if (!client) return { attempted: 0, synced: 0, failed: 0 }
  const rows = getUnsyncedHelpRequests(limit)
  let synced = 0
  for (const row of rows) {
    const outcome = await persistHelpRequestDetailed(client, row)
    if (outcome.ok) {
      markHelpRequestSynced(row.id)
      synced++
    } else {
      markHelpRequestSynced(row.id, [outcome.code, outcome.message].filter(Boolean).join(' '))
    }
  }
  return { attempted: rows.length, synced, failed: rows.length - synced }
}
