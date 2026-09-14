'use client'
import { useRouter } from 'next/navigation'
import { Navbar } from '@/components/Navbar'
import { useStore } from '@/lib/store'
import { Stepper } from '@/components/Stepper'
import { useEffect, useRef, useState } from 'react'
import { resolveInstructionsRedirect, safeRead } from '@/lib/attemptAccess'
import { AFTER_ASSESSMENT_ROUTE } from '@/lib/nextStep'

const ALLOCATION = [
  [1, 'English Communication', '15 min'],
  [2, 'Problem Solving', '20 min'],
  [3, 'AI-Assisted Debugging', '20 min'],
  [4, 'AI-Assisted Feature Development', '25 min'],
  [5, 'Prompt Engineering', '15 min'],
  [6, 'Cognitive Assessment', '25 min'],
]

const MODULES = [
  ['English Communication','200 pts · Listening, Speaking, Reading, Writing'],
  ['Problem Solving','200 pts · Logic, correctness, data interpretation'],
  ['AI-Assisted Debugging','150 pts · Fix buggy code (In-Exam AI Assistant · 5 prompts)'],
  ['AI-Assisted Feature Dev','150 pts · Build a feature (In-Exam AI Assistant · 5 prompts)'],
  ['Prompt Engineering','100 pts · 3 tasks, AI-rubric scored'],
  ['Cognitive Assessment','200 pts · Grid challenge, logical reasoning, behavioural'],
]

/** If the scores lookup stalls we still let the page through rather than
 *  leaving the visitor staring at a spinner forever. */
const SCORES_LOOKUP_TIMEOUT_MS = 2500

function Spinner() {
  return (
    <span
      className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"
      role="status"
      aria-label="Loading"
    />
  )
}

function Inner(){
  const router = useRouter()
  const {setSession, user, hydrated} = useStore()
  const [checked,setChecked]=useState(false)
  const [starting,setStarting]=useState(false)
  // One-time assessment: users who already have a result (local or DB) are sent
  // to their student dashboard instead of being able to start another attempt, and a user
  // mid-attempt goes straight back to the in-progress assessment.
  //
  // The page stays on `checking` until that decision is final, so the
  // instructions are never painted just to be thrown away a moment later by a
  // redirect (that paint-then-replace was the flicker).
  const [gate,setGate]=useState<'checking'|'show'>('checking')
  const navigatedRef = useRef(false)

  const go = (to: string) => {
    if (navigatedRef.current) return
    navigatedRef.current = true
    router.replace(to)
  }

  useEffect(() => {
    // Nothing is known until the store has read localStorage once.
    if (!hydrated) return

    const target = resolveInstructionsRedirect(safeRead)
    if (target) { go(target); return }

    // Signed out → there is no stored result to check server-side; show now.
    if (!user?.id) { setGate('show'); return }

    // Signed in → wait for the stored result so the page never appears for a
    // student who is then immediately sent to their report.
    let cancelled = false
    let settled = false
    const finish = () => { if (cancelled || settled) return; settled = true; setGate('show') }
    const timer = setTimeout(finish, SCORES_LOOKUP_TIMEOUT_MS)

    fetch('/api/user/scores?student_id=' + user.id)
      .then(r => r.json())
      .then(d => { if (cancelled) return; clearTimeout(timer); if (d?.result) go(AFTER_ASSESSMENT_ROUTE); else finish() })
      .catch(() => { clearTimeout(timer); finish() })

    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, user?.id])

  const start = async ()=>{
    if(starting) return
    setStarting(true)
    const now = Date.now()
    const seed = Math.floor(Math.random()*1_000_000_000)
    let session:any = null
    try {
      const userRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'demo@calibiai.local', password: 'demo' }),
      })
      const userData = await userRes.json()
      const studentId = userData?.user?.id || (user?.id || '')
      if (studentId) {
        const sessionRes = await fetch('/api/user/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ student_id: studentId, question_seed: seed }),
        })
        const sessionData = await sessionRes.json()
        if (sessionData.session) session = sessionData.session
      }
    } catch (e) { /* fall through */ }
    if (!session) {
      session = { id: 'sess_'+Math.random().toString(16).slice(2,10), student_id: user?.id || '', started_at: new Date(now).toISOString(), expires_at: new Date(now+7200*1000).toISOString(), duration_sec: 7200, status:'in_progress', question_seed: seed }
      try {
        await fetch('/api/user/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...session, student_id: user?.id || session.student_id || 'unknown' }),
        })
      } catch { /* demo mode */ }
    }
    try{
      localStorage.setItem('calibiai_session', JSON.stringify(session))
      localStorage.setItem('calibiai_session_server_start', String(now))
    }catch{ }
    setSession(session)
    // `replace` so the one-time instructions page doesn't linger in history —
    // the Back button should never walk a finished candidate through the flow.
    window.location.replace('/assessment')
  }

  // Same chrome as the real page, so nothing jumps when the content arrives —
  // only the card below the stepper swaps.
  if (gate !== 'show') {
    return (
      <div>
        <Navbar />
        <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
          <Stepper step={7} />
          <div className="mt-6 glass-card flex min-h-[22rem] flex-col items-center justify-center gap-3 text-center">
            <Spinner />
            <div className="text-sm font-bold text-slate-700">Checking your assessment status…</div>
            <div className="text-xs text-slate-400">This is a one-time attempt — making sure you land in the right place.</div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div>
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <Stepper step={7} />
        <div className="mt-6 grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 glass-card animate-fade-up">
            <h1 className="text-2xl font-black text-slate-900">Assessment instructions</h1>
            <p className="text-sm text-slate-500 mt-1">120 minutes · 6 sections · 1000 points. Take it somewhere quiet with a working camera and microphone.</p>

            <div className="mt-6 grid sm:grid-cols-2 gap-3 text-sm">
              {[
                ['⏱ Duration','120 min · auto-submits when time runs out · no pause'],
                ['🎥 Proctoring','Live camera preview (not recorded) · staying on-screen keeps it fair'],
                ['🎧 Listening','Two audio clips with questions — each plays up to 2 times'],
                ['🎙 Speaking','Two short spoken answers recorded from your microphone'],
              ].map(([t,d])=>(
                <div key={t} className="panel p-3"><div className="font-bold text-slate-800">{t}</div><div className="text-slate-500 text-xs mt-0.5">{d}</div></div>
              ))}
            </div>

            <h3 className="mt-7 font-black text-slate-900">The 6 sections</h3>
            <div className="mt-3 grid sm:grid-cols-2 gap-2.5">
              {MODULES.map(([t,d])=>(
                <div key={t} className="panel p-3"><div className="font-bold text-sm text-slate-800">{t}</div><div className="text-slate-500 text-xs mt-0.5">{d}</div></div>
              ))}
            </div>

            <h3 className="mt-7 font-black text-slate-900">Suggested time allocation</h3>
            <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-white/60 text-sm">
              <table className="w-full">
                <thead className="bg-slate-50 text-slate-500 text-xs">
                  <tr><th className="text-left px-4 py-2.5 w-14">Stage</th><th className="text-left px-4 py-2.5">Section</th><th className="text-right px-4 py-2.5 w-24">Time</th></tr>
                </thead>
                <tbody>
                  {ALLOCATION.map(([n,t,time])=>(
                    <tr key={n as number} className="border-t border-slate-100">
                      <td className="px-4 py-2.5 text-slate-400 font-mono">{n}</td>
                      <td className="px-4 py-2.5 font-medium text-slate-700">{t}</td>
                      <td className="px-4 py-2.5 text-right text-slate-500 font-mono">{time}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-slate-200 bg-indigo-50/60 font-bold text-indigo-700">
                    <td className="px-4 py-2.5" colSpan={2}>TOTAL</td>
                    <td className="px-4 py-2.5 text-right font-mono">120 min</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="mt-6 rounded-2xl bg-amber-50 border border-amber-200 p-4 text-xs leading-relaxed text-slate-600">
              <div className="font-bold text-amber-700 mb-1">Please note</div>
              <ul className="list-disc ml-4 space-y-1">
                <li><b>No tab switching:</b> Keep this tab/window focused — switching windows/tabs 3 times terminates and submits your test automatically.</li>
                <li><b>Close other tabs before starting:</b> When you start, the app will ask you to close every other tab/window (a webpage cannot close them for you). Please close them and confirm.</li>
                <li><b>Fullscreen is required:</b> The test locks you into fullscreen with right-click disabled. If you press Esc, fullscreen re-enters automatically, and leaving fullscreen mid-test is recorded as a violation. Disconnect any external or second display — if one is detected the test won't start, and connecting one mid-test terminates the assessment as cheating.</li>
                <li><b>In-Exam AI Assistant:</b> For AI Debugging and AI Feature Dev (Stages 3 & 4), an interactive AI assistant is embedded right below each coding task. You can ask questions, get explanations, and review code without leaving the tab. <b>It answers a maximum of 5 prompts per task and then locks</b> — so plan your best questions before asking.</li>
                <li>Your answers are saved automatically as you go.</li>
                <li>This is a one-time attempt — once submitted you can't retake it. You land on your student dashboard, where the report and PDF stay available.</li>
              </ul>
            </div>

            <label className="mt-6 flex gap-2 text-sm text-slate-700 cursor-pointer">
              <input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} className="accent-indigo-600 mt-0.5 w-4 h-4" />
              I have read and understood the instructions.
            </label>
            <button onClick={start} disabled={!checked || starting}
              className={`mt-4 w-full sm:w-auto px-8 py-3.5 rounded-full font-black text-sm transition ${checked && !starting ? 'btn-primary !py-3.5' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}>
              {starting ? 'Creating your session…' : 'START 120-MIN TIMER →'}
            </button>
          </div>

          <div className="space-y-4">
            <div className="glass-card animate-fade-up !p-5" style={{animationDelay:'.1s'}}>
              <div className="text-sm font-black text-slate-800">What happens next?</div>
              <ol className="mt-3 text-xs space-y-2 text-slate-500 list-decimal ml-4">
                <li>Your 120-minute timer starts</li>
                <li>Answer each of the 6 sections</li>
                <li>Submit when done (or it auto-submits)</li>
                <li>Get your CalibiAI Score out of 1000 + a PDF report</li>
              </ol>
            </div>
            <div className="rounded-3xl calibiai-gradient p-5 text-white shadow-xl shadow-indigo-200 animate-fade-up" style={{animationDelay:'.18s'}}>
              <div className="text-xs font-bold opacity-80">Score breakdown</div>
              <div className="mt-3 text-xs space-y-1.5 font-mono">
                {[['English','200'],['Problem Solving','200'],['AI Debugging','150'],['AI Feature','150'],['Prompt Eng','100'],['Cognitive','200']].map(([k,v])=>(
                  <div key={k} className="flex justify-between"><span>{k}</span><span>{v}</span></div>
                ))}
                <div className="flex justify-between font-black border-t border-white/30 pt-1.5"><span>Total</span><span>1000</span></div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
export default function Page(){ return <Inner/> }
