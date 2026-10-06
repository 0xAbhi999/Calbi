import { NextResponse } from 'next/server'
import { getTrackingEvents, saveTrackingEvent } from '@/lib/db'
import { getClientForRequest } from '@/lib/supabaseServer'
import { persistTrackingEventDetailed, syncWarning } from '@/lib/persist'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const userId = url.searchParams.get('user_id') || ''
    if (!userId) return NextResponse.json({ error: 'Missing user_id' }, { status: 400 })
    const events = getTrackingEvents(userId)
    return NextResponse.json({ tracking: events })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to fetch tracking' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const event = {
      id: body.id || 'track_' + Date.now(),
      user_id: body.user_id || body.id,
      action: body.action || '',
      completed: body.completed === true || body.completed === 'true',
      completed_at: body.completed ? new Date().toISOString() : undefined,
    }
    saveTrackingEvent(event)
    const sb = getClientForRequest(req)
    const outcome = sb ? await persistTrackingEventDetailed(sb, event) : null
    return NextResponse.json({
      event,
      saved: true,
      supabase: !!outcome?.ok,
      sync_warning: syncWarning(outcome),
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to save tracking' }, { status: 500 })
  }
}
