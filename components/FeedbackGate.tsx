'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { clearFeedbackPending, readFeedbackPending } from '@/lib/feedback'

/**
 * Keep a pending post-assessment step across refreshes and direct report visits.
 *
 * The gate only ever acts on a **valid, unexpired** ticket (`readFeedbackPending`
 * returns `null` for anything missing, corrupt, older than the TTL, or written
 * by the old build that stored no timestamp). Anything else is cleared here, so
 * a failed feedback save can never lock a candidate out of their own dashboard
 * and report again — the reason this used to trap them was a bare
 * `localStorage` key that only a successful `POST /api/feedback` removed.
 */
export function FeedbackGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (readFeedbackPending()) router.replace('/feedback')
    else {
      clearFeedbackPending() // drop a stale/unparseable ticket if there is one
      setReady(true)
    }
  }, [router])
  return ready ? children : <div role="status" className="min-h-screen grid place-items-center text-sm text-slate-500">Loading your next step…</div>
}
