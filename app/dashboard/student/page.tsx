'use client'
export const dynamic = 'force-dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FeedbackGate } from '@/components/FeedbackGate'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Navbar } from '@/components/Navbar'
import { useStore } from '@/lib/store'
import { isProfileComplete } from '@/lib/validate'
import { consumeJustSubmittedTicket } from '@/lib/justSubmitted'
import { readFeedbackDraft } from '@/lib/feedback'
import { flattenAssessmentResult } from '@/lib/resultShape'
import { getLiveUser } from '@/lib/session'
import { ReportModal } from '@/components/ReportModal'
import { SkillChips } from '@/components/SkillChips'
import { WhatsAppCommunityCard } from '@/components/WhatsAppCommunity'

function Inner(){
  const router = useRouter()
  const { user, profile, setProfile, resume, setResume, scores, setScores, hydrated, setUser, reconcileForUser } = useStore()
  const [showReport, setShowReport] = useState(false)
  const [downloading, setDownloading] = useState(false)
  // True only on the landing right after the assessment was submitted.
  const [justCompleted, setJustCompleted] = useState(false)
  // True when the candidate left the feedback step unfinished ("Skip for now"),
  // so the dashboard can offer to finish it — without ever forcing them back.
  const [feedbackPendingDraft, setFeedbackPendingDraft] = useState(false)
  const ticketChecked = useRef(false)
  // True once the cached account has been validated against Supabase Auth.
  const [validated, setValidated] = useState(false)

  // Protect the student dashboard: a signed-out visitor is sent to /login
  // smoothly, and a cached account is validated against Supabase Auth first so
  // a deleted-and-recreated account never sees the previous user's data.
  useEffect(()=>{
    if (!hydrated) return
    if (!user) { router.replace('/login'); return }
    let cancelled = false
    ;(async () => {
      const live = await getLiveUser()
      if (cancelled) return
      if (live === null) {
        localStorage.clear()
        setUser(null)
        router.replace('/login')
        return
      }
      if (live && live.id !== user.id) {
        await reconcileForUser(live)
      }
      setValidated(true)
    })()
    return () => { cancelled = true }
  // Only the account id controls this auth check. The store exposes setter
  // functions through context; depending on their render-time identities made
  // this effect run again after every profile/score update and created a
  // request storm (hundreds of /profiles and /assessment_results reads per
  // minute for one student).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[hydrated, user?.id])

  // The assessment page hands the candidate here after submitting and leaves a
  // single-use ticket behind, so this is where "assessment complete" is
  // acknowledged. `reactStrictMode` runs mount effects twice in development —
  // the ref keeps the (already consumed) ticket from being read twice.
  useEffect(()=>{
    if (ticketChecked.current) return
    ticketChecked.current = true
    setJustCompleted(consumeJustSubmittedTicket())
  },[])

  // Two housekeeping jobs on arrival:
  //  1. push any feedback/help request the server had to queue (a failed
  //     Supabase write is retried here, so nothing is ever lost), and
  //  2. notice an unfinished feedback draft so we can offer to complete it.
  useEffect(()=>{
    fetch('/api/feedback/flush', { method: 'POST' }).catch(()=>{})
    const checkDraft = () => setFeedbackPendingDraft(!!readFeedbackDraft())
    checkDraft()
    window.addEventListener('storage', checkDraft)
    return () => window.removeEventListener('storage', checkDraft)
  },[])

  // Enrich the (locally hydrated) store with the latest DB data when signed in.
  // Data is written through the store so the navbar and every other page sees
  // the same profile — including the full name set on the profile page.
  // Extracted into a `refresh` so it can also run on window focus (returning
  // from the edit-profile / update-resume pages) so the score is always live.
  // Focus events fire far more often than data changes (alt-tab, devtools,
  // notifications). Throttle background re-syncs to one per minute so a
  // student idling on the dashboard doesn't re-pull their rows constantly.
  const lastRefreshRef = useRef(0)
  const refresh = useCallback((force = false)=>{
    // Wait until the cached account has been validated (and possibly reconciled
    // to a different live user) so we never fetch the previous account's data.
    if(!user?.id || !validated) return
    const now = Date.now()
    if(!force && now - lastRefreshRef.current < 60000) return
    lastRefreshRef.current = now
    fetch('/api/user/profile?user_id='+user.id).then(r=>r.json()).then(data=>{
      if(data.profile) setProfile(data.profile)
    }).catch(()=>{})
    fetch('/api/user/resume?student_id='+user.id).then(r=>r.json()).then(data=>{
      if(data.analysis) setResume(data.analysis)
    }).catch(()=>{})
    fetch('/api/user/scores?student_id='+user.id).then(r=>r.json()).then(data=>{
      // Always write through — including `null` when there is no result, so a
      // stale cached score from a deleted/previous account never lingers on
      // screen or in the downloaded PDF.
      setScores(flattenAssessmentResult(data.result))
    }).catch(()=>{})
  // The setters are intentionally omitted: they are context wrappers whose
  // identity changes when the store updates. Including them recreates `refresh`,
  // which re-runs the forced refresh effect and loops back into Supabase.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[user?.id, validated])

  useEffect(()=>{
    refresh(true)
  },[refresh])

  // Re-sync when the user returns to this tab (e.g. after editing their profile
  // or resume on the dedicated pages) so the score reflects the latest data.
  useEffect(()=>{
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  },[refresh])

  if (!hydrated) {
    return (
      <div>
        <Navbar />
        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
          <div className="animate-pulse space-y-6">
            <div className="h-8 w-64 bg-slate-200/70 rounded-xl" />
            <div className="grid lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 glass-card h-80 bg-white/40" />
              <div className="glass-card h-80 bg-white/40" />
            </div>
          </div>
        </main>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="glass-card animate-fade-up flex items-center gap-3 px-6 py-4">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
          <span className="text-sm font-bold text-slate-700">Redirecting to login…</span>
        </div>
      </div>
    )
  }

  const onboarded = isProfileComplete(profile)
  const startHref = onboarded ? '/instructions' : '/onboarding'

  return (
    <div>
      <Navbar />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="animate-fade-up">
          <h1 className="text-2xl font-black text-slate-900">Hello{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''} 👋</h1>
          <p className="text-slate-500 text-sm mt-1">Here's your readiness overview and next steps.</p>
        </div>

        {/* Shown once, right after the assessment is submitted. */}
        {justCompleted && (
          <div className="mt-6 animate-fade-up rounded-3xl border border-emerald-200 bg-emerald-50/80 p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="text-2xl" aria-hidden>🎉</span>
                <div>
                  <div className="text-sm font-black text-emerald-800">Assessment submitted — your CalibiAI Score is ready</div>
                  <p className="mt-1 text-xs text-emerald-700">
                    This dashboard is your home from now on: score, full report, PDF download and resume all live here.
                  </p>
                </div>
              </div>
              {scores && (
                <button onClick={() => setShowReport(true)} className="btn-primary !py-2.5 text-xs">
                  View my full report →
                </button>
              )}
            </div>
          </div>
        )}

        {feedbackPendingDraft && (
          <div className="mt-6 animate-fade-up rounded-3xl border border-violet-200 bg-violet-50/80 p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="text-2xl" aria-hidden>💬</span>
                <div>
                  <div className="text-sm font-black text-violet-800">You skipped the feedback step</div>
                  <p className="mt-1 text-xs text-violet-700">
                    It takes 20 seconds and tells us what to improve. We kept what you typed.
                  </p>
                </div>
              </div>
              <Link href="/feedback" className="btn-primary !py-2.5 text-xs" onClick={()=>setFeedbackPendingDraft(false)}>
                Give feedback →
              </Link>
            </div>
          </div>
        )}

        <div className="mt-6 grid lg:grid-cols-3 gap-6">
          {/* Score */}
          <div className="lg:col-span-2 glass-card animate-fade-up" style={{animationDelay:'.05s'}}>
            <div className="text-sm font-bold text-slate-700">Latest CalibiAI Score</div>
            {scores ? (
              <div className="mt-4">
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="text-5xl font-black text-gradient">{scores.total}</span>
                  <span className="text-slate-400 font-bold">/1000</span>
                  <span className="chip text-indigo-700 border-indigo-200 bg-indigo-50/70">Grade {scores.grade} · {scores.percentile}th percentile</span>
                </div>
                <div className="mt-5 grid sm:grid-cols-2 gap-2.5">
                  {[
                    ['English', scores.english?.total ?? 0, 200],['Problem Solving', scores.problem_solving ?? 0, 200],
                    ['AI Debugging', scores.ai_debugging ?? 0, 150],['AI Feature Dev', scores.ai_feature ?? 0, 150],
                    ['Prompt Eng', scores.prompt_engineering ?? 0, 100],['Cognitive', scores.cognitive?.total ?? 0, 200],
                  ].map(([k,v,m])=>(
                    <div key={k as string} className="panel p-3">
                      <div className="flex justify-between text-xs mb-1"><span className="text-slate-600 font-medium">{k}</span><span className="font-mono font-bold text-slate-700">{v}/{m}</span></div>
                      <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className="h-full calibiai-gradient rounded-full" style={{width:`${(Number(v))/(Number(m))*100}%`}}/></div>
                    </div>
                  ))}
                </div>
                <div className="mt-5 flex flex-wrap gap-3">
                  <button onClick={() => setShowReport(true)} className="btn-primary !py-2.5 text-xs">View report</button>
                  <button
                    onClick={async () => {
                      setDownloading(true)
                      try {
                        const { generateReportPdf } = await import('@/lib/reportPdf')
                        const doc = await generateReportPdf({ scores, profile, user })
                        doc.save(`CalibiAI_Report_${scores?.session_id || 'scorecard'}.pdf`)
                      } catch (e) { console.warn('PDF generation failed:', e) }
                      finally { setDownloading(false) }
                    }}
                    disabled={downloading}
                    className="btn-soft !py-2.5 text-xs"
                  >
                    {downloading ? 'Preparing PDF…' : '⬇ Download PDF'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-6 rounded-2xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 p-8 text-center">
                <div className="text-4xl">🎯</div>
                <p className="mt-2 text-sm text-slate-500">You haven't taken the assessment yet.</p>
                <Link href={startHref} className="btn-primary mt-4 inline-flex">Start your assessment →</Link>
              </div>
            )}
          </div>

          {/* Side */}
          <div className="space-y-5">
            <div className="glass-card !p-5 animate-fade-up" style={{animationDelay:'.1s'}}>
              <div className="text-sm font-bold text-slate-700">Resume score</div>
              {resume ? (
                <div className="mt-3">
                  <div className="flex items-center gap-3">
                    <div className="w-14 h-14 rounded-full border-4 border-indigo-500 flex items-center justify-center font-black text-indigo-600">{resume.resume_score}</div>
                    <div className="text-xs text-slate-500">out of 100</div>
                  </div>
                  <div className="mt-3 text-xs font-bold text-emerald-600">Strengths</div>
                  <ul className="list-disc ml-4 text-xs text-slate-600">{(resume.feedback?.strengths || []).slice(0,2).map((s:string)=><li key={s}>{s}</li>)}</ul>
                  <Link href="/resume?edit=1" className="mt-3 inline-block text-xs font-semibold text-indigo-600">Update resume →</Link>
                </div>
              ) : <p className="text-xs text-slate-400 mt-2">No resume uploaded yet. <Link href="/resume?edit=1" className="text-indigo-600 font-semibold">Upload →</Link></p>}
            </div>

            <div className="rounded-3xl calibiai-gradient p-5 text-white shadow-xl shadow-indigo-200 animate-fade-up" style={{animationDelay:'.15s'}}>
              <div className="text-sm font-bold">Recommended next steps</div>
              <ul className="mt-2 text-xs space-y-1.5 opacity-95 list-disc ml-4">
                {scores?.cognitive?.behavioral ? <li>Strengthen your lower-scoring behavioural traits with team exercises</li> : <li>Take the 120-minute assessment to unlock your score</li>}
                <li>Practice prompt engineering with 3 daily drills</li>
                <li>Add quantified impact to your resume projects</li>
              </ul>
            </div>

            <div className="animate-fade-up" style={{animationDelay:'.2s'}}>
              <WhatsAppCommunityCard />
            </div>
          </div>
        </div>

        {/* Report pop-up */}
        {showReport && scores && (
          <ReportModal scores={scores} onClose={() => setShowReport(false)} />
        )}

        {/* Profile strip */}
        {profile && (
          <div className="glass-card !p-5 mt-6 animate-fade-up" style={{animationDelay:'.2s'}}>
            <div className="text-sm font-bold text-slate-700">Your profile</div>
            <div className="mt-2 text-sm text-slate-600 grid sm:grid-cols-3 gap-2">
              <div>👤 {profile.full_name || '—'}</div>
              <div>🎓 {profile.college || '—'}</div>
              <div className="sm:col-span-3 min-w-0"><SkillChips skills={profile.skills} icon="🛠️" /></div>
            </div>
            <Link href="/profile" className="mt-3 inline-block text-xs font-semibold text-indigo-600">See my profile →</Link>
            <Link href="/edit-profile" className="mt-3 ml-3 inline-block text-xs font-semibold text-indigo-600">Edit profile →</Link>
          </div>
        )}
      </main>
    </div>
  )
}
export default function Page(){ return <FeedbackGate><Inner/></FeedbackGate> }
