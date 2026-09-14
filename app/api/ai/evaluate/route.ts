// AI evaluation endpoint — server-side only (keeps the CalibiAI key secret).
// Body: { kind, ...payload }
//   writing   { text, scenario }
//   speaking  { transcript?, recordingCount }
//   debugging { taskId, buggy, prompt, fix }
//   feature   { spec, code }
//   prompt    { task, hint, prompt }
export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import {
  evaluateWriting, evaluateSpeaking, evaluateDebugging, evaluateFeature, evaluatePrompt,
  isCalibiAiConfigured, type AiKind,
} from '@/lib/ai'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'

// Per-IP *abuse backstop* only (campuses share one NAT IP, so this must stay
// generous — it is not a per-student throttle). Each call may hit an upstream
// LLM, so the concurrency of upstream calls is the thing to watch; this just
// stops a single scripted source from flooding the grader.
const RATE_LIMIT = 2000
const RATE_WINDOW_MS = 60_000

export async function POST(req: Request) {
  const rl = checkRateLimit(`evaluate:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many evaluations — slow down.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const kind = body?.kind as AiKind
  try {
    let result
    switch (kind) {
      case 'writing':
        result = await evaluateWriting(String(body.text || ''), String(body.scenario || ''))
        break
      case 'speaking':
        result = await evaluateSpeaking(body.transcript ?? null, Number(body.recordingCount || 0))
        break
      case 'debugging':
        result = await evaluateDebugging(
          String(body.taskId || ''), String(body.buggy || ''),
          String(body.prompt || ''), String(body.fix || ''),
        )
        break
      case 'feature':
        result = await evaluateFeature(String(body.spec || ''), String(body.code || ''))
        break
      case 'prompt':
        result = await evaluatePrompt(String(body.task || ''), String(body.hint || ''), String(body.prompt || ''))
        break
      default:
        return NextResponse.json({ error: `unknown kind: ${kind}` }, { status: 400 })
    }
    return NextResponse.json({ ok: true, engine: isCalibiAiConfigured() ? 'calibiai' : 'heuristic', result })
  } catch (e: any) {
    return NextResponse.json({ error: 'evaluation failed', detail: String(e?.message || e) }, { status: 500 })
  }
}
