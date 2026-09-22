import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { saveAssessmentResult, saveAssessmentSession, getAssessmentSession, flushDB, type AssessmentSession } from '@/lib/db'
import { getClientForRequest } from '@/lib/supabaseServer'
import { persistAssessmentResultDetailed, persistAssessmentSessionDetailed, syncWarning, toUuid } from '@/lib/persist'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    // Local demo ids ("sess_xyz") are not valid Postgres uuids — map them so
    // the result row actually lands in Supabase (the row-level mirror silently
    // failed before, so returners looked like they never took the assessment).
    const sessionId = toUuid(body.session_id, 'session') || randomUUID()
    // A hydrated client normally sends the user id. If the final submit races
    // the client store hydration, recover it from the already-saved session
    // instead of writing the result under "unknown" / a random UUID. That
    // mismatch is what made completed tests appear as "Not taken" in admin.
    // Keep the local JSON store in sync under the same uuid.
    let s: AssessmentSession | undefined = getAssessmentSession(body.session_id || '') || getAssessmentSession(sessionId)
    const suppliedStudentId = String(body.student_id || body.user_id || body.result?.student_id || '').trim()
    const studentId = suppliedStudentId && suppliedStudentId !== 'unknown'
      ? suppliedStudentId
      : String(s?.student_id || '').trim()
    const result = {
      id: toUuid(body.id, 'result') || 'res_' + Math.random().toString(16).slice(2, 10),
      session_id: sessionId,
      student_id: studentId,
      scores: body.scores || {},
      total: body.total || 0,
      grade: body.grade || 'D',
      percentile: body.percentile || 0,
      verifiable_hash: body.verifiable_hash || '',
      ai_feedback: body.ai_feedback || {},
      created_at: new Date().toISOString(),
    }
    if (!s) {
      s = {
        id: sessionId,
        student_id: studentId,
        status: 'submitted',
        started_at: body.started_at || new Date().toISOString(),
        expires_at: body.expires_at || new Date(Date.now() + 7200 * 1000).toISOString(),
        duration_sec: body.duration_sec || 7200,
        answers: body.answers || {},
        submitted_at: new Date().toISOString(),
        tab_switches: body.tab_switches || 0,
        question_seed: body.question_seed,
        created_at: new Date().toISOString(),
      }
    }
    s.id = sessionId
    s.status = 'submitted'
    s.submitted_at = new Date().toISOString()
    saveAssessmentSession(s)
    saveAssessmentResult(result)
    // A final submit is the one write that must be durable before we answer —
    // force the (coalesced) flush to disk, never just hope it happens later.
    await flushDB()
    // Mirror to Supabase: session status first (FK for the result row), then
    // the result — this is what makes the score survive a re-login.
    const sb = getClientForRequest(req)
    let outcome = null as Awaited<ReturnType<typeof persistAssessmentResultDetailed>> | null
    if (sb) {
      const sessionOutcome = await persistAssessmentSessionDetailed(sb, { ...s, ...body, answers: body.answers || s.answers })
      outcome = await persistAssessmentResultDetailed(sb, result)
      if (!outcome.ok && sessionOutcome.ok) {
        console.warn('[supabase] result persist failed for session', sessionId)
      }
      // The score is the thing the student must not lose: prefer the result's
      // reason, but never hide a session failure behind a successful result.
      if (outcome.ok && !sessionOutcome.ok) outcome = sessionOutcome
    }
    return NextResponse.json({
      result,
      saved: true,
      supabase: !!outcome?.ok,
      sync_warning: syncWarning(outcome),
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to submit assessment' }, { status: 500 })
  }
}
