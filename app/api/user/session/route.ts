import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { saveAssessmentSession, getActiveSessionForStudent, getAssessmentSession, flushDB, type AssessmentSession } from '@/lib/db'
import { getServerClient } from '@/lib/supabaseServer'
import { fetchActiveAssessmentSession, fetchAssessmentSession, persistAssessmentSession, toUuid } from '@/lib/persist'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const sessionId = url.searchParams.get('session_id') || ''
    const studentId = url.searchParams.get('student_id') || ''
    // Supabase may hold the session even when the local JSON store lost it
    // (serverless instance / fresh deploy) — check it first when configured.
    const sb = getServerClient()
    if (sb) {
      if (sessionId) {
        const data = await fetchAssessmentSession(sb, sessionId)
        if (data) return NextResponse.json({ session: data, supabase: true })
      } else if (studentId) {
        const data = await fetchActiveAssessmentSession(sb, studentId)
        if (data) return NextResponse.json({ session: data, supabase: true })
      }
    }
    if (sessionId) {
      const session = getAssessmentSession(sessionId)
      return NextResponse.json({ session })
    }
    if (studentId) {
      const session = getActiveSessionForStudent(studentId)
      return NextResponse.json({ session })
    }
    return NextResponse.json({ session: null })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to fetch session' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    // Session ids must be uuids everywhere: Supabase's `id uuid` column rejects
    // the old "sess_…" demo ids, silently dropping the row and making returning
    // students look like they never took the assessment. A stable id is also
    // required — remapping a demo id on every request would create a new row
    // per save instead of updating the same session.
    const id = toUuid(body.id, 'session') || toUuid(body.session_id, 'session') || randomUUID()
    const session: AssessmentSession = {
      id,
      student_id: body.student_id || body.user_id || '',
      status: body.status || 'in_progress',
      started_at: body.started_at || new Date().toISOString(),
      expires_at: body.expires_at || new Date(Date.now() + 7200 * 1000).toISOString(),
      duration_sec: body.duration_sec || 7200,
      answers: body.answers || {},
      submitted_at: body.submitted_at || null,
      tab_switches: body.tab_switches || 0,
      question_seed: body.question_seed || Math.floor(Date.now() / 1000),
      created_at: body.created_at || new Date().toISOString(),
    }
    saveAssessmentSession(session)
    // The start of a 120-minute attempt must be on disk before the candidate
    // proceeds, or a crash would lose the fact they ever started.
    await flushDB()
    const sb = getServerClient()
    let supabase = false
    if (sb) supabase = await persistAssessmentSession(sb, session)
    return NextResponse.json({ session, saved: true, supabase })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to save session' }, { status: 500 })
  }
}
