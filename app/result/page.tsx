'use client'
export const dynamic = 'force-dynamic'
import { useEffect, useRef, useState } from 'react'
import { FeedbackGate } from '@/components/FeedbackGate'
import { useRouter } from 'next/navigation'
import { ScoreReport } from '@/components/ScoreReport'
import { AFTER_ASSESSMENT_ROUTE } from '@/lib/nextStep'
import { consumeJustSubmittedTicket } from '@/lib/justSubmitted'

/**
 * One-time assessment flow: the full report is shown
 *   1. right after a fresh submission (the assessment page sets the
 *      `calibiai_just_submitted` ticket before sending the candidate to their
 *      dashboard), or
 *   2. when the same ticket is still valid (a reload of this page).
 * Any other visit — most importantly the browser BACK button from the
 * dashboard — is redirected to the student dashboard, where the report stays
 * available through "View report". The ticket is single-use.
 */
function ResultInner() {
  const router = useRouter()
  const [scores, setScores] = useState<any>(null)
  const decided = useRef(false)

  useEffect(() => {
    if (decided.current) return
    decided.current = true
    const fresh = consumeJustSubmittedTicket()
    const s = localStorage.getItem('calibiai_scores')
    if (!s || !fresh) { router.replace(AFTER_ASSESSMENT_ROUTE); return }
    try { setScores(JSON.parse(s)) } catch { router.replace(AFTER_ASSESSMENT_ROUTE) }
  }, [router])

  if (!scores) return (
    <div className="min-h-screen flex items-center justify-center text-slate-500">
      <div className="flex items-center gap-3 glass-card"><div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" /> Evaluating your answers…</div>
    </div>
  )

  return <ScoreReport scores={scores} />
}

export default function Page() {
  return <FeedbackGate><ResultInner /></FeedbackGate>
}
