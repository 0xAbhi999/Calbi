'use client'
export const dynamic = 'force-dynamic'
import { useEffect, useState, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useStore } from '@/lib/store'
import { Maximize2, TriangleAlert } from 'lucide-react'
import { bank, shuffledOptions, shuffledChoiceOptions, mulberry32 } from '@/lib/questions'
import { computeScores } from '@/lib/scoring'
import { getSupabase } from '@/lib/supabase'
import { AFTER_ASSESSMENT_ROUTE } from '@/lib/nextStep'
import { markFeedbackPending } from '@/lib/feedback'
import { markJustSubmitted } from '@/lib/justSubmitted'
import { HelpButton } from '@/components/HelpButton'
import { Logo } from '@/components/Logo'
import { AiExamAssistant } from '@/components/AiExamAssistant'
import { AssessmentReview } from '@/components/AssessmentReview'
import { buildReview, type ReviewTarget } from '@/lib/reviewModel'
import { shouldCountListeningPlay, LISTENING_MAX_PLAYS } from '@/lib/listeningPlay'
import type { TestRunResult } from '@/lib/runTests'
import {
  MAX_FOCUS_STRIKES,
  classifyDisplayEvent,
  evaluateStartGate,
  safeRequestFullscreen,
  resolveScreenFacts,
  rightClickShouldBlock,
  FULLSCREEN_EXIT_MSG,
  DISPLAY_CONNECT_MSG,
  DISPLAY_CHANGE_MSG,
  watermarkIdentity,
  watermarkBackgroundImage,
  WATERMARK_TILE_WIDTH,
  WATERMARK_TILE_HEIGHT,
} from '@/lib/proctoring'
import type { ScreenFacts } from '@/lib/proctoring'

const STAGES = [
  { id: 'english', label: 'English Communication', sub: ['Listening', 'Speaking', 'Reading', 'Writing'], min: 15 },
  { id: 'problem', label: 'Problem Solving', sub: [], min: 20 },
  { id: 'debugging', label: 'AI-Assisted Debugging', sub: [], min: 20 },
  { id: 'feature', label: 'AI Feature Development', sub: [], min: 25 },
  { id: 'prompt', label: 'Prompt Engineering', sub: [], min: 15 },
  { id: 'cognitive', label: 'Cognitive Assessment', sub: ['Grid Challenge', 'Logical Reasoning', 'Behavioural'], min: 25 },
]

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

// Minimum length a prompt submission must reach before the AI will even grade
// it — anything shorter scores 0. Mirrors MIN_PROMPT_CHARS on the server.
const MIN_PROMPT_CHARS = 100

/* ------------------------------------------------------------------ */
/* Subsection auto-advance — when a candidate finishes one subsection   */
/* (e.g. Listening) they glide automatically into the next one (e.g.   */
/* Speaking). Applies to the two stages that HAVE subsections: English */
/* (Listening/Speaking/Reading/Writing) and Cognitive (Grid / Logical  */
/* Reasoning / Behavioural).                                           */
/* ------------------------------------------------------------------ */

// Writing counts as "done" for auto-advance once it has real content —
// deliberately lower than the 150-word scoring target so candidates are
// never trapped; they can always come back and keep writing.
const WRITING_AUTONEXT_WORDS = 50
// How long the "moving to …" banner shows before gliding forward.
const AUTONEXT_DELAY_MS = 2800

// A single real violation fires several overlapping signals (window blur +
// visibilitychange + a fullscreen exit detected by the 1.5s monitor, e.g. when
// a native dialog steals focus). Within this window those are coalesced into
// ONE warning instead of cascading straight to the 3-warning auto-submit.
const STRIKE_COOLDOWN_MS = 2500

const wordCount = (t: string) => (t || '').trim().split(/\s+/).filter(Boolean).length

export type SubProgress = { answered: number; total: number; complete: boolean }

function getSubProgress(
  stageId: string,
  subIdx: number,
  answers: Record<string, any>,
  gridInfo: { rounds: number; doneRounds: number },
): SubProgress {
  if (stageId === 'english') {
    if (subIdx === 0) {
      const qs: any[] = bank.english.listening.clips.flatMap((c: any) => c.questions)
      const answered = qs.filter(q => answers[q.id] != null && answers[q.id] !== '').length
      return { answered, total: qs.length, complete: answered >= qs.length }
    }
    if (subIdx === 1) {
      const answered = (answers['SP1_audio'] ? 1 : 0) + (answers['SP2_audio'] ? 1 : 0)
      return { answered, total: 2, complete: answered >= 2 }
    }
    if (subIdx === 2) {
      const qs: any[] = bank.english.reading.questions
      const answered = qs.filter(q => answers[q.id] != null && answers[q.id] !== '').length
      return { answered, total: qs.length, complete: answered >= qs.length }
    }
    const words = wordCount(answers['WRITING'] || '')
    return { answered: Math.min(words, WRITING_AUTONEXT_WORDS), total: WRITING_AUTONEXT_WORDS, complete: words >= WRITING_AUTONEXT_WORDS }
  }
  if (stageId === 'cognitive') {
    if (subIdx === 0) {
      const done = answers['GRID'] !== undefined
      return {
        answered: done ? gridInfo.rounds : Math.min(gridInfo.doneRounds, gridInfo.rounds),
        total: gridInfo.rounds,
        complete: done,
      }
    }
    if (subIdx === 1) {
      const qs: any[] = bank.cognitive.logical
      const answered = qs.filter(q => answers[q.id] != null && answers[q.id] !== '').length
      return { answered, total: qs.length, complete: answered >= qs.length }
    }
    const qs: any[] = bank.cognitive.behavioral
    const answered = qs.filter(q => typeof answers[q.id] === 'number').length
    return { answered, total: qs.length, complete: answered >= qs.length }
  }
  return { answered: 0, total: 0, complete: false }
}

// Linear navigation across (stage, sub): next/prev subsection, spilling over
// into the neighbouring stage when at a boundary.
function nextLocation(stage: number, sub: number): { stage: number; sub: number } | null {
  const subs = STAGES[stage].sub
  if (sub < subs.length - 1) return { stage, sub: sub + 1 }
  if (stage < STAGES.length - 1) return { stage: stage + 1, sub: 0 }
  return null
}
function prevLocation(stage: number, sub: number): { stage: number; sub: number } | null {
  if (sub > 0) return { stage, sub: sub - 1 }
  if (stage > 0) {
    const ps = stage - 1
    const lastSub = Math.max(0, STAGES[ps].sub.length - 1)
    return { stage: ps, sub: STAGES[ps].sub.length ? lastSub : 0 }
  }
  return null
}
function locationLabel(stage: number, sub: number): string {
  const s = STAGES[stage]
  return s.sub.length ? s.sub[sub] : s.label
}

/* ------------------------------------------------------------------ */
/* Presentational sub-components — hoisted OUTSIDE the assessment      */
/* component. Defining them inline caused React to remount them on     */
/* every render (e.g. each timer tick), which is what made the AI      */
/* feedback box flicker. These are stable component types now.         */
/* ------------------------------------------------------------------ */

function OptionList({ qid, options, seed, value, onChange, accent = 'indigo' }: {
  qid: string; options: string[]; seed: number; value?: string;
  onChange: (v: string) => void; accent?: 'indigo' | 'violet'
}) {
  const opts = useMemo(() => shuffledOptions(options, seed, qid), [qid, options, seed])
  const sel = accent === 'violet' ? 'bg-violet-600 text-white border-violet-500' : 'bg-indigo-600 text-white border-indigo-500'
  return (
    <div className="space-y-2">
      {opts.map(opt => (
        <label key={opt} className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer border transition ${value === opt ? `${sel} shadow-md` : 'bg-white/70 border-slate-200 hover:bg-white hover:shadow-sm'}`}>
          <input type="radio" name={qid} checked={value === opt} onChange={() => onChange(opt)} className={accent === 'violet' ? 'accent-violet-600' : 'accent-indigo-600'} />
          <span className="text-sm">{opt}</span>
        </label>
      ))}
    </div>
  )
}

function AiFeedback({ r }: { r: any }) {
  if (!r) return null
  return (
    <div className="mt-3 rounded-2xl bg-emerald-50/80 border border-emerald-200 p-3.5 text-sm animate-fade-up">
      <div className="flex items-center justify-between">
        <span className="font-bold text-emerald-700">AI score: {r.score}/100</span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white text-emerald-700 border border-emerald-200">{r.engine === 'calibiai' ? 'CalibiAI' : 'rule engine'}</span>
      </div>
      {r.rubric && Object.keys(r.rubric).length > 0 && (
        <div className="mt-2 space-y-1.5">
          {Object.entries(r.rubric).map(([k, v]: any) => (
            <div key={k} className="flex items-center gap-2 text-xs">
              <span className="w-40 capitalize text-slate-500">{k.replace(/_/g, ' ')}</span>
              <div className="flex-1 h-1.5 rounded-full bg-emerald-100 overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${v}%` }} /></div>
              <span className="w-8 text-right font-mono text-slate-600">{v}</span>
            </div>
          ))}
        </div>
      )}
      {r.strengths?.length > 0 && <div className="mt-2 text-xs text-emerald-700"><b>Strengths:</b> {r.strengths.join(' • ')}</div>}
      {r.improvements?.length > 0 && <div className="mt-1 text-xs text-amber-700"><b>Improve:</b> {r.improvements.join(' • ')}</div>}
      {r.summary && <div className="mt-1 text-xs text-slate-500 italic">{r.summary}</div>}
    </div>
  )
}

function EvalButton({ id, busy, onRun }: { id: string; busy?: boolean; onRun: () => void }) {
  return (
    <button disabled={busy} onClick={onRun}
      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold shadow-sm shadow-violet-300 disabled:opacity-50 transition active:scale-95">
      {busy ? 'Evaluating…' : '✨ Evaluate with AI'}
    </button>
  )
}

function TestFeedback({ r, taskId }: { r?: TestRunResult; taskId: string }) {
  if (!r) return null
  const tone = r.passed === r.total && r.total > 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
    : r.passed > 0 ? 'bg-amber-50 border-amber-200 text-amber-700'
    : 'bg-rose-50 border-rose-200 text-rose-700'
  return (
    <div className={`mt-2 rounded-2xl border p-3.5 text-sm ${tone} animate-fade-up`}>
      <div className="flex items-center justify-between">
        <span className="font-bold">{r.passed}/{r.total} tests passed</span>
        {r.timedOut && <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white">timed out</span>}
      </div>
      {r.error && <div className="mt-1 text-xs opacity-90">⚠ {r.error}</div>}
      {r.results.length > 0 && (
        <ul className="mt-2 space-y-1">
          {r.results.map((t, i) => (
            <li key={i} className="flex items-center gap-2 text-xs">
              <span className={t.passed ? 'text-emerald-600 font-bold' : 'text-rose-500 font-bold'}>{t.passed ? '✓' : '✗'}</span>
              <span className={t.passed ? 'text-emerald-700' : 'text-rose-600'}>{t.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AssessmentInner() {
  const router = useRouter()
  const { session, setSession, setScores, user } = useStore()
  const [answers, setAnswers] = useState<Record<string, any>>({})
  const [aiResults, setAiResults] = useState<Record<string, any>>({})
  const [stage, setStage] = useState(0)
  const [sub, setSub] = useState(0)
  // Slide direction for the subsection transition ('next' slides in from the
  // right, 'prev' from the left). Reset after each navigation.
  const [direction, setDirection] = useState<'next' | 'prev' | null>(null)
  // Candidate-controllable auto-advance (persisted). When ON, finishing a
  // subsection glides them into the next one after a short banner.
  // Initialised to ON for SSR parity; the stored preference is applied once
  // mounted (avoids a hydration mismatch for returning candidates).
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true)
  // Pending auto hop: { toStage, toSub, fromLabel, toLabel, countdown }
  const [pendingAdvance, setPendingAdvance] = useState<{
    toStage: number; toSub: number; fromLabel: string; toLabel: string; secs: number
  } | null>(null)
  const [activeDebuggingTask, setActiveDebuggingTask] = useState(0)
  const [remaining, setRemaining] = useState(7200)
  const [strikes, setStrikes] = useState(0)
  const [showViolation, setShowViolation] = useState(false)
  // Live reason shown in the warning / terminated modals (tab-focus vs.
  // fullscreen vs. external-display events all flow through the same UI).
  const [violationMsg, setViolationMsg] = useState('')
  const [cheatReason, setCheatReason] = useState<string | null>(null)
  const [terminated, setTerminated] = useState(false)
  // Pre-test environment gate — the test content stays locked behind this until
  // the candidate enters fullscreen, passes the external-display check and
  // confirms they have closed other tabs. See `lib/proctoring.ts`.
  const [envState, setEnvState] = useState<'gate' | 'blocked' | 'cleared'>('gate')
  const [envBlockReason, setEnvBlockReason] = useState<string | null>(null)
  const [envConsent, setEnvConsent] = useState(false)
  const [envBusy, setEnvBusy] = useState(false)
  // True when the candidate denied (or the browser blocked) the fullscreen
  // permission at the pre-test gate — fullscreen is a hard requirement, so the
  // test must not start in a normal window.
  const [fsBlocked, setFsBlocked] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Whether fullscreen was actually engaged at the gate (state twin of
  // envFsEngagedRef so the UI can render on it).
  const [fsEngaged, setFsEngaged] = useState(false)
  const [mediaReady, setMediaReady] = useState(false)
  const [mediaError, setMediaError] = useState('')
  const [videoOn, setVideoOn] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [recording, setRecording] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [playCounts, setPlayCounts] = useState<Record<string, number>>({})
  const [showHint, setShowHint] = useState<Record<string, boolean>>({})
  const [testResults, setTestResults] = useState<Record<string, TestRunResult | undefined>>({})
  // Pre-submit review page. `reviewMode`:
  //   'manual' — candidate-initiated submit; can jump back to any question.
  //   'auto'   — time-up / 3 warnings; read-only, no returning to the exam.
  const [showReview, setShowReview] = useState(false)
  const [reviewMode, setReviewMode] = useState<'manual' | 'auto' | null>(null)
  const [autoSubmitReason, setAutoSubmitReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  const gridCfg = bank.cognitive.grid
  const [gridRound, setGridRound] = useState(0)
  const [gridPattern, setGridPattern] = useState<number[]>([])
  const [gridShow, setGridShow] = useState(false)
  const [gridSelected, setGridSelected] = useState<number[]>([])
  const [gridScores, setGridScores] = useState<number[]>([])
  const gridHideAt = useRef(0)

  const intervalRef = useRef<any>(null)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const proctorStreamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const awayRef = useRef(false)
  const suppressRef = useRef(false)
  // Timer that re-arms the proctoring monitors once a native fullscreen
  // permission prompt has been answered (see `enterFullscreen` below).
  const fsSuppressTimerRef = useRef<any>(null)
  // Throttled server autosave (see the `[answers, sid]` effect below). The
  // browser keeps every keystroke in localStorage; Postgres only receives a
  // checkpoint at most once per 10 seconds. The final submit always sends the
  // complete answer set, so this is a durability checkpoint rather than a
  // source of truth.
  const autosaveTimerRef = useRef<any>(null)
  const autosaveLastSentRef = useRef(0)
  const strikesRef = useRef(0)
  // Timestamp of the last recorded strike — used to coalesce the burst of
  // blur/visibility/fullscreen events a single action produces.
  const lastStrikeAtRef = useRef(0)
  const submitRef = useRef<(auto?: boolean) => void>(() => {})
  // Auto-submit (time-up / 3 warnings) opens the read-only review page. These
  // refs keep the latest closure + a once-only guard reachable from the
  // mount-time timer interval declared further down.
  const autoSubmitRef = useRef<(reason: string) => void>(() => {})
  const autoReviewRef = useRef(false)
  // Snapshot of the screen captured when the pre-test gate was cleared, so the
  // live monitor can compare it against later states to detect an external
  // display being connected or the tab moving to another screen.
  const envLastFactsRef = useRef<ScreenFacts | null>(null)
  // Whether fullscreen was actually entered at the gate (only then is exiting
  // fullscreen mid-test meaningful to enforce).
  const envFsEngagedRef = useRef(false)
  const mediaReadyRef = useRef(false)
  // Auto-advance bookkeeping: was the CURRENT subsection already complete on
  // the last check (prevents re-triggering when navigating back to a
  // finished subsection), plus the timers driving the countdown banner.
  const wasCompleteRef = useRef(false)
  const autoTimerRef = useRef<any>(null)
  const autoTickRef = useRef<any>(null)
  const mainCardRef = useRef<HTMLDivElement | null>(null)

  const seed: number = session?.question_seed ?? 8675309
  const sid = session?.id

  // Leak-prevention watermark: a faint, tiled "candidate-id · CALIBIAI" text is
  // overlaid across the whole test screen while it is live, so any screenshot
  // or photo of a mirrored screen identifies who leaked it. Stable per identity
  // (memoised) so it doesn't flicker or reshuffle on every render.
  const watermarkText = useMemo(
    () => watermarkIdentity({ name: user?.name, email: user?.email, id: user?.id, sessionId: sid }),
    [user?.name, user?.email, user?.id, sid],
  )
  const watermarkStyle = useMemo(
    () => ({
      backgroundImage: watermarkBackgroundImage(watermarkText),
      backgroundSize: `${WATERMARK_TILE_WIDTH}px ${WATERMARK_TILE_HEIGHT}px`,
    }),
    [watermarkText],
  )

  useEffect(() => {
    // Read session from localStorage.
    let cancelled = false
    let intervalId: any = null
    let pollId: any = null
    let attempts = 0

    const boot = (raw: string) => {
      if (cancelled) return
      let s: any = null
      try { s = JSON.parse(raw) } catch { s = null }
      if (s?.status === 'submitted' || s?.status === 'expired') { router.replace(AFTER_ASSESSMENT_ROUTE); return }
      if (localStorage.getItem('calibiai_scores')) { router.replace(AFTER_ASSESSMENT_ROUTE); return }
      if (!s?.id || !s?.expires_at) { router.replace(localStorage.getItem('calibiai_scores') ? AFTER_ASSESSMENT_ROUTE : '/instructions'); return }
      if (!session) setSession(s)
      try {
        const a = localStorage.getItem('calibiai_answers_' + s.id); if (a) setAnswers(JSON.parse(a))
        const ai = localStorage.getItem('calibiai_ai_' + s.id); if (ai) setAiResults(JSON.parse(ai))
      } catch { }
      const expires = new Date(s.expires_at).getTime()
      const tick = () => {
        const rem = Math.max(0, Math.floor((expires - Date.now()) / 1000))
        setRemaining(rem)
        if (rem <= 0) autoSubmitRef.current('Time is up — your assessment ended automatically.')
      }
      tick()
      intervalId = setInterval(tick, 1000)
      pollId = setInterval(tick, 5000)
      intervalRef.current = intervalId
    }

    const tryLoad = () => {
      if (cancelled) return
      const raw = localStorage.getItem('calibiai_session')
      if (raw) { boot(raw); return }
      attempts += 1
      if (attempts >= 8) { router.replace(localStorage.getItem('calibiai_scores') ? AFTER_ASSESSMENT_ROUTE : '/instructions'); return }
      setTimeout(tryLoad, 50)
    }
    tryLoad()

    return () => {
      cancelled = true
      clearInterval(intervalId)
      clearInterval(pollId)
      clearInterval(intervalRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (sid) {
      localStorage.setItem('calibiai_answers_' + sid, JSON.stringify(answers))
      // Server autosave is debounced AND throttled: typing a sentence would
      // otherwise fire a write after every pause. LocalStorage is the fast,
      // per-keystroke recovery layer; Postgres is a checkpoint no more often
      // than once per 10 seconds. The final submit persists the latest state.
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      const minInterval = 10_000
      const wait = Math.max(1_500, minInterval - (Date.now() - autosaveLastSentRef.current))
      autosaveTimerRef.current = setTimeout(() => {
        autosaveTimerRef.current = null
        autosaveLastSentRef.current = Date.now()
        fetch('/api/user/assessment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sid, student_id: user?.id || '', answers, status: 'in_progress' }),
        }).catch(() => { /* localStorage remains the recovery layer */ })
      }, wait)
    }
  }, [answers, sid, user?.id])
  useEffect(() => { if (sid) localStorage.setItem('calibiai_ai_' + sid, JSON.stringify(aiResults)) }, [aiResults, sid])

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3200) }

  /* ------------------------------------------------------------------ */
  /* Permission-prompt suppression guard                                 */
  /*                                                                     */
  /* Asking the browser for a NEW permission (camera, mic, fullscreen,   */
  /* screen-list) pops a NATIVE prompt that takes focus away from the    */
  /* page and, in some browsers, briefly drops out of fullscreen. None   */
  /* of that is a real tab-switch / fullscreen-exit, so it must never    */
  /* count as a proctoring violation or fire the re-enter-fullscreen     */
  /* lock. This guard holds `suppressRef` true for the whole native      */
  /* prompt window (until the browser resolves it, plus a small buffer   */
  /* for the trailing blur/visibility/fullscreenchange burst) so the     */
  /* violation monitors stay quiet while the user simply grants a        */
  /* permission. Every request that can raise a native prompt must run   */
  /* through it.                                                         */
  /* ------------------------------------------------------------------ */
  const withPromptGuard = async <T,>(fn: () => Promise<T>): Promise<T> => {
    suppressRef.current = true
    if (fsSuppressTimerRef.current) { clearTimeout(fsSuppressTimerRef.current); fsSuppressTimerRef.current = null }
    try {
      return await fn()
    } finally {
      // Absorb the trailing blur/visibility/fullscreenchange burst that
      // follows the user answering the prompt, then re-arm the monitors.
      fsSuppressTimerRef.current = setTimeout(() => {
        suppressRef.current = false
        fsSuppressTimerRef.current = null
      }, 1500)
    }
  }

  // Request fullscreen while pausing the focus/fullscreen proctoring monitors.
  // The native "Allow fullscreen?" permission prompt blurs the window (and some
  // browsers briefly report the page as not-fullscreen) — none of that is a real
  // tab switch or fullscreen exit, so it must not count as a warning.
  const enterFullscreen = async (): Promise<boolean> => {
    return withPromptGuard(async () => {
      let engaged = false
      try {
        engaged = await safeRequestFullscreen(document)
      } catch {
        engaged = false
      }
      return engaged
    })
  }

  // Release the proctoring camera + microphone stream and its preview, and stop
  // any in-flight speaking MediaRecorder. Call once whenever the assessment
  // concludes so the camera/mic light turns off and the stream is freed.
  // This pure version never touches React state, so it is safe to call from an
  // unmount cleanup (state updates are meaningless once the tree is gone).
  const stopTracks = () => {
    // Stop an active speaking-recording MediaRecorder first.
    try { mediaRef.current?.stop() } catch { /* already stopped */ }
    mediaRef.current = null
    // Stop every track of the proctoring stream (camera + mic).
    proctorStreamRef.current?.getTracks().forEach(t => t.stop())
    proctorStreamRef.current = null
    // Detach the preview so the video element fully releases the device.
    if (videoRef.current) {
      try { videoRef.current.srcObject = null } catch { /* noop */ }
    }
  }
  // Stateful twin of stopTracks for use while the page is still mounted, so the
  // live-preview UI reflects the camera being released.
  const releaseMedia = () => {
    stopTracks()
    setVideoOn(false)
    setMediaReady(false)
    mediaReadyRef.current = false
  }

  const enableMedia = async () => {
    setMediaError('')
    // Asking for the camera/mic raises a native permission prompt that steals
    // focus — suppress it so it never becomes a proctoring violation.
    await withPromptGuard(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        proctorStreamRef.current = stream
        setMediaReady(true); mediaReadyRef.current = true; setVideoOn(true)
      } catch (e: any) {
        setMediaError(e?.name === 'NotAllowedError'
          ? 'Camera/mic permission was denied. The live preview is off, but focus monitoring is still active.'
          : 'No camera/mic detected on this device. Focus monitoring is still active.')
        setMediaReady(true); mediaReadyRef.current = true
      }
    })
  }

  useEffect(() => {
    if (videoRef.current && proctorStreamRef.current) {
      videoRef.current.srcObject = proctorStreamRef.current
      videoRef.current.play().catch(() => {})
    }
  }, [mediaReady, videoOn])

  useEffect(() => {
    const onLeave = () => {
      if (!mediaReadyRef.current || suppressRef.current || terminated) return
      if (document.hidden || !document.hasFocus()) {
        if (awayRef.current) return
        // Coalesce the burst of events a single action produces (e.g. a native
        // dialog firing blur + visibilitychange together) into one warning.
        if (Date.now() - lastStrikeAtRef.current < STRIKE_COOLDOWN_MS) return
        lastStrikeAtRef.current = Date.now()
        awayRef.current = true
        const n = strikesRef.current + 1
        strikesRef.current = n
        setStrikes(n)
        setViolationMsg('You left the assessment window. Switching away is recorded as a proctoring violation.')
        if (n >= 3) { setShowViolation(false); autoSubmitRef.current('You reached 3 focus warnings — your assessment ended automatically.') }
        else setShowViolation(true)
      }
    }
    document.addEventListener('visibilitychange', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      document.removeEventListener('visibilitychange', onLeave)
      window.removeEventListener('blur', onLeave)
    }
  }, [terminated])

  useEffect(() => () => {
    // Assessment page is leaving (submit → results, session already finished,
    // or the user navigated/closed away) — release the camera/mic now.
    stopTracks()
    if (fsSuppressTimerRef.current) clearTimeout(fsSuppressTimerRef.current)
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
  }, [])

  /* ------------------------------------------------------------------ */
  /* Anti-cheat environment lock                                         */
  /*                                                                     */
  /* 1. Right-click context menu is disabled for the whole live test     */
  /*    screen (page-level lock only — a tab cannot disable the OS menu  */
  /*    or browser shortcuts).                                           */
  /* 2. A monitor runs once the environment gate has been cleared. It    */
  /*    compares fresh screen snapshots against the one captured at the  */
  /*    gate to catch an external display being plugged in (treated as   */
  /*    cheating → immediate auto-submit) or the tab leaving fullscreen  */
  /*    / moving onto another screen (counted like a focus violation).   */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (envState !== 'cleared' || terminated) return
    const onCtx = (e: Event) => {
      if (rightClickShouldBlock(true).block) e.preventDefault()
    }
    document.addEventListener('contextmenu', onCtx)
    return () => document.removeEventListener('contextmenu', onCtx)
  }, [envState, terminated])

  useEffect(() => {
    if (envState !== 'cleared' || terminated) return
    let running = false

    const bumpStrike = (msg: string) => {
      if (terminated || submittingRef.current || suppressRef.current) return
      // Same coalescing as onLeave — a fullscreen exit that follows a blur from
      // the same user action must not count as a second, separate strike.
      if (Date.now() - lastStrikeAtRef.current < STRIKE_COOLDOWN_MS) return
      lastStrikeAtRef.current = Date.now()
      const n = strikesRef.current + 1
      strikesRef.current = n
      setStrikes(n)
      setViolationMsg(msg)
      if (n >= MAX_FOCUS_STRIKES) {
        setShowViolation(false)
        autoSubmitRef.current('You reached 3 focus warnings — your assessment ended automatically.')
      } else {
        setShowViolation(true)
      }
    }

    // Cheating signal (an extra display appeared mid-test) → immediate end.
    const hardTerminate = (msg: string) => {
      if (terminated || submittingRef.current) return
      setCheatReason(msg)
      setStrikes(MAX_FOCUS_STRIKES)
      setShowViolation(false)
      setTerminated(true)
      submitRef.current(true)
    }

    const monitor = async () => {
      if (running || submittingRef.current) return
      running = true
      try {
        const now = await resolveScreenFacts(window)
        const last = envLastFactsRef.current
        if (!last) { envLastFactsRef.current = now; return }
        // Leaving fullscreen is only meaningful if we actually entered it.
        if (envFsEngagedRef.current && last.fullscreen && !now.fullscreen) {
          bumpStrike(FULLSCREEN_EXIT_MSG)
        }
        const ev = classifyDisplayEvent(last, now)
        if (ev === 'display_connect') { hardTerminate(DISPLAY_CONNECT_MSG); envLastFactsRef.current = now; return }
        if (ev === 'display_layout_change') bumpStrike(DISPLAY_CHANGE_MSG)
        envLastFactsRef.current = now
      } finally {
        running = false
      }
    }

    const id = window.setInterval(monitor, 1500)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envState, terminated])

  // Keep the header button in sync with the real fullscreen state.
  useEffect(() => {
    const sync = () => setIsFullscreen(!!document.fullscreenElement)
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  // Lock the candidate in fullscreen for the whole live test. Pressing Esc (or
  // any other fullscreen exit) re-enters fullscreen automatically. Browsers
  // briefly refuse a programmatic re-entry right after an Esc exit, so we retry
  // a few times; the header's fullscreen button remains a one-click fallback
  // (a real user gesture always succeeds).
  useEffect(() => {
    if (envState !== 'cleared' || terminated) return
    if (!fsEngaged) return // fullscreen never engaged → nothing to re-enter
    let attempts = 0
    let timer: any = null

    const reenter = () => {
      // Skip while a native permission prompt (camera/mic/fullscreen) is up —
      // requesting fullscreen then would just re-prompt and could blur-flicker.
      if (suppressRef.current || document.fullscreenElement || submittingRef.current) return
      const attempt = async () => {
        if (suppressRef.current || document.fullscreenElement || submittingRef.current) return
        const ok = await safeRequestFullscreen(document)
        if (ok) {
          showToast('Fullscreen restored — it must stay on for the whole test.')
        } else {
          attempts += 1
          if (attempts < 6) {
            clearTimeout(timer)
            timer = setTimeout(attempt, 500)
          } else {
            showToast('⚠ Fullscreen was exited — click the ⛶ button in the header to go back.')
          }
        }
      }
      attempt()
    }

    const onFsChange = () => {
      if (suppressRef.current) return
      if (!document.fullscreenElement) reenter()
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envState, terminated, fsEngaged])

  // Pre-start environment check — runs (and must pass) BEFORE the test is
  // reachable. Tries to enter fullscreen, enumerates displays via the
  // Window-Management API where available, and blocks the start if more than
  // one display is reachable.
  const runEnvCheck = async () => {
    setEnvBusy(true)
    setFsBlocked(false)
    try {
      // `enterFullscreen` never rejects — it returns false when the user denies
      // (or the browser's Permissions Policy blocks) fullscreen, e.g. embedded
      // in an iframe without `allow="fullscreen"`, so no unhandled rejection
      // can surface as a runtime error.
      const fsEngaged = await enterFullscreen()
      envFsEngagedRef.current = fsEngaged
      setFsEngaged(fsEngaged)
      setIsFullscreen(!!document.fullscreenElement)

      if (!fsEngaged) {
        // Fullscreen is a hard requirement. If the candidate denied the
        // permission we keep the gate locked and ask them to enable it instead
        // of letting the test run in a normal window.
        setFsBlocked(true)
        setEnvState('gate')
        return
      }

      const facts = await resolveScreenFacts(window)
      const verdict = evaluateStartGate(facts)
      if (!verdict.allow) {
        setEnvBlockReason(verdict.reason)
        setEnvState('blocked')
        return
      }
      envLastFactsRef.current = facts
      setEnvBlockReason(null)
      setEnvState('cleared')
    } catch {
      setEnvBlockReason('The environment check could not run in this browser. Please close other tabs, disable screen mirroring, and try again.')
      setEnvState('blocked')
    } finally {
      setEnvBusy(false)
    }
  }

  useEffect(() => {
    if (stage !== 5 || sub !== 0) return
    const rng = mulberry32(seed + gridRound * 101 + 7)
    const set = new Set<number>()
    while (set.size < gridCfg.patternSize) set.add(Math.floor(rng() * gridCfg.gridCells))
    setGridPattern([...set]); setGridShow(true); setGridSelected([])
    const t = setTimeout(() => { setGridShow(false); gridHideAt.current = Date.now() }, gridCfg.showMs)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, sub, gridRound])

  const handleAnswer = (qid: string, val: any) => setAnswers(a => ({ ...a, [qid]: val }))

  const runAi = async (key: string, kind: any, payload: any) => {
    setBusy(b => ({ ...b, [key]: true }))
    try {
      const res = await fetch('/api/ai/evaluate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, ...payload }),
      })
      const data = await res.json()
      if (data.ok) setAiResults(prev => ({ ...prev, [key]: data.result }))
      else showToast('Evaluation failed — the built-in engine will score this on submit.')
    } catch { showToast('AI evaluation offline — the built-in engine will score this on submit.') }
    finally { setBusy(b => ({ ...b, [key]: false })) }
  }

  // Real test-runner for the coding modules
  const runTests = async (taskId: string, code: string) => {
    const key = taskId + '_tests'
    setBusy(b => ({ ...b, [key]: true }))
    setTestResults(prev => ({ ...prev, [taskId]: undefined }))
    try {
      const res = await fetch('/api/user/assessment/runtests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, code }),
      })
      const data = await res.json()
      if (data.ok) setTestResults(prev => ({ ...prev, [taskId]: data }))
      else showToast(data.error || 'Could not run the tests.')
    } catch { showToast('Test runner offline.') }
    finally { setBusy(b => ({ ...b, [key]: false })) }
  }

  const startRecording = async (id: string) => {
    try {
      const proctorAudio = proctorStreamRef.current?.getAudioTracks()[0]
      // Only request a fresh mic stream when we don't already own one from the
      // proctor stream — and when we do (e.g. the candidate continued without
      // camera), wrap it so the NATIVE mic permission prompt that appears
      // mid-test never counts as a proctoring violation.
      const acquireStream = () =>
        proctorAudio
          ? Promise.resolve(new MediaStream([proctorAudio]))
          : navigator.mediaDevices.getUserMedia({ audio: true })
      const stream = await withPromptGuard(acquireStream)
      const ownsStream = !proctorAudio
      // Prefer Opus-in-WebM explicitly and cap the bitrate at 32 kbps: speech
      // stays perfectly intelligible while uploads shrink ~4x vs the browser
      // default (~128 kbps) — a 2-minute answer drops from ~1.9MB to ~0.5MB.
      // That is what keeps the free Supabase Storage quota (1GB) alive once
      // hundreds of candidates record speaking answers.
      let mime = ''
      for (const cand of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
        try { if (MediaRecorder.isTypeSupported(cand)) { mime = cand; break } } catch { /* ignore */ }
      }
      const rec = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 32000,
      })
      chunksRef.current = []
      rec.ondataavailable = e => chunksRef.current.push(e.data)
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        if (ownsStream) stream.getTracks().forEach(t => t.stop())
        const ext = blob.type.includes('mp4') || blob.type.includes('m4a') ? 'm4a' : 'webm'
        const meta = { name: id + '.' + ext, size: blob.size, type: blob.type, at: new Date().toISOString(), uploaded: false }
        const sb = getSupabase()
        if (sb && sid) {
          try {
            const { data: { user } } = await sb.auth.getUser()
            if (user) {
              const up = await sb.storage.from('speaking').upload(`${user.id}/${sid}/${id}.${ext}`, blob, { contentType: blob.type, upsert: true })
              if (!up.error) meta.uploaded = true
            }
          } catch { }
        }
        handleAnswer(id + '_audio', meta)
        setRecording(null)
      }
      rec.start(); mediaRef.current = rec; setRecording(id)
    } catch {
      showToast('Microphone access is needed for the speaking task — please allow the mic and try again.')
    }
  }
  const stopRecording = () => mediaRef.current?.stop()

  const speakingCount = (answers['SP1_audio'] ? 1 : 0) + (answers['SP2_audio'] ? 1 : 0)

  /* ---------------- Subsection-aware navigation ---------------- */
  const clearPendingAdvance = () => {
    setPendingAdvance(null)
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
    if (autoTickRef.current) clearInterval(autoTickRef.current)
    autoTimerRef.current = null
    autoTickRef.current = null
  }

  const navigateTo = (nStage: number, nSub: number, dir: 'next' | 'prev' | null) => {
    if (nStage === stage && nSub === sub) return
    clearPendingAdvance()
    if (dir) setDirection(dir)
    setStage(nStage)
    setSub(nSub)
    // Glide the new subsection into view (the sticky header offsets it).
    requestAnimationFrame(() => {
      try {
        mainCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } catch { window.scrollTo({ top: 0, behavior: 'smooth' }) }
    })
  }

  const goNext = () => {
    const n = nextLocation(stage, sub)
    if (n) navigateTo(n.stage, n.sub, 'next')
  }
  const goPrev = () => {
    const p = prevLocation(stage, sub)
    if (p) navigateTo(p.stage, p.sub, 'prev')
  }

  const goNowAdvance = () => {
    if (!pendingAdvance) return
    const { toStage, toSub } = pendingAdvance
    navigateTo(toStage, toSub, 'next')
  }

  // Load + persist the auto-advance preference (client only).
  const autoPrefLoaded = useRef(false)
  useEffect(() => {
    try {
      if (localStorage.getItem('calibiai_autoadvance') === 'off') setAutoAdvance(false)
    } catch { }
    autoPrefLoaded.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!autoPrefLoaded.current) return
    try { localStorage.setItem('calibiai_autoadvance', autoAdvance ? 'on' : 'off') } catch { }
    if (!autoAdvance) clearPendingAdvance()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAdvance])

  // Current-subsection progress (English + Cognitive have subsections).
  const gridInfo = { rounds: gridCfg.rounds, doneRounds: gridScores.length }
  const currentProgress: SubProgress = getSubProgress(STAGES[stage].id, sub, answers, gridInfo)
  const stageHasSubs = STAGES[stage].sub.length > 0

  // Whenever we ARRIVE at a (stage, sub), snapshot its completion state so
  // that navigating back to an already-finished subsection does NOT
  // instantly re-trigger auto-advance — only a fresh incomplete→complete
  // transition while viewing it does.
  useEffect(() => {
    clearPendingAdvance()
    wasCompleteRef.current = getSubProgress(
      STAGES[stage].id, sub, answers, { rounds: gridCfg.rounds, doneRounds: gridScores.length },
    ).complete
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, sub])

  // Watch for the completion moment → start the countdown banner, then glide.
  useEffect(() => {
    if (terminated) return
    if (!mediaReady || !stageHasSubs || !autoAdvance) {
      // Keep the snapshot in sync even while gated/disabled so that enabling
      // the camera (or the toggle) on an already-complete subsection does
      // NOT instantly trigger a hop — only a fresh answer does.
      wasCompleteRef.current = currentProgress.complete
      return
    }
    const justCompleted = currentProgress.complete && !wasCompleteRef.current
    wasCompleteRef.current = currentProgress.complete
    if (!justCompleted || autoTimerRef.current) return
    const next = nextLocation(stage, sub)
    if (!next) {
      showToast('Behavioural complete ✓ — review your answers and submit when ready.')
      return
    }
    const fromLabel = locationLabel(stage, sub)
    const toLabel = locationLabel(next.stage, next.sub)
    const totalSecs = Math.max(1, Math.round(AUTONEXT_DELAY_MS / 1000))
    setPendingAdvance({ toStage: next.stage, toSub: next.sub, fromLabel, toLabel, secs: totalSecs })
    autoTickRef.current = setInterval(() => {
      setPendingAdvance(prev => {
        if (!prev) return prev
        if (prev.secs <= 1) return prev
        return { ...prev, secs: prev.secs - 1 }
      })
    }, 1000)
    autoTimerRef.current = setTimeout(() => {
      navigateTo(next.stage, next.sub, 'next')
    }, AUTONEXT_DELAY_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, gridScores, stageHasSubs, autoAdvance, mediaReady, terminated])

  // If the subsection becomes incomplete again while the banner is showing
  // (e.g. writing trimmed below the threshold), cancel the hop.
  useEffect(() => {
    if (!currentProgress.complete && autoTimerRef.current) clearPendingAdvance()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProgress.complete])

  // Clear timers on unmount.
  useEffect(() => () => {
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
    if (autoTickRef.current) clearInterval(autoTickRef.current)
  }, [])

  // Runs the real submission. `auto` = triggered by the timer running out or
  // the 3rd focus warning (auto_submitted, status "expired"); manual confirms
  // from the review page call it with auto=false (status "submitted").
  const doSubmit = async (auto = false) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setShowReview(false)
    clearInterval(intervalRef.current)
    // The assessment is over — release the camera/mic stream automatically so
    // the device stops recording the moment submission begins.
    releaseMedia()
    const scores = computeScores(answers, aiResults, { gridAcc: answers['GRID'], speakingCount })
    const payload = { session_id: sid || 'sess_demo', ...scores, tab_switches: strikes, auto_submitted: !!auto, submitted_at: new Date().toISOString() }
    localStorage.setItem('calibiai_scores', JSON.stringify(payload))
    setScores(payload)
    // The server API is the single persistence boundary. The previous client
    // implementation also called Supabase directly after these two API calls,
    // which duplicated every final session/result write and bypassed the
    // server's deterministic id mapping and retry/error handling. Apart from
    // doubling database work, that race could leave the session and result out
    // of sync. Keep browser code transport-only; the API owns Postgres writes.
    try {
      await fetch('/api/user/assessment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid, student_id: user?.id || '', answers, status: auto ? 'expired' : 'submitted', tab_switches: strikes, submitted_at: new Date().toISOString() }),
      })
      await fetch('/api/user/assessment/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid, student_id: user?.id || 'unknown', scores: payload, total: payload.total, grade: payload.grade, percentile: payload.percentile, verifiable_hash: payload.verifiable_hash, ai_feedback: aiResults }),
      })
    } catch (e) { /* demo mode */ }
    const s = JSON.parse(localStorage.getItem('calibiai_session') || '{}')
    s.status = 'submitted'
    localStorage.setItem('calibiai_session', JSON.stringify(s))
    // Timestamped ticket: it expires, and a stale one is cleared by
    // FeedbackGate, so a failed feedback save can never strand the candidate.
    markFeedbackPending(sid || 'sess_demo')
    markJustSubmitted()
    router.replace('/feedback')
  }
  useEffect(() => { submitRef.current = doSubmit })

  // Automatic submission (timer expiry or the 3rd focus warning) opens the same
  // review page in READ-ONLY mode: the candidate can see exactly what was
  // submitted, but cannot return to the exam. The actual network submission
  // runs when they tap "Continue to results" (→ doSubmit(true)).
  const beginAutoSubmit = (reason: string) => {
    if (autoReviewRef.current || submittingRef.current) return
    autoReviewRef.current = true
    setAutoSubmitReason(reason)
    setShowViolation(false)
    setTerminated(true)
    setReviewMode('auto')
    setShowReview(true)
    // Assessment is over (time-up / 3rd warning) — turn the camera & mic off
    // now rather than keeping them live through the read-only review page.
    releaseMedia()
  }
  useEffect(() => { autoSubmitRef.current = beginAutoSubmit })

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  const critical = remaining < 600

  // Pre-submit review model: every section/question with answered status.
  const review = useMemo(() => buildReview(bank, answers), [bank, answers])

  const requestSubmit = () => {
    if (terminated || submittingRef.current) return
    setReviewMode('manual')
    setShowReview(true)
  }

  // Jump from the review page back to a specific question (manual mode only —
  // the read-only auto review never calls this).
  const jumpToQuestion = (target: ReviewTarget) => {
    setShowReview(false)
    if (target.task !== undefined) setActiveDebuggingTask(target.task)
    navigateTo(target.stage, target.sub, target.stage > stage ? 'next' : target.stage < stage ? 'prev' : null)
  }

  if (!session) return <div className="p-16 text-center text-slate-500">Loading your session…</div>

  const renderStage = () => {
    switch (STAGES[stage].id) {
      case 'english':
        if (sub === 0) {
          return (
            <div className="space-y-5">
              <p className="text-xs text-slate-500">{bank.english.listening.instruction}</p>
              {bank.english.listening.clips.map((c: any) => {
                const plays = playCounts[c.id] || 0
                return (
                  <div key={c.id} className="panel p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-bold text-slate-800">🎧 {c.title}</div>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100 shrink-0">plays {plays}/{LISTENING_MAX_PLAYS}</span>
                    </div>
                    <audio controls className="w-full mt-3" src={c.audio}
                      onPlay={(e) => {
                        const el = e.currentTarget
                        const plays = playCounts[c.id] || 0
                        // Hard stop once both listens are used.
                        if (plays >= LISTENING_MAX_PLAYS) { el.pause(); return }
                        // Only a play that starts from the beginning counts —
                        // seeking/skipping or resuming mid-clip must not burn
                        // one of the two listens.
                        if (shouldCountListeningPlay(el.currentTime, plays)) {
                          setPlayCounts(p => ({ ...p, [c.id]: plays + 1 }))
                        }
                      }} />
                    <div className="mt-1 text-[11px] text-slate-400">
                      {plays >= LISTENING_MAX_PLAYS
                        ? 'Play limit reached — answer from memory.'
                        : `Each clip can be replayed from the start up to ${LISTENING_MAX_PLAYS} times — skipping within a clip doesn't count.`}
                    </div>
                    <div className="mt-4 space-y-4">
                      {c.questions.map((q: any) => (
                        <div key={q.id} className="p-3.5 rounded-xl bg-white/70 border border-slate-200">
                          <div className="text-sm font-semibold text-slate-800 mb-2.5">{q.question}</div>
                          <OptionList qid={q.id} options={q.options} seed={seed} value={answers[q.id]} onChange={(v) => handleAnswer(q.id, v)} />
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        }
        if (sub === 1) {
          return (
            <div className="space-y-5">
              <p className="text-xs text-slate-500">{bank.english.speaking.instruction}</p>
              {bank.english.speaking.tasks.map((t: any) => {
                const rec = answers[t.id + '_audio']
                return (
                  <div key={t.id} className="panel p-4">
                    <div className="text-sm font-bold text-slate-800">{t.label}</div>
                    <div className="text-sm text-slate-600 mt-1">{t.prompt}</div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button onClick={() => recording === t.id ? stopRecording() : startRecording(t.id)}
                        className={`px-4 py-2 rounded-full text-xs font-bold transition ${recording === t.id ? 'bg-rose-500 text-white animate-pulse shadow shadow-rose-300' : rec ? 'bg-emerald-500 text-white shadow shadow-emerald-300' : 'btn-primary !py-2 !px-4'}`}>
                        {recording === t.id ? '● Recording… click to stop' : rec ? '✓ Recorded — re-record' : '● Start recording'}
                      </button>
                      {rec && <span className="text-xs text-emerald-600 font-medium">Saved {rec.name} ({Math.round(rec.size / 1024)} KB){rec.uploaded ? ' · uploaded' : ''}</span>}
                    </div>
                    {recording === t.id && (
                      <div className="mt-3 h-9 rounded-xl bg-slate-100 border border-slate-200 flex items-center px-3 gap-1">
                        {Array.from({ length: 28 }).map((_, i) => <div key={i} className="w-1 bg-indigo-400 rounded-full" style={{ height: `${8 + ((i * 37) % 22)}px` }} />)}
                        <span className="ml-2 text-xs text-slate-400">Recording…</span>
                      </div>
                    )}
                  </div>
                )
              })}
              <div className="flex flex-wrap items-center gap-3">
                <EvalButton id="SP_speaking" busy={busy['SP_speaking']} onRun={() => runAi('SP_speaking', 'speaking', { recordingCount: speakingCount })} />
                <span className="text-xs text-slate-400">Your spoken answer is recorded for fluency, pronunciation, confidence and grammar.</span>
              </div>
              {speakingCount === 0 && (
                <div className="mt-1 text-xs font-semibold text-amber-600">⚠ No audio recorded yet — the AI will score this 0 until you record a task.</div>
              )}
              <AiFeedback r={aiResults['SP_speaking']} />
            </div>
          )
        }
        if (sub === 2) {
          return (
            <div className="grid lg:grid-cols-2 gap-4">
              <div className="panel p-4 h-fit">
                <div className="text-xs font-bold text-indigo-600 mb-2">📖 Passage</div>
                <p className="text-sm leading-relaxed text-slate-700">{bank.english.reading.passage}</p>
              </div>
              <div className="space-y-3">
                <p className="text-xs text-slate-500">{bank.english.reading.instruction}</p>
                {bank.english.reading.questions.map((q: any, i: number) => (
                  <div key={q.id} className="panel p-3.5">
                    <div className="text-sm font-semibold text-slate-800 mb-2.5">{i + 1}. {q.question}</div>
                    <OptionList qid={q.id} options={q.options} seed={seed} value={answers[q.id]} onChange={(v) => handleAnswer(q.id, v)} />
                  </div>
                ))}
              </div>
            </div>
          )
        }
        const w = bank.english.writing
        return (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">{w.instruction}</p>
            <div className="panel p-4">
              <div className="text-sm font-bold text-slate-800">✍️ Writing — scenario</div>
              <div className="mt-2 text-sm text-slate-600 p-3.5 rounded-xl bg-indigo-50/70 border border-indigo-100">{w.scenario}</div>
              <textarea value={answers['WRITING'] || ''} onChange={e => handleAnswer('WRITING', e.target.value)} placeholder="Dear [Client], ..." className="field mt-3 min-h-[180px] leading-relaxed" />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                <span>{(answers['WRITING'] || '').trim().split(/\s+/).filter(Boolean).length} words · target 150–300</span>
                <EvalButton id="WRITING" busy={busy['WRITING']} onRun={() => runAi('WRITING', 'writing', { text: answers['WRITING'] || '', scenario: w.scenario })} />
              </div>
              <AiFeedback r={aiResults['WRITING']} />
            </div>
          </div>
        )

      case 'problem':
        return (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">Logic, approach, correctness and data interpretation. Options are shuffled for your session.</p>
            {bank.problem.map((q: any, i: number) => (
              <div key={q.id} className="panel p-3.5">
                <div className="text-sm font-semibold text-slate-800 mb-2.5">{i + 1}. {q.q}</div>
                <OptionList qid={q.id} options={q.options} seed={seed} value={answers[q.id]} onChange={(v) => handleAnswer(q.id, v)} />
              </div>
            ))}
          </div>
        )

      case 'debugging': {
        const d = bank.debugging[activeDebuggingTask] || bank.debugging[0]

        return (
          <div className="space-y-4">
            {/* Stage Banner */}
            <div className="rounded-2xl p-4 bg-gradient-to-r from-indigo-900 via-indigo-800 to-violet-900 text-white shadow-md flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center text-lg">
                  🤖
                </div>
                <div>
                  <div className="text-xs font-black tracking-wide flex items-center gap-2">
                    <span>AI-Assisted Debugging Stage</span>
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/30 text-emerald-300 text-[10px] font-bold border border-emerald-400/30">
                      In-Exam Assistant Active
                    </span>
                  </div>
                  <div className="text-[11px] text-indigo-200 mt-0.5">
                    Proctored assessment — do not switch browser tabs. Use the AI Assistant below to ask questions about bugs, edge cases, or review your code. <b className="text-white">You have 5 assistant prompts for this task — use them wisely.</b>
                  </div>
                </div>
              </div>
            </div>

            {/* Task Sub-Navigation Tabs */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {bank.debugging.map((task: any, idx: number) => {
                const filled = !!answers[task.id + '_fix']
                const testRes = testResults[task.id]
                const isPassed = testRes && testRes.passed === testRes.total && testRes.total > 0
                return (
                  <button
                    key={task.id}
                    onClick={() => setActiveDebuggingTask(idx)}
                    className={`shrink-0 px-4 py-2 rounded-2xl text-xs font-bold border transition-all duration-200 flex items-center gap-2 ${
                      activeDebuggingTask === idx
                        ? 'calibiai-gradient text-white border-transparent shadow-md shadow-indigo-200 scale-[1.02]'
                        : 'bg-white/80 border-slate-200 text-slate-700 hover:bg-white hover:shadow-sm'
                    }`}
                  >
                    <span>Task {idx + 1}: {task.title.split('—')[0].trim()}</span>
                    {isPassed ? (
                      <span className="w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-emerald-300/40" title="All tests passed" />
                    ) : filled ? (
                      <span className="w-2 h-2 rounded-full bg-indigo-300" title="Draft saved" />
                    ) : null}
                  </button>
                )
              })}
            </div>

            {/* Active Debugging Task Panel */}
            <div key={d.id} className="panel p-5 space-y-4 animate-fade-in">
              <div className="flex items-center justify-between flex-wrap gap-2 border-b border-slate-200/70 pb-3">
                <div>
                  <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">
                    Task {activeDebuggingTask + 1} of {bank.debugging.length}
                  </span>
                  <h3 className="text-base font-black text-slate-900 mt-0.5">{d.title}</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 font-semibold">
                    {d.tests} hidden tests
                  </span>
                  <span className="text-[11px] font-mono px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                    {d.id.startsWith('AD2') ? 'JavaScript' : 'Python'}
                  </span>
                </div>
              </div>

              {/* Buggy Code Box */}
              <div>
                <div className="flex items-center justify-between text-xs font-bold text-slate-700 mb-1.5">
                  <span className="flex items-center gap-1.5">
                    <span className="text-rose-500 font-mono font-bold">●</span> Buggy Code:
                  </span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(d.buggy)
                      showToast('Buggy code copied!')
                    }}
                    className="text-[11px] text-indigo-600 hover:text-indigo-800 font-semibold"
                  >
                    Copy buggy code
                  </button>
                </div>
                <pre className="code-panel p-3.5 text-xs overflow-x-auto whitespace-pre-wrap leading-relaxed">{d.buggy}</pre>
              </div>

              {/* Requirement & Hint */}
              <div className="p-3.5 rounded-2xl bg-slate-50/80 border border-slate-200/80 text-xs text-slate-700 space-y-2">
                <div className="font-bold text-slate-900">Task Requirement:</div>
                <p className="leading-relaxed text-slate-600">{d.prompt}</p>
                <div>
                  <button
                    onClick={() => setShowHint((h) => ({ ...h, [d.id]: !h[d.id] }))}
                    className="text-[11px] text-indigo-600 font-bold hover:underline inline-flex items-center gap-1"
                  >
                    {showHint[d.id] ? '▲ Hide hint' : '💡 Show hint'}
                  </button>
                  {showHint[d.id] && (
                    <div className="mt-1.5 text-[11px] text-indigo-800 bg-indigo-50/90 border border-indigo-100 rounded-xl p-2.5 animate-fade-in">
                      {d.hint}
                    </div>
                  )}
                </div>
              </div>

              {/* Code Editor */}
              <div>
                <div className="flex items-center justify-between text-xs font-bold text-slate-700 mb-1.5">
                  <span className="flex items-center gap-1.5">
                    <span className="text-emerald-500 font-mono font-bold">●</span> Your Corrected Solution:
                  </span>
                  <div className="flex items-center gap-2.5">
                    <span className="text-[11px] font-mono text-slate-400">
                      {(answers[d.id + '_fix'] || '').length} chars
                    </span>
                    <button
                      onClick={() => handleAnswer(d.id + '_fix', d.buggy)}
                      className="text-[11px] text-slate-500 hover:text-slate-800 underline"
                      title="Reset editor to original buggy code"
                    >
                      Reset to buggy
                    </button>
                  </div>
                </div>
                <textarea
                  value={answers[d.id + '_fix'] || ''}
                  onChange={(e) => handleAnswer(d.id + '_fix', e.target.value)}
                  placeholder={`# Write or paste your corrected ${d.id.startsWith('AD2') ? 'JavaScript' : 'Python'} code here...\n# You can also use the AI assistant below to explain the bug, suggest approaches, or review your code.`}
                  className="field min-h-[160px] font-mono !text-xs leading-relaxed shadow-sm"
                  spellCheck={false}
                />
              </div>

              {/* Action Buttons Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => runTests(d.id, answers[d.id + '_fix'] || '')}
                    disabled={busy[d.id + '_tests']}
                    className="btn-soft !py-2 !px-4 !text-xs font-bold disabled:opacity-50 inline-flex items-center gap-1.5 shadow-sm"
                  >
                    {busy[d.id + '_tests'] ? 'Running tests…' : '▶ Run hidden tests'}
                  </button>
                  <EvalButton
                    id={d.id}
                    busy={busy[d.id]}
                    onRun={() =>
                      runAi(d.id, 'debugging', {
                        taskId: d.id,
                        buggy: d.buggy,
                        prompt: d.prompt,
                        fix: answers[d.id + '_fix'] || '',
                      })
                    }
                  />
                </div>

                {/* Sub-task Switcher */}
                <div className="flex items-center gap-2">
                  <button
                    disabled={activeDebuggingTask === 0}
                    onClick={() => setActiveDebuggingTask((i) => Math.max(0, i - 1))}
                    className="px-3 py-1.5 rounded-xl border border-slate-200 bg-white/80 text-xs font-semibold hover:bg-white disabled:opacity-30 transition"
                  >
                    ← Prev Task
                  </button>
                  <span className="text-xs font-mono text-slate-400">
                    {activeDebuggingTask + 1}/{bank.debugging.length}
                  </span>
                  <button
                    disabled={activeDebuggingTask === bank.debugging.length - 1}
                    onClick={() => setActiveDebuggingTask((i) => Math.min(bank.debugging.length - 1, i + 1))}
                    className="px-3 py-1.5 rounded-xl border border-slate-200 bg-white/80 text-xs font-semibold hover:bg-white disabled:opacity-30 transition"
                  >
                    Next Task →
                  </button>
                </div>
              </div>

              {/* Real Test & AI Evaluation Feedback */}
              <TestFeedback r={testResults[d.id]} taskId={d.id} />
              <AiFeedback r={aiResults[d.id]} />

              {/* Embedded In-Exam AI Assistant */}
              <AiExamAssistant
                taskId={d.id}
                taskTitle={d.title}
                taskPrompt={d.prompt}
                buggyOrSpec={d.buggy}
                currentCode={answers[d.id + '_fix'] || ''}
                onApplyCode={(codeSnippet) => {
                  handleAnswer(d.id + '_fix', codeSnippet)
                  showToast('✨ Applied AI code to your editor!')
                }}
              />
            </div>
          </div>
        )
      }

      case 'feature': {
        const f = bank.feature
        return (
          <div className="space-y-4">
            {/* Stage Banner */}
            <div className="rounded-2xl p-4 bg-gradient-to-r from-indigo-900 via-indigo-800 to-violet-900 text-white shadow-md flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center text-lg">
                  🚀
                </div>
                <div>
                  <div className="text-xs font-black tracking-wide flex items-center gap-2">
                    <span>AI-Assisted Feature Development Stage</span>
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/30 text-emerald-300 text-[10px] font-bold border border-emerald-400/30">
                      In-Exam Assistant Active
                    </span>
                  </div>
                  <div className="text-[11px] text-indigo-200 mt-0.5">
                    Proctored mode active. Build the sliding-window rate limiter & Express middleware. Ask the AI assistant below for architecture, code examples, or reviews without switching tabs. <b className="text-white">You have 5 assistant prompts for this task — use them wisely.</b>
                  </div>
                </div>
              </div>
            </div>

            <div className="panel p-5 space-y-4 animate-fade-in">
              <div className="flex items-center justify-between flex-wrap gap-2 border-b border-slate-200/70 pb-3">
                <div>
                  <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">
                    Feature Implementation
                  </span>
                  <h3 className="text-base font-black text-slate-900 mt-0.5">{f.title}</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 font-semibold">
                    {f.tests} tests
                  </span>
                  <span className="text-[11px] font-mono px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                    Node.js + Express
                  </span>
                </div>
              </div>

              {/* Spec & Sample */}
              <div className="p-3.5 rounded-2xl bg-slate-50/80 border border-slate-200/80 text-xs text-slate-700 space-y-2.5">
                <div className="font-bold text-slate-900">Specification:</div>
                <p className="leading-relaxed text-slate-600">{f.spec}</p>
                <div>
                  <span className="font-semibold text-slate-900 block mb-1">Sample Behavior:</span>
                  <div className="code-panel p-3 text-xs overflow-x-auto">{f.sample}</div>
                </div>
                <div>
                  <button
                    onClick={() => setShowHint((h) => ({ ...h, AF1: !h.AF1 }))}
                    className="text-[11px] text-indigo-600 font-bold hover:underline inline-flex items-center gap-1"
                  >
                    {showHint.AF1 ? '▲ Hide hint' : '💡 Show hint'}
                  </button>
                  {showHint.AF1 && (
                    <div className="mt-1.5 text-[11px] text-indigo-800 bg-indigo-50/90 border border-indigo-100 rounded-xl p-2.5 animate-fade-in">
                      {f.hint}
                    </div>
                  )}
                </div>
              </div>

              {/* Code Editor */}
              <div>
                <div className="flex items-center justify-between text-xs font-bold text-slate-700 mb-1.5">
                  <span className="flex items-center gap-1.5">
                    <span className="text-emerald-500 font-mono font-bold">●</span> Your Node / Express Implementation:
                  </span>
                  <span className="text-[11px] font-mono text-slate-400">
                    {(answers['AF1_code'] || '').length} chars
                  </span>
                </div>
                <textarea
                  value={answers['AF1_code'] || ''}
                  onChange={(e) => handleAnswer('AF1_code', e.target.value)}
                  placeholder={`// Implement sliding-window rate limiter function:\nfunction isAllowed(userId, maxRequests = 5, windowMs = 60000) {\n  // Store and clean timestamps per user\n}\n\n// Express middleware wiring (return 429 + Retry-After header):\nfunction rateLimitMiddleware(req, res, next) {\n  // ...\n}`}
                  className="field min-h-[220px] font-mono !text-xs leading-relaxed shadow-sm"
                  spellCheck={false}
                />
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={() => runTests('AF1', answers['AF1_code'] || '')}
                  disabled={busy['AF1_tests']}
                  className="btn-soft !py-2 !px-4 !text-xs font-bold disabled:opacity-50 inline-flex items-center gap-1.5 shadow-sm"
                >
                  {busy['AF1_tests'] ? 'Running tests…' : '▶ Run feature tests'}
                </button>
                <EvalButton
                  id="AF1"
                  busy={busy['AF1']}
                  onRun={() =>
                    runAi('AF1', 'feature', {
                      spec: f.spec,
                      code: answers['AF1_code'] || '',
                    })
                  }
                />
              </div>

              {/* Real Test & AI Evaluation Feedback */}
              <TestFeedback r={testResults['AF1']} taskId="AF1" />
              <AiFeedback r={aiResults['AF1']} />

              {/* Embedded In-Exam AI Assistant */}
              <AiExamAssistant
                taskId="AF1"
                taskTitle={f.title}
                taskPrompt={f.spec}
                buggyOrSpec={f.sample}
                currentCode={answers['AF1_code'] || ''}
                onApplyCode={(codeSnippet) => {
                  handleAnswer('AF1_code', codeSnippet)
                  showToast('✨ Applied AI implementation to your editor!')
                }}
              />
            </div>
          </div>
        )
      }

      case 'prompt':
        return (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">Write a prompt that makes an AI solve the task. Graded on role, context, constraints, output format and specificity.</p>
            {bank.prompt.map((t: any) => (
              <div key={t.id} className="panel p-4">
                <div className="text-sm font-bold text-slate-800">{t.id} — Prompt Engineering</div>
                <div className="mt-1 text-sm text-slate-600">{t.task}</div>
                <div className="text-xs text-slate-400">Hint: {t.hint}</div>
                <textarea value={answers[t.id] || ''} onChange={e => handleAnswer(t.id, e.target.value)} placeholder="Act as… Your task is… Constraints:… Output format:…" className="field mt-3 min-h-[110px]" />
                <div className="mt-1 flex items-center justify-between text-xs">
                  <span className={`font-semibold ${(answers[t.id] || '').length >= MIN_PROMPT_CHARS ? 'text-emerald-600' : (answers[t.id] || '').length > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                    {(answers[t.id] || '').length} / {MIN_PROMPT_CHARS} chars min
                  </span>
                  {answers[t.id] && (answers[t.id] as string).length < MIN_PROMPT_CHARS && (
                    <span className="font-semibold text-amber-600">Keep writing — too short scores 0</span>
                  )}
                </div>
                <div className="mt-2"><EvalButton id={t.id} busy={busy[t.id]} onRun={() => runAi(t.id, 'prompt', { task: t.task, hint: t.hint, prompt: answers[t.id] || '' })} /></div>
                <AiFeedback r={aiResults[t.id]} />
              </div>
            ))}
          </div>
        )

      case 'cognitive':
        if (sub === 0) {
          return (
            <div className="panel p-5">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="text-sm font-bold text-slate-800">🧩 Motion & Grid Challenge — Round {gridRound + 1} / {gridCfg.rounds}</div>
                <div className="text-xs text-slate-400">{gridShow ? 'Memorise the pattern…' : 'Now reproduce it'}</div>
              </div>
              <p className="mt-1 text-xs text-slate-400">{gridCfg.note}</p>
              <div className="mt-4 grid gap-2 max-w-[320px] mx-auto" style={{ gridTemplateColumns: `repeat(${Math.sqrt(gridCfg.gridCells)}, 1fr)` }}>
                {Array.from({ length: gridCfg.gridCells }).map((_, i) => {
                  const active = gridShow ? gridPattern.includes(i) : gridSelected.includes(i)
                  return (
                    <button key={i} disabled={gridShow} onClick={() => setGridSelected(s => s.includes(i) ? s.filter(x => x !== i) : [...s, i])}
                      className={`aspect-square rounded-xl border text-xs font-bold transition ${active ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-300 scale-105' : 'bg-white/70 border-slate-200 text-slate-500 hover:bg-white'}`}>{i}</button>
                  )
                })}
              </div>
              <div className="mt-5 flex gap-2 justify-center">
                <button disabled={gridShow} onClick={() => {
                  const hits = gridPattern.filter(p => gridSelected.includes(p)).length
                  const acc = clamp01(hits / Math.max(1, gridPattern.length) - gridSelected.filter(s => !gridPattern.includes(s)).length * 0.2)
                  const secs = (Date.now() - gridHideAt.current) / 1000
                  const speed = clamp01(1 - Math.max(0, secs - 1.5) / 8)
                  const score = acc * 0.7 + speed * 0.3
                  const scores = [...gridScores, score]
                  setGridScores(scores)
                  if (gridRound < gridCfg.rounds - 1) setGridRound(r => r + 1)
                  else {
                    handleAnswer('GRID', scores.reduce((a, b) => a + b, 0) / scores.length)
                    const pct = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100)
                    showToast(autoAdvance
                      ? `Grid complete ✓ (${pct}%) — gliding to Logical Reasoning…`
                      : `Grid complete! Average accuracy/speed ${pct}%. Continue to Logical Reasoning →`)
                  }
                }} className="btn-primary !py-2.5 disabled:opacity-40">Submit pattern</button>
                <button onClick={() => { setGridRound(0); setGridScores([]) }} className="btn-soft !py-2.5">Reset</button>
              </div>
            </div>
          )
        }
        if (sub === 1) {
          return (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">Sequences, patterns, syllogisms, pseudocode and data interpretation.</p>
              {bank.cognitive.logical.map((q: any, i: number) => (
                <div key={q.id} className="panel p-3.5">
                  <div className="text-sm font-semibold text-slate-800 mb-2.5">{i + 1}. {q.q}</div>
                  <OptionList qid={q.id} options={q.options} seed={seed} value={answers[q.id]} onChange={(v) => handleAnswer(q.id, v)} />
                </div>
              ))}
            </div>
          )
        }
        return (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">No right or wrong — real workplace scenarios. Answer honestly; they build your behavioural profile.</p>
            {bank.cognitive.behavioral.map((b: any, i: number) => {
              const opts = shuffledChoiceOptions(b.options, seed, b.id)
              return (
                <div key={b.id} className="panel p-3.5">
                  <div className="text-sm font-semibold text-slate-800">{i + 1}. {b.q} <span className="text-xs text-slate-400 font-normal">({b.trait.replace(/_/g, ' ')})</span></div>
                  <div className="mt-2.5 space-y-2">
                    {opts.map((opt: any) => (
                      <label key={opt.text} className={`flex gap-2.5 p-3 rounded-xl text-sm border cursor-pointer transition ${answers[b.id] === opt.score ? 'bg-violet-600 text-white border-violet-500 shadow-md' : 'bg-white/70 border-slate-200 hover:bg-white'}`}>
                        <input type="radio" name={b.id} checked={answers[b.id] === opt.score} onChange={() => handleAnswer(b.id, opt.score)} className="accent-violet-600 mt-0.5" />
                        <span>{opt.text}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )
      default: return null
    }
  }

  const subs = STAGES[stage].sub
  const nextLoc = nextLocation(stage, sub)
  const prevLoc = prevLocation(stage, sub)
  const nextLabel = nextLoc ? locationLabel(nextLoc.stage, nextLoc.sub) : ''
  const prevLabel = prevLoc ? locationLabel(prevLoc.stage, prevLoc.sub) : ''
  const nextIsNewStage = !!nextLoc && nextLoc.stage !== stage
  const transitionClass = direction === 'next' ? 'animate-sub-next' : direction === 'prev' ? 'animate-sub-prev' : 'animate-sub-fade'

  return (
    <div className="min-h-screen text-slate-800">
      {/* Leak-prevention watermark — only once the test is unlocked, so the
          locked environment screens stay legible. Fixed + pointer-events-none so
          it never blocks clicks, and it sits above content but below modals. */}
      {envState === 'cleared' && !terminated && !submitting && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-40 watermark-overlay" style={watermarkStyle} />
      )}
      {/* Header */}
      <div className="sticky top-0 z-30 border-b border-white/60 bg-white/70 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Logo height={32} />
            <span className="hidden sm:inline font-extrabold text-slate-900 text-sm">CalibiAI Assessment</span>
            <span className="hidden md:inline text-[11px] text-slate-400 font-mono">{String(sid).slice(0, 13)}…</span>
          </div>
          <div className="flex items-center gap-2.5 sm:gap-3">
            <HelpButton assessment disabled={terminated || submitting || showViolation || !!reviewMode} />
            <span className="hidden sm:flex items-center gap-1.5 text-xs text-slate-500">
              Warnings
              <span className={`px-2 py-0.5 rounded-full font-bold ${strikes >= 3 ? 'bg-rose-500 text-white' : strikes >= 1 ? 'bg-amber-400 text-slate-900' : 'bg-slate-100 text-slate-500'}`}>{strikes}/3</span>
            </span>
            {envState === 'cleared' && !terminated && !submitting && !isFullscreen && (
              <button
                onClick={() => { enterFullscreen() }}
                title="Re-enter fullscreen"
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700 transition hover:bg-amber-100 active:scale-95"
              >
                <Maximize2 className="h-3.5 w-3.5" aria-hidden />
                Fullscreen
              </button>
            )}
            <div className={`px-4 py-1.5 rounded-full font-mono font-black text-sm border ${critical ? 'bg-rose-500 text-white border-rose-400 timer-pulse' : 'bg-white text-slate-800 border-slate-200'}`}>⏱ {fmt(remaining)}</div>
            <button onClick={requestSubmit} className="btn-primary !px-4 !py-2 !text-xs">Submit</button>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-2.5">
          <div className="flex gap-1.5 overflow-x-auto py-1">
            {STAGES.map((s, i) => (
              <button key={s.id} onClick={() => navigateTo(i, 0, i > stage ? 'next' : i < stage ? 'prev' : null)}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-300 ${i === stage ? 'calibiai-gradient text-white border-transparent shadow-md shadow-indigo-200' : 'bg-white/70 text-slate-600 border-slate-200 hover:bg-white hover:shadow-sm'}`}>
                {i + 1}. {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 grid lg:grid-cols-12 gap-6">
        {/* Sidebar */}
        <div className="lg:col-span-3">
          <div className="glass-card !p-4 sticky top-[120px] space-y-3 animate-fade-up">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-black text-slate-800">Live Preview</span>
                <span className="flex items-center gap-1 text-[10px] text-rose-500 font-bold"><span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" /> LIVE</span>
              </div>
              <div className="mt-2 relative rounded-xl overflow-hidden border border-slate-700 bg-slate-900 aspect-video">
                {videoOn ? <video ref={videoRef} muted playsInline autoPlay className="w-full h-full object-cover" />
                  : <div className="absolute inset-0 flex items-center justify-center text-center text-[10px] text-slate-400 p-2">Camera preview off<br />focus monitoring still active</div>}
                <div className="absolute bottom-1 left-1 flex items-center gap-1 bg-black/50 rounded-full px-2 py-0.5 text-[9px] text-white">🎤 mic on</div>
              </div>
              <div className="mt-1.5 text-[10px] text-slate-400 leading-snug">Live recording is on — please be present in camera, otherwise you will get a warning. <b className="text-slate-600">3 warnings will close the assessment.</b></div>
            </div>

            <div className="text-sm font-black text-slate-800 pt-1 border-t border-slate-200/70">Sections</div>
            {STAGES.map((s, i) => {
              // How many subsections of this stage are fully done (for the
              // English + Cognitive stages that have them).
              const doneSubs = s.sub.length
                ? s.sub.filter((_, si) => getSubProgress(s.id, si, answers, gridInfo).complete).length
                : 0
              return (
                <button key={s.id} onClick={() => navigateTo(i, 0, i > stage ? 'next' : i < stage ? 'prev' : null)}
                  className={`w-full text-left px-3 py-2 rounded-xl text-xs border transition-all duration-300 ${i === stage ? 'bg-indigo-600 border-indigo-500 text-white shadow-md shadow-indigo-200' : 'bg-white/70 border-slate-200 text-slate-600 hover:bg-white hover:shadow-sm'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold">{i + 1}. {s.label}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {s.sub.length > 0 && (
                        <span className={`font-mono font-bold ${i === stage ? 'text-indigo-100' : doneSubs === s.sub.length ? 'text-emerald-600' : 'text-slate-400'}`}>
                          {doneSubs === s.sub.length ? '✓' : `${doneSubs}/${s.sub.length}`}
                        </span>
                      )}
                      {(s.id === 'debugging' || s.id === 'feature') && (
                        <span className={`text-[9px] font-mono px-1.5 py-0.2 rounded font-bold ${i === stage ? 'bg-white/20 text-white border border-white/30' : 'bg-indigo-50 text-indigo-600 border border-indigo-100'}`}>AI</span>
                      )}
                    </span>
                  </div>
                  <div className={`text-[10px] ${i === stage ? 'text-indigo-100' : 'text-slate-400'}`}>Suggested {s.min} min</div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Main */}
        <div className="lg:col-span-9">
          <div ref={mainCardRef} className="glass-card animate-fade-up scroll-mt-28">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-lg font-black text-slate-900">{STAGES[stage].label} <span className="text-slate-400 font-normal text-sm">· suggested {STAGES[stage].min} min</span></h2>
              <div className="flex items-center gap-2">
                {subs.length > 0 && (
                  <button
                    onClick={() => setAutoAdvance(v => !v)}
                    title={autoAdvance ? 'Turn off automatic subsection advance' : 'Turn on automatic subsection advance'}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border transition-all duration-300 ${autoAdvance ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-400 border-slate-200'}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${autoAdvance ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    Auto-advance {autoAdvance ? 'on' : 'off'}
                  </button>
                )}
                <span className="text-xs px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100 font-bold">Section {stage + 1} / {STAGES.length}</span>
              </div>
            </div>

            {subs.length > 0 && (
              <div className="mt-3">
                <div className="flex gap-2 flex-wrap">
                  {subs.map((label, i) => {
                    const p = getSubProgress(STAGES[stage].id, i, answers, gridInfo)
                    const done = p.complete
                    const active = i === sub
                    return (
                      <button key={label} onClick={() => navigateTo(stage, i, i > sub ? 'next' : i < sub ? 'prev' : null)}
                        className={`px-3.5 py-1.5 rounded-full text-xs font-bold border transition-all duration-300 flex items-center gap-1.5 ${active
                          ? 'bg-indigo-600 text-white border-indigo-500 shadow-md shadow-indigo-200 scale-[1.03]'
                          : done
                            ? 'bg-emerald-50/80 text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                            : 'bg-white/70 text-slate-600 border-slate-200 hover:bg-white hover:shadow-sm'}`}>
                        {done && !active && <span className="w-4 h-4 rounded-full bg-emerald-500 text-white text-[10px] flex items-center justify-center">✓</span>}
                        {active && done && <span className="w-4 h-4 rounded-full bg-white/25 text-white text-[10px] flex items-center justify-center">✓</span>}
                        {label}
                        {!done && p.total > 1 && <span className={`font-mono font-normal ${active ? 'text-indigo-200' : 'text-slate-400'}`}>{p.answered}/{p.total}</span>}
                      </button>
                    )
                  })}
                </div>
                {/* Live progress of the subsection being viewed */}
                <div className="mt-2.5 flex items-center gap-2.5">
                  <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full progress-smooth ${currentProgress.complete ? 'bg-emerald-500' : 'calibiai-gradient'}`}
                      style={{ width: `${currentProgress.total ? Math.round((currentProgress.answered / currentProgress.total) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="text-[11px] font-mono text-slate-500 shrink-0">
                    {currentProgress.complete
                      ? `✓ ${subs[sub]} complete`
                      : STAGES[stage].id === 'english' && sub === 3
                        ? `${wordCount(answers['WRITING'] || '')}/${WRITING_AUTONEXT_WORDS}+ words to continue`
                        : `${currentProgress.answered}/${currentProgress.total} answered`}
                  </span>
                </div>
              </div>
            )}

            {/* Direction-aware smooth transition between subsections/stages */}
            <div key={`${stage}-${sub}-${direction}`} className={`mt-5 ${transitionClass}`}>
              <div className="sub-card-rise">{renderStage()}</div>
            </div>

            <div className="mt-7 flex justify-between items-center gap-3 pt-2 flex-wrap">
              <button disabled={!prevLoc} onClick={goPrev} className="btn-soft disabled:opacity-30 !px-5">
                ← {prevLoc ? prevLabel : 'Previous'}
              </button>
              {subs.length > 0 && (
                <span className="text-[11px] font-mono text-slate-400 order-first w-full text-center sm:order-none sm:w-auto">
                  {subs[sub]} · {sub + 1}/{subs.length}
                </span>
              )}
              {nextLoc
                ? <button onClick={goNext} className="btn-primary !px-5">
                    {nextIsNewStage ? `Finish ${STAGES[stage].label.split(' ')[0]} → ${nextLabel}` : `Next: ${nextLabel}`} →
                  </button>
                : <button onClick={requestSubmit} className="btn-primary !px-7">Submit assessment →</button>}
            </div>
          </div>

          <div className="mt-4 rounded-2xl bg-amber-50 border border-amber-200 p-3.5 text-xs text-amber-800">
            Keep this tab focused — the 120-minute timer keeps running. Leaving the window shows a warning; after <b>3 warnings the assessment is closed automatically</b> with the answers you've completed.
          </div>
        </div>
      </div>

      {/* Auto-advance banner: "Listening complete ✓ — moving to Speaking…" */}
      {pendingAdvance && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md animate-pop">
          <div className="overflow-hidden rounded-2xl border border-emerald-200 bg-white/95 backdrop-blur shadow-2xl">
            <div className="px-5 pt-3.5 pb-3 flex items-center gap-3">
              <span className="w-9 h-9 rounded-full bg-emerald-500 text-white flex items-center justify-center text-lg shrink-0 shadow-md shadow-emerald-200">✓</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-slate-800 truncate">
                  {pendingAdvance.fromLabel} complete — moving to {pendingAdvance.toLabel}
                </div>
                <div className="text-xs text-slate-500">Continuing in {pendingAdvance.secs}s…</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={clearPendingAdvance} className="px-3 py-1.5 rounded-full text-xs font-bold border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition">Stay</button>
                <button onClick={goNowAdvance} className="px-3.5 py-1.5 rounded-full text-xs font-bold text-white calibiai-gradient shadow-md shadow-indigo-200 hover:brightness-105 active:scale-95 transition">Go now →</button>
              </div>
            </div>
            <div className="h-1 bg-emerald-100">
              <div key={`${stage}-${sub}`} className="h-full bg-emerald-500 autoadvance-bar" style={{ animationDuration: `${AUTONEXT_DELAY_MS}ms` }} />
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && !pendingAdvance && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-md px-5 py-3 rounded-2xl bg-white/90 backdrop-blur border border-indigo-200 shadow-2xl text-sm text-slate-800 animate-pop">{toast}</div>}

      {/* Pre-test environment gate — blocks until fullscreen + display check +
          other-tabs consent are done. This runs BEFORE the test is unlocked. */}
      {envState === 'gate' && (
        <div className="fixed inset-0 z-[70] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="glass-card max-w-md w-full !p-8 animate-pop">
            <div className="text-5xl text-center">🛡️</div>
            <h3 className="mt-4 text-xl font-black text-slate-900 text-center">Secure your test environment</h3>
            <p className="mt-2 text-sm text-slate-500 text-center">
              Before the questions are revealed we run an anti-cheat check and lock the browser.
            </p>

            <ul className="mt-5 space-y-2.5 text-sm text-slate-700">
              <li className="flex gap-2.5"><span className="shrink-0">🚫</span><span><b>Right-click</b> is disabled across the whole test screen.</span></li>
              <li className="flex gap-2.5"><span className="shrink-0">🖥️</span><span><b>External / mirrored displays</b> are not allowed. If one is detected the test won't start — or it is terminated if one is connected later.</span></li>
              <li className="flex gap-2.5"><span className="shrink-0">🔒</span><span>The browser is <b>locked in fullscreen</b> for the whole test. If you press Esc, fullscreen re-enters automatically — exiting it mid-test is recorded as a violation.</span></li>
              <li className="flex gap-2.5"><span className="shrink-0">🗂️</span><span>Please <b>close every other tab and window</b> first. (A webpage cannot close other tabs for you, but open-tab / away-switching is monitored.)</span></li>
            </ul>

            <label className="mt-5 flex gap-2 text-sm text-slate-700 cursor-pointer">
              <input type="checkbox" checked={envConsent} onChange={e => setEnvConsent(e.target.checked)} className="accent-indigo-600 mt-0.5 w-4 h-4" />
              I confirm I have closed all other tabs and windows, and I will not connect or mirror an external display during the test.
            </label>

            {fsBlocked && (
              <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-600 animate-fade-in">
                Fullscreen permission was not granted. The assessment cannot run in a normal window — tap the button again and choose <b>Allow</b> when your browser asks. If you already blocked it, enable fullscreen for this site in your browser settings (or click the fullscreen icon in the address bar) and try again.
              </div>
            )}

            <button onClick={runEnvCheck} disabled={!envConsent || envBusy}
              className={`mt-5 w-full rounded-full font-black text-sm transition ${envConsent && !envBusy ? 'btn-primary !py-3.5' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}>
              {envBusy ? 'Checking environment…' : fsBlocked ? 'Re-enter fullscreen & re-check →' : 'Enter fullscreen & begin security check →'}
            </button>
          </div>
        </div>
      )}

      {/* Environment gate blocked — an external / mirrored display was found. */}
      {envState === 'blocked' && (
        <div className="fixed inset-0 z-[70] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="glass-card max-w-md w-full !p-8 animate-pop">
            <div className="text-5xl text-center">⛔</div>
            <h3 className="mt-4 text-xl font-black text-rose-600 text-center">Test can't start</h3>
            <p className="mt-3 text-sm text-slate-600 text-center leading-relaxed">
              {envBlockReason || 'An external or mirrored display appears to be connected.'}
            </p>
            <p className="mt-3 text-xs text-slate-500 text-center">
              Please disconnect any external / second display and re-run the check.
            </p>
            <button onClick={runEnvCheck} disabled={envBusy} className="btn-primary mt-5 w-full !py-3">
              {envBusy ? 'Re-checking…' : "I've disconnected it — re-check"}
            </button>
          </div>
        </div>
      )}

      {/* Camera/mic gate */}
      {!mediaReady && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="glass-card max-w-md w-full text-center !p-8 animate-pop">
            <div className="text-5xl">🎥</div>
            <h3 className="mt-4 text-xl font-black text-slate-900">Enable camera & microphone</h3>
            <p className="mt-2 text-sm text-slate-500">A live proctoring preview appears on the left while you take the assessment. Live recording is on — please be present in camera, otherwise you will get a warning. <b className="text-slate-700">3 warnings will close the assessment.</b> Your screen focus is also monitored.</p>
            <button onClick={enableMedia} className="btn-primary mt-6 w-full">Turn on camera & mic →</button>
            {mediaError && <div className="mt-3 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-xl p-2">{mediaError}</div>}
            <button onClick={() => { setMediaReady(true); mediaReadyRef.current = true }} className="mt-3 text-xs text-indigo-600 font-semibold">Continue without camera (focus monitoring still active)</button>
          </div>
        </div>
      )}

      {/* Review page — manual submit (editable, can jump back) and auto-submit
          (read-only, no return to the exam). */}
      {showReview && !submitting && (
        <AssessmentReview
          sections={review.sections}
          stats={review.stats}
          timeLeft={fmt(remaining)}
          strikes={strikes}
          submitting={submitting}
          readOnly={reviewMode === 'auto'}
          autoReason={reviewMode === 'auto' ? autoSubmitReason : undefined}
          onJump={jumpToQuestion}
          onCancel={() => setShowReview(false)}
          onSubmit={() => doSubmit(reviewMode === 'auto')}
        />
      )}

      {/* Submitting overlay */}
      {submitting && (
        <div className="fixed inset-0 z-[65] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="glass-card flex items-center gap-3 px-6 py-5 animate-pop">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
            <span className="text-sm font-bold text-slate-700">Submitting your assessment…</span>
          </div>
        </div>
      )}

      {/* Fullscreen lock — if fullscreen is lost mid-test (e.g. Esc) and the
          automatic re-entry is blocked by the browser, the exam is paused behind
          this overlay until the candidate re-enters fullscreen. This guarantees
          the test can never be taken in normal windowed mode. */}
      {envState === 'cleared' && !terminated && !submitting && fsEngaged && !isFullscreen && (
        <div className="fixed inset-0 z-[45] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="max-w-sm w-full rounded-3xl border-2 border-indigo-300 bg-white p-7 text-center shadow-2xl animate-pop">
            <div className="text-5xl">🖥️</div>
            <h3 className="mt-3 text-xl font-black text-indigo-700">Fullscreen required</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              The assessment must run in fullscreen. It is paused until you re-enter fullscreen.
            </p>
            <button
              onClick={() => { enterFullscreen() }}
              className="btn-primary mt-5 w-full !py-3"
            >
              <span className="inline-flex items-center gap-2"><Maximize2 className="h-4 w-4" aria-hidden /> Re-enter fullscreen</span>
            </button>
          </div>
        </div>
      )}

      {/* Violation warning */}
      {showViolation && !terminated && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="relative w-full max-w-sm rounded-3xl border border-amber-200 bg-white p-7 text-center shadow-2xl shadow-amber-200/40 animate-slide-down">
            {/* Pulsing halo + shaking icon */}
            <div className="relative mx-auto h-20 w-20">
              <span className="absolute inset-0 rounded-full bg-amber-400/30 animate-ping" />
              <div className="relative grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-amber-100 to-amber-200 shadow-inner animate-shake">
                <TriangleAlert className="h-9 w-9 text-amber-600" aria-hidden />
              </div>
            </div>

            <h3 className="mt-4 text-xl font-black text-slate-900">Heads up — warning {strikes} of {MAX_FOCUS_STRIKES}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              {violationMsg || 'You left the assessment window. Switching away is recorded as a proctoring violation.'}
            </p>

            {/* Strike progress pips */}
            <div className="mt-4 flex items-center justify-center gap-1.5" aria-label={`${strikes} of ${MAX_FOCUS_STRIKES} warnings`}>
              {Array.from({ length: MAX_FOCUS_STRIKES }).map((_, i) => {
                const filled = i < strikes
                const latest = i === strikes - 1
                return (
                  <span
                    key={i}
                    className={`h-2.5 rounded-full transition-all duration-500 ${
                      filled
                        ? latest
                          ? 'w-7 bg-amber-500 animate-pulse'
                          : 'w-7 bg-amber-400/70'
                        : 'w-2.5 bg-slate-200'
                    }`}
                  />
                )
              })}
            </div>

            {strikes >= MAX_FOCUS_STRIKES - 1 && (
              <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-bold text-rose-600 animate-fade-in">
                ⚠ One more warning and your assessment will be submitted automatically.
              </div>
            )}

            <button onClick={() => { setShowViolation(false); awayRef.current = false }} className="btn-primary mt-6 w-full">
              I'm back — resume
            </button>
          </div>
        </div>
      )}

      {/* Terminated — hidden while the read-only auto-submit review is up */}
      {terminated && !(showReview && reviewMode === 'auto') && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="max-w-sm w-full rounded-3xl border-2 border-rose-300 bg-white p-7 text-center shadow-2xl animate-pop">
            <div className="text-5xl">⛔</div>
            <h3 className="mt-3 text-xl font-black text-rose-600">
              {cheatReason ? 'Assessment terminated — violation' : 'Assessment submitted'}
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              {cheatReason
                ? cheatReason
                : `You reached ${MAX_FOCUS_STRIKES} focus warnings.`} Your answers up to this point have been submitted for evaluation and review.
            </p>
            <div className="mt-4 inline-block text-xs px-3 py-1.5 rounded-full bg-slate-100 text-slate-500">Redirecting to your results…</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Page() {
  return <AssessmentInner />
}
