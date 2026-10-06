'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Navbar } from '@/components/Navbar'
import { useStore } from '@/lib/store'
import { Stepper } from '@/components/Stepper'
import { authFetch } from '@/lib/apiFetch'
import { noteSyncWarning } from '@/lib/syncNotice'
import { SyncWarningBanner } from '@/components/SyncWarningBanner'

function ScoreRing({ score }: { score: number }) {
  const tone = score >= 75 ? '#10b981' : score >= 50 ? '#f59e0b' : '#f43f5e'
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 36 36" className="h-24 w-24 -rotate-90">
        <circle cx="18" cy="18" r="16" fill="none" stroke="#e2e8f0" strokeWidth="3" />
        <circle
          cx="18" cy="18" r="16" fill="none" stroke={tone} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={`${score} ${100 - score}`} pathLength={100}
          style={{ transition: 'stroke-dasharray .6s cubic-bezier(.22,.8,.32,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-black text-2xl text-slate-800 tabular-nums">{score}</span>
        <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">/100</span>
      </div>
    </div>
  )
}

const FLAG_ICON = { error: '🔴', warn: '🟡', ok: '🟢' } as const

function ResumeInner() {
  const { resume, setResume, user, profile } = useStore()
  const [fileName, setFileName] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<any>(resume)
  const [dragOver, setDragOver] = useState(false)
  // `?edit=1` switches this page into the standalone "update your resume" view
  // (used from the student dashboard / profile). Without it the page is part of
  // the one-time onboarding flow (stepper + continue → WhatsApp).
  const [editMode, setEditMode] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setEditMode(new URLSearchParams(window.location.search).get('edit') === '1')
  }, [])

  // Show the previously saved resume analysis (score, skills, flags) by default
  // when revisiting in edit mode — the user sees their current score before
  // replacing the document.
  useEffect(() => {
    if (resume && !done) setDone(resume)
  }, [resume, done])

  const analyze = async (f: File) => {
    setError('')
    setFileName(f.name)
    if (f.size > 5 * 1024 * 1024) { setError('Resume is larger than 5 MB.'); return }
    setAnalyzing(true)
    setDone(null)
    try {
      const fd = new FormData()
      fd.append('file', f)
      fd.append('user_id', user?.id || '')
      fd.append('email', user?.email || '')
      fd.append('full_name', profile?.full_name || user?.name || '')
      fd.append('degree', profile?.degree || '')
      fd.append('skills', profile?.skills || '')
      const res = await authFetch('/api/user/resume/analyze', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Analysis failed.')
      noteSyncWarning(data)
      setDone(data.analysis)
      setResume(data.analysis)
    } catch (e: any) {
      setError(e?.message || 'Analysis failed — please try again.')
    } finally {
      setAnalyzing(false)
    }
  }

  const onPick = (e: any) => {
    const f = e.target.files?.[0]
    if (f) analyze(f)
  }

  return (
    <div>
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">
      <SyncWarningBanner className="mb-5" />
        {!editMode && <Stepper step={3} />}
        <div className="mt-6 grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-6 items-start">
          {/* Upload */}
          <div className="glass-card animate-fade-up">
            <h1 className="text-2xl font-black text-slate-900">{editMode ? 'Update your resume' : 'Upload your resume'}</h1>
            <p className="mt-1 text-sm text-slate-500">
              Our AI reads the whole document like a recruiter — name check, professionalism,
              experience, skills and impact.
            </p>

            <label
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault(); setDragOver(false)
                const f = e.dataTransfer.files?.[0]
                if (f) analyze(f)
              }}
              className={`mt-6 block cursor-pointer rounded-3xl border-2 border-dashed p-10 text-center transition ${
                dragOver ? 'border-indigo-400 bg-indigo-100/60 scale-[1.01]' : 'border-indigo-200 bg-indigo-50/40 hover:bg-indigo-50'
              }`}
            >
              <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" className="hidden" onChange={onPick} />
              <div className="text-4xl">📄</div>
              <div className="mt-3 text-sm font-bold text-slate-700">{fileName || 'Drag & drop or browse'}</div>
              <div className="mt-1 text-xs text-slate-400">PDF, DOCX or TXT · up to 5 MB</div>
            </label>

            {analyzing && (
              <div className="animate-fade-in mt-4 flex items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-700">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                <span>Reading your resume end-to-end and analysing it against industry standards…</span>
              </div>
            )}
            {error && (
              <div className="animate-fade-in mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
                ⚠ {error}
              </div>
            )}

            <div className="mt-6 flex gap-3">
              {editMode ? (
                <>
                  <Link href="/dashboard/student" className="btn-soft">← Back to dashboard</Link>
                  {done && (
                    <Link href="/dashboard/student" className={`btn-primary ${!done ? 'pointer-events-none opacity-40' : ''}`}>Done</Link>
                  )}
                </>
              ) : (
                <>
                  <Link href="/tracking/whatsapp" replace className={`btn-primary ${!done ? 'pointer-events-none opacity-40' : ''}`}>Continue →</Link>
                  <Link href="/profile" className="btn-soft">Back</Link>
                </>
              )}
            </div>
          </div>

          {/* Analysis */}
          <div className="glass-card animate-fade-up" style={{ animationDelay: '.1s' }}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-black text-slate-900">Resume analysis</h3>
              {done && (
                <span className={`chip ${done.engine === 'calibiai' ? 'border-violet-200 bg-violet-50/80 text-violet-700' : 'border-slate-200 bg-white/70 text-slate-500'}`}>
                  {done.engine === 'calibiai' ? '✨ CalibiAI AI' : '⚙️ Rule-based engine'}
                </span>
              )}
            </div>

            {!done && !analyzing && (
              <p className="mt-6 text-sm text-slate-400">
                Upload a resume to see your score, recruiter-style flags and a full summary of
                experience, education and skills.
              </p>
            )}

            {done && (
              <div className="animate-fade-in mt-5 space-y-4">
                <div className="flex items-center gap-5 rounded-2xl border border-slate-200/70 bg-white/60 p-4">
                  <ScoreRing score={done.resume_score} />
                  <div className="min-w-0 text-sm">
                    <div className="font-bold text-slate-800">{done.parsed?.name}</div>
                    <div className="text-slate-500">
                      {done.experience?.years ?? 0} yr(s) experience · {done.parsed?.projects ?? 0} project(s) · {done.word_count} words
                    </div>
                    <div className="mt-1 text-xs text-slate-400">Professionalism {done.professionalism}/100</div>
                  </div>
                </div>

                {!done.name_match && (
                  <div className="animate-pop rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm font-semibold text-rose-700">
                    🚫 Wrong resume? The name on this document{done.detected_name ? ` (“${done.detected_name}”)` : ''} doesn’t
                    match your profile. Please upload your own resume.
                  </div>
                )}

                <div className="rounded-2xl panel p-4">
                  <div className="text-xs font-bold uppercase tracking-widest text-slate-400">AI summary</div>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{done.summary}</p>
                </div>

                <ul className="space-y-1.5">
                  {(done.flags || []).map((f: any, i: number) => (
                    <li
                      key={i}
                      className={`flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-xs font-semibold ${
                        f.level === 'error' ? 'bg-rose-50 text-rose-700 border border-rose-200'
                          : f.level === 'ok' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-amber-50 text-amber-700 border border-amber-200'
                      }`}
                    >
                      <span aria-hidden>{FLAG_ICON[f.level as keyof typeof FLAG_ICON] || '🟡'}</span>
                      <span>{f.text}</span>
                    </li>
                  ))}
                </ul>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl panel p-3.5">
                    <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Experience</div>
                    {done.experience?.entries?.length ? (
                      <ul className="mt-1.5 list-disc ml-4 space-y-0.5 text-xs text-slate-600">
                        {done.experience.entries.map((x: string, i: number) => <li key={i}>{x}</li>)}
                      </ul>
                    ) : <p className="mt-1.5 text-xs text-slate-400">No experience entries detected.</p>}
                  </div>
                  <div className="rounded-2xl panel p-3.5">
                    <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Education</div>
                    {done.education?.length ? (
                      <ul className="mt-1.5 list-disc ml-4 space-y-0.5 text-xs text-slate-600">
                        {done.education.map((x: string, i: number) => <li key={i}>{x}</li>)}
                      </ul>
                    ) : <p className="mt-1.5 text-xs text-slate-400">No education entries detected.</p>}
                  </div>
                </div>

                <div className="rounded-2xl panel p-3.5">
                  <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Detected skills</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {done.skills?.length ? done.skills.map((s: string) => (
                      <span key={s} className="rounded-full border border-indigo-200 bg-indigo-50/80 px-2.5 py-1 text-[11px] font-semibold text-indigo-700">{s}</span>
                    )) : <span className="text-xs text-slate-400">No recognizable skills found.</span>}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3.5">
                    <div className="text-xs font-bold text-emerald-700">Strengths</div>
                    <ul className="mt-1.5 list-disc ml-4 space-y-0.5 text-xs text-slate-600">
                      {(done.feedback?.strengths || []).map((s: string, i: number) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3.5">
                    <div className="text-xs font-bold text-amber-700">Gaps</div>
                    <ul className="mt-1.5 list-disc ml-4 space-y-0.5 text-xs text-slate-600">
                      {(done.feedback?.gaps || []).map((s: string, i: number) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                </div>

                <div className="rounded-2xl panel p-3.5 text-xs">
                  <div className="font-bold text-indigo-700">💡 Suggestions</div>
                  <ul className="mt-1.5 list-disc ml-4 space-y-0.5 text-slate-600">
                    {(done.feedback?.suggestions || []).map((s: string, i: number) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

export default function Page() {
  return <ResumeInner />
}
