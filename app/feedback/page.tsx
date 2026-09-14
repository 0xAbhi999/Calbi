'use client'

import { useEffect, useRef, useState } from 'react'
import { HelpButton } from '@/components/HelpButton'
import { useRouter } from 'next/navigation'
import { ArrowRight, Check, CheckCircle2, Loader2, MessageSquareHeart, ShieldCheck, Sparkles, Star } from 'lucide-react'
import {
  AFTER_ASSESSMENT_ROUTE,
} from '@/lib/nextStep'
import {
  clearFeedbackDraft,
  clearFeedbackPending,
  feedbackOptions,
  readFeedbackDraft,
  readFeedbackPending,
  validFeedback,
  writeFeedbackDraft,
} from '@/lib/feedback'
import { markJustSubmitted } from '@/lib/justSubmitted'
import { fetchWithTimeout } from '@/lib/fetchTimeout'
import { useStore } from '@/lib/store'

export default function FeedbackPage() {
  const router = useRouter()
  const { user } = useStore()
  const [session, setSession] = useState<string | null>(null)
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [storedInQueue, setStoredInQueue] = useState(false)
  const lock = useRef(false)
  const version = useRef(0)
  const submissionId = useRef('')

  useEffect(() => {
    // A missing or expired ticket means there is nothing left to ask for —
    // send the candidate to their dashboard instead of holding them here.
    const pending = readFeedbackPending()
    if (!pending) {
      clearFeedbackPending()
      router.replace(AFTER_ASSESSMENT_ROUTE)
      return
    }
    setSession(pending.session_id)
    // Restore whatever was typed before a refresh, a crash or a "later" tap.
    const draft = readFeedbackDraft()
    if (draft) {
      if (draft.rating) setRating(draft.rating)
      if (draft.message) setMessage(draft.message)
      if (draft.rating || draft.message) setNotice('We kept what you wrote earlier.')
    }
  }, [router])

  /** Keep the text so a refresh or a failed save never costs the candidate their words. */
  function keepDraft(nextRating: number, nextMessage: string) {
    writeFeedbackDraft({ rating: nextRating || undefined, message: nextMessage, session_id: session || undefined })
  }

  function choose(value: number) {
    version.current++
    setRating(value)
    const text = feedbackOptions[value - 1].text
    setMessage(text)
    keepDraft(value, text)
    setNotice('Suggested wording added. Edit anything to reflect your experience.')
    setError('')
  }

  /** Leave the feedback step without losing the text — nobody is ever trapped here. */
  function defer() {
    if (busy) return
    keepDraft(rating, message)
    clearFeedbackPending()
    router.replace(AFTER_ASSESSMENT_ROUTE)
  }

  async function polish() {
    const revision = version.current
    setPolishing(true); setNotice(''); setError('')
    try {
      const response = await fetchWithTimeout('/api/feedback/suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating, message }),
      }, 15000)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'AI is unavailable right now. Your feedback is ready to send as-is.')
      if (revision !== version.current) return
      if (data.source === 'ai') {
        setMessage(data.message)
        keepDraft(rating, data.message)
        setNotice('AI polished your wording. Please review it before sending.')
      } else setNotice('AI is unavailable right now. You can edit or send the suggested wording as-is.')
    } catch (e) { setNotice(e instanceof Error ? e.message : 'AI is unavailable. Your text has been kept.') }
    finally { setPolishing(false) }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current || !validFeedback(rating, message) || !session) return
    lock.current = true; setBusy(true); setError('')
    if (!submissionId.current) submissionId.current = crypto.randomUUID()
    const payload = {
      id: submissionId.current,
      student_id: user?.id || '',
      email: user?.email || '',
      session_id: session,
      rating,
      message: message.trim(),
    }
    try {
      // One destination: our API, which writes the row to Supabase
      // (`feedback_submissions`). If Postgres is unreachable the server keeps the
      // row in its own retry queue and still answers 200, so the candidate is
      // released to their dashboard either way — an earlier build failed the
      // save, kept the "pending" ticket, and left them bouncing back here.
      const response = await fetchWithTimeout('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }, 20000)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Your feedback could not be saved. Please try again; your text is still here.')
      clearFeedbackPending()
      clearFeedbackDraft()
      markJustSubmitted()
      // Only say "still syncing" when a real database is pending; in fully local
      // demo mode the submission is simply saved.
      setStoredInQueue(!!data.queued && data.supabase_configured !== false)
      setSent(true)
    } catch (e) {
      setError(`${e instanceof Error ? e.message : 'Unable to send.'} Your text is saved on this device — try again, or continue to your dashboard and send it later.`)
    }
    finally { setBusy(false); lock.current = false }
  }

  if (!session) return <div role="status" className="min-h-screen grid place-items-center text-slate-500">Loading feedback…</div>

  return (
    <div className="min-h-screen px-4 py-6 sm:py-10">
      <header className="mx-auto max-w-5xl flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5"><img src="/logo.svg" alt="" className="h-9 w-9" /><span className="font-display text-lg font-extrabold text-slate-900">CalibiAI <span className="text-indigo-600">Score</span></span></div>
        <div className="flex items-center gap-2"><HelpButton /><span className="chip text-emerald-700 hidden sm:inline-flex"><CheckCircle2 size={14} /> Assessment complete</span></div>
      </header>
      <main className="max-w-2xl mx-auto py-10 sm:py-14">
        <div className="mb-8 flex items-center justify-center gap-3 text-xs font-semibold text-slate-500" aria-label="Assessment progress">
          <span className="flex items-center gap-2"><span className="h-6 w-6 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center"><Check size={14} /></span>Assessment</span>
          <span className="w-10 h-px bg-indigo-200" />
          <span className="flex items-center gap-2 text-indigo-700"><span className="h-6 w-6 rounded-full bg-indigo-600 text-white grid place-items-center">2</span>Feedback</span>
          <span className="w-10 h-px bg-slate-200" /><span>Dashboard</span>
        </div>
        <section className="glass-card relative overflow-hidden motion-safe:animate-fade-up">
          <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-400" />
          {sent ? <div className="text-center py-10 motion-safe:animate-fade-up">
            <div className="mx-auto h-20 w-20 rounded-full bg-emerald-100 text-emerald-600 grid place-items-center mb-6"><CheckCircle2 size={38} /></div>
            <h1 className="font-display text-3xl font-extrabold text-slate-900">Thank you for your feedback.</h1>
            <p className="mt-4 text-slate-500 leading-relaxed">
              Your voice helps us make the next assessment better.<br />
              {storedInQueue
                ? 'It has been saved and will finish syncing to your account shortly.'
                : 'Your feedback has been saved to your CalibiAI account.'}
            </p>
            <button onClick={() => router.replace(AFTER_ASSESSMENT_ROUTE)} className="btn-primary mt-8">Continue to dashboard <ArrowRight size={16} /></button>
          </div> : <>
            <div className="flex items-center justify-between mb-6"><div className="h-12 w-12 rounded-2xl bg-indigo-100 text-indigo-600 grid place-items-center"><MessageSquareHeart size={25} /></div><span className="chip border-violet-200 text-violet-700">One last step</span></div>
            <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900">How did we do?</h1>
            <p className="mt-3 text-sm sm:text-base leading-relaxed text-slate-500">You’ve done the hard part. Take a moment to rate your assessment and help us make it better.</p>
            <form onSubmit={submit} className="mt-7">
              <fieldset disabled={busy} className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-5 text-center">
                <legend className="px-2 text-sm font-semibold text-slate-700">Your assessment experience <span className="text-indigo-600">*</span></legend>
                <div className="flex justify-center gap-2 sm:gap-4" onMouseLeave={() => setHover(0)}>
                  {feedbackOptions.map((option, i) => <label key={option.label} className="relative cursor-pointer">
                    <input type="radio" name="rating" value={i + 1} checked={rating === i + 1} onChange={() => choose(i + 1)} required className="peer sr-only" aria-label={`${i + 1} ${i === 0 ? 'star' : 'stars'} — ${option.label}`} />
                    <span onMouseEnter={() => setHover(i + 1)} className={`flex h-11 w-11 sm:h-14 sm:w-14 items-center justify-center rounded-xl peer-focus-visible:ring-4 peer-focus-visible:ring-indigo-300 motion-safe:transition-all motion-safe:duration-200 motion-safe:hover:-translate-y-1 ${i < (hover || rating) ? 'bg-amber-50 text-amber-400 shadow-sm' : 'text-slate-300 bg-white/70'}`}><Star size={32} strokeWidth={1.5} fill={i < (hover || rating) ? 'currentColor' : 'none'} /></span>
                  </label>)}
                </div>
                <p className="mt-4 text-sm font-bold text-indigo-700 min-h-5" aria-live="polite">{rating ? feedbackOptions[rating - 1].label : 'Tap a star to get started'}</p>
                <div className="mt-2 flex justify-between text-[11px] text-slate-500 max-w-xs mx-auto"><span>Needs improvement</span><span>Excellent</span></div>
              </fieldset>
              <div className="flex flex-wrap items-center justify-between gap-3 mt-7 mb-3">
                <label htmlFor="feedback" className="text-sm font-bold text-slate-700">Tell us a little more <span className="text-indigo-600">*</span></label>
                <button type="button" onClick={polish} disabled={!validFeedback(rating, message) || polishing || busy} className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-40 focus-visible:outline-indigo-500">{polishing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}{polishing ? 'Polishing…' : 'Polish with AI'}</button>
              </div>
              <textarea id="feedback" required minLength={10} maxLength={1000} rows={5} disabled={busy} value={message} onChange={e => { version.current++; setMessage(e.target.value); keepDraft(rating, e.target.value); setNotice('') }} placeholder="Choose a star and we’ll suggest a starting point. Make it your own." className="field resize-y leading-relaxed" aria-describedby="feedback-help feedback-notice" />
              <div id="feedback-help" className="mt-2 flex justify-between gap-4 text-xs text-slate-500"><span>Your opinion, your words. 10 characters minimum.</span><span className="shrink-0 tabular-nums">{message.length}/1,000</span></div>
              <p id="feedback-notice" role="status" className="mt-3 text-xs leading-relaxed text-indigo-600">{notice}</p>
              <div className="mt-5 flex gap-2.5 rounded-xl bg-white/60 p-3 text-xs leading-relaxed text-slate-500"><ShieldCheck size={17} className="shrink-0 text-indigo-500" /><span>Feedback won’t affect your score. Your rating, comments and assessment ID are stored with your CalibiAI account and are visible to CalibiAI admins. AI polishing shares only your rating and comments with our AI provider.</span></div>
              {error && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
              <button type="submit" disabled={!validFeedback(rating, message) || busy || polishing} className="btn-primary w-full mt-6">{busy ? <><Loader2 size={16} className="animate-spin" />Saving feedback…</> : <>Submit feedback <ArrowRight size={16} /></>}</button>
              <button type="button" onClick={defer} disabled={busy} className="mt-3 w-full rounded-xl border border-slate-200 bg-white/70 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-white disabled:opacity-40">
                Skip for now — go to my dashboard and report
              </button>
              <p className="text-center text-xs text-slate-500 mt-3">Your score and full report are ready either way. We keep anything you have typed.</p>
            </form>
          </>}
        </section>
        <p className="mt-6 text-center text-xs text-slate-400">Better assessments start with honest feedback.</p>
      </main>
    </div>
  )
}
