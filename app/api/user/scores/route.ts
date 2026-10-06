import { NextResponse } from 'next/server'
import { getLatestAssessmentResultForStudent } from '@/lib/db'
import { getClientForRequest } from '@/lib/supabaseServer'
import { fetchLatestAssessmentResult } from '@/lib/persist'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const studentId = url.searchParams.get('student_id') || ''
    if (!studentId) return NextResponse.json({ error: 'Missing student_id' }, { status: 400 })
    // The local JSON store is per-instance (lost on serverless restarts); when
    // Supabase is configured, Postgres is the source of truth for results.
    const sb = getClientForRequest(req)
    if (sb) {
      const result = await fetchLatestAssessmentResult(sb, studentId)
      if (result) return NextResponse.json({ result, supabase: true })
    }
    const result = getLatestAssessmentResultForStudent(studentId)
    return NextResponse.json({ result })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to fetch scores' }, { status: 500 })
  }
}
