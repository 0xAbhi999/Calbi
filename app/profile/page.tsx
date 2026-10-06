'use client'
export const dynamic = 'force-dynamic'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useStore } from '@/lib/store'
import { Navbar } from '@/components/Navbar'
import { isProfileComplete } from '@/lib/validate'
import { AiAvatar, AVATAR_STYLES, makeAvatarConfig, type AvatarConfig, type AvatarStyle } from '@/components/AiAvatar'
import { SkillGraph, type SkillDatum } from '@/components/SkillGraph'
import { ReportModal } from '@/components/ReportModal'
import { SkillChips } from '@/components/SkillChips'
import { flattenAssessmentResult } from '@/lib/resultShape'
import { authFetch } from '@/lib/apiFetch'
import { noteSyncWarning } from '@/lib/syncNotice'
import { SyncWarningBanner } from '@/components/SyncWarningBanner'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const SECTIONS: [string, string, number][] = [
  ['English', 'english', 200],
  ['Problem Solving', 'problem_solving', 200],
  ['AI Debugging', 'ai_debugging', 150],
  ['AI Feature Dev', 'ai_feature', 150],
  ['Prompt Eng', 'prompt_engineering', 100],
  ['Cognitive', 'cognitive_total', 200],
]

function sectionValue(scores: any, key: string): number {
  if (!scores) return 0
  if (key === 'english') return Number(scores.english?.total ?? 0)
  if (key === 'cognitive_total') return Number(scores.cognitive?.total ?? 0)
  return Number(scores[key] ?? 0)
}

function tierFor(total: number): { label: string; cls: string } {
  const t = Number(total) || 0
  if (t >= 800) return { label: 'Platinum', cls: 'bg-slate-100 text-slate-700 border-slate-300' }
  if (t >= 600) return { label: 'Gold', cls: 'bg-amber-100 text-amber-700 border-amber-300' }
  if (t >= 300) return { label: 'Silver', cls: 'bg-slate-200/80 text-slate-600 border-slate-300' }
  return { label: 'Bronze', cls: 'bg-orange-100 text-orange-700 border-orange-300' }
}

function ageFromDob(dob?: string): number | null {
  if (!dob) return null
  const d = new Date(dob)
  if (isNaN(d.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - d.getFullYear()
  const m = now.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--
  return age >= 0 && age < 120 ? age : null
}

function phoneDisplay(phone?: string): string {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10)
  if (digits.length !== 10) return phone || '—'
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`
}

function handleFor(email: string, id: string): string {
  const local = (email.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = (id || '').replace(/[^a-z0-9]/gi, '').slice(0, 8)
  return `@${local.slice(0, 12)}${suffix ? '-' + suffix : ''}`
}

function roleTag(profile: any): string {
  const from = profile?.degree || String(profile?.skills || '').split(',')[0] || ''
  const t = from.toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return t || 'future_graduate'
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

function SectionBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (Number(value) / max) * 100))
  return (
    <div className="panel p-3">
      <div className="flex justify-between text-xs mb-1.5">
        <span className="text-slate-600 font-medium">{label}</span>
        <span className="font-mono font-bold text-slate-700">{Number(value)}/{max}</span>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full calibiai-gradient rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function PanelHead({ tag, title, right }: { tag: string; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-[10px] font-black uppercase tracking-[0.18em] text-indigo-600">{tag}</div>
        <div className="mt-0.5 text-lg font-black text-slate-900">{title}</div>
      </div>
      {right}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function ProfileInner() {
  const router = useRouter()
  const { user, profile, setProfile, scores, resume, setUser, setScores, setResume, hydrated } = useStore()
  const [scoresPayload, setScoresPayload] = useState<any>(null)
  const [resumeLocal, setResumeLocal] = useState<any>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [saving, setSaving] = useState(false)
  const [avatar, setAvatar] = useState<AvatarConfig | null>(null)
  const [style, setStyle] = useState<AvatarStyle>('aura')
  const [showWhy, setShowWhy] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<any>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3200)
  }

  // Signed-out visitors go to login smoothly
  useEffect(() => {
    if (hydrated && !user) router.replace('/login')
  }, [hydrated, user, router])

  // Seed from localStorage instantly, then refresh from the DB so data saved
  // on another device (Supabase) shows up. Mirrors the dashboard behaviour.
  useEffect(() => {
    if (!hydrated) return
    const s = localStorage.getItem('calibiai_scores'); if (s) setScoresPayload(JSON.parse(s))
    const r = localStorage.getItem('calibiai_resume'); if (r) setResumeLocal(JSON.parse(r))
  }, [hydrated])

  useEffect(() => {
    if (!user?.id) return
    const load = async () => {
      const [p, s, r] = await Promise.all([
        authFetch('/api/user/profile?user_id=' + user.id).then(x => x.json()).catch(() => ({})),
        authFetch('/api/user/scores?student_id=' + user.id).then(x => x.json()).catch(() => ({})),
        authFetch('/api/user/resume?student_id=' + user.id).then(x => x.json()).catch(() => ({})),
      ])
      if (p.profile) setProfile(p.profile)
      // Always write through — including `null` when there is no result — so a
      // stale cached score from a deleted/previous account never lingers.
      const flat = flattenAssessmentResult(s.result)
      setScoresPayload(flat)
      setScores(flat)
      if (flat) localStorage.setItem('calibiai_scores', JSON.stringify(flat))
      else localStorage.removeItem('calibiai_scores')
      if (r.analysis) setResumeLocal(r.analysis)
      if (r.analysis) setResume(r.analysis)
      if (r.analysis) localStorage.setItem('calibiai_resume', JSON.stringify(r.analysis))
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  const activeScores = scoresPayload || scores
  const activeResume = resumeLocal || resume

  const onboarded = isProfileComplete(profile)
  const displayName = profile?.full_name || user?.name || user?.email?.split('@')[0] || 'Candidate'
  const total = Number(activeScores?.total) || 0
  const tier = tierFor(activeScores ? total : 0)

  // AI avatar state follows the saved profile config.
  useEffect(() => {
    if (profile?.ai_avatar) {
      setAvatar(profile.ai_avatar)
      if (AVATAR_STYLES.some(s => s.id === profile.ai_avatar.style)) setStyle(profile.ai_avatar.style)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.ai_avatar])

  /* ------------------------- name edit ------------------------- */
  const startEditName = () => { setNameDraft(displayName); setEditingName(true) }
  const cancelEditName = () => setEditingName(false)
  const saveName = async () => {
    const name = nameDraft.trim()
    if (name.length < 2) { showToast('Name must be at least 2 characters.'); return }
    if (name === displayName) { setEditingName(false); return }
    setSaving(true)
    try {
      const res = await authFetch('/api/user/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partial: true, user_id: user?.id, email: user?.email, full_name: name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not save your name.')
      noteSyncWarning(data)
      const merged = { ...(profile || {}), id: user?.id, email: user?.email, full_name: name, updated_at: new Date().toISOString() }
      setProfile(merged)
      if (user) setUser({ ...user, name })
      setEditingName(false)
      showToast(data.supabase === false ? 'Name updated on this device (Supabase sync pending)' : 'Name updated — saved to Supabase ✓')
    } catch (e: any) {
      showToast(e?.message || 'Could not save your name.')
    } finally { setSaving(false) }
  }

  /* ------------------------- avatar ------------------------- */
  const saveAvatar = async (cfg: AvatarConfig) => {
    setAvatar(cfg)
    try {
      const res = await authFetch('/api/user/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partial: true, user_id: user?.id, email: user?.email, ai_avatar: cfg }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not save your avatar.')
      noteSyncWarning(data)
      const merged = { ...(profile || {}), id: user?.id, email: user?.email, ai_avatar: cfg, updated_at: new Date().toISOString() }
      setProfile(merged)
      showToast('New AI avatar generated & saved ✓')
    } catch (e: any) {
      showToast(e?.message || 'Could not save your avatar.')
    }
  }

  /* ------------------------- derived data ------------------------- */
  const skillGraph: SkillDatum[] = useMemo(() => {
    const s = activeScores
    if (!s || !Number(s.total)) return []
    return SECTIONS.map(([label, key, max]) => ({
      label,
      value: (sectionValue(s, key) / max) * 100,
      sources: ['assessment'],
    }))
  }, [activeScores])

  const skillChips: { name: string; sources: string[] }[] = useMemo(() => {
    const map = new Map<string, { name: string; sources: Set<string> }>()
    const add = (raw: string, source: string) => {
      const name = raw.trim()
      if (!name) return
      const key = name.toLowerCase()
      const cur = map.get(key) || { name, sources: new Set<string>() }
      cur.sources.add(source)
      map.set(key, cur)
    }
    String(profile?.skills || '').split(',').forEach(s => add(s, 'profile'))
    ;(activeResume?.parsed?.skills || []).forEach((s: string) => add(s, 'resume'))
    return Array.from(map.values()).map(v => ({ name: v.name, sources: Array.from(v.sources) }))
  }, [profile?.skills, activeResume])

  const feedback: { text: string; from: string }[] = useMemo(() => {
    const out: { text: string; from: string }[] = []
    const ai: any = activeScores?.ai_results || {}
    const labelFor = (key: string) =>
      key.startsWith('SP') ? 'Speaking' : key === 'WRITING' ? 'Writing'
      : key.startsWith('DBG') || key.startsWith('DE') ? 'Debugging'
      : key === 'AF1' ? 'Feature Dev' : 'Prompt Eng'
    for (const [key, r] of Object.entries(ai) as [string, any][]) {
      if (out.length >= 8) break
      const label = labelFor(String(key))
      for (const t of (r?.improvements || []).slice(0, 2)) out.push({ text: String(t), from: label })
    }
    const rf = activeResume?.feedback
    if (rf) {
      ;(rf.gaps || []).slice(0, 3).forEach((g: string) => out.push({ text: g, from: 'Resume' }))
      ;(rf.suggestions || []).slice(0, 3).forEach((s: string) => out.push({ text: s, from: 'Resume' }))
    }
    return out.slice(0, 9)
  }, [activeScores, activeResume])

  if (!hydrated) {
    return (
      <div>
        <Navbar />
        <main className="mx-auto max-w-6xl px-4 sm:px-6 pt-8 space-y-6">
          <div className="animate-pulse space-y-6">
            <div className="h-44 rounded-[28px] bg-slate-800/60" />
            <div className="grid lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7 glass-card h-80 bg-white/40" />
              <div className="lg:col-span-5 glass-card h-80 bg-white/40" />
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

  return (
    <div className="min-h-screen pb-16">
      <Navbar />

      <main className="mx-auto max-w-6xl px-4 sm:px-6 pt-8 space-y-6">
      <SyncWarningBanner className="mb-5" />
        {/* ================= HERO ================= */}
        <div className="animate-fade-up relative overflow-hidden rounded-[28px] border border-slate-700/40 bg-gradient-to-br from-slate-900 via-[#191834] to-[#241b4d] p-6 sm:p-9 shadow-2xl shadow-indigo-900/20">
          <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-violet-600/25 blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-28 -left-16 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl" />

          <div className="relative flex flex-col sm:flex-row sm:items-center gap-6">
            {/* Avatar + regenerate button */}
            <div className="flex items-center gap-4 shrink-0">
              <div className="relative">
                <div className="rounded-full ring-4 ring-white/20">
                  <AiAvatar name={displayName} config={avatar} size={116} className="block" />
                </div>
                <button
                  onClick={() => saveAvatar(makeAvatarConfig(displayName, style))}
                  title="Generate a new AI avatar"
                  className="absolute -bottom-1 -right-1 flex h-9 w-9 items-center justify-center rounded-full bg-white text-indigo-600 shadow-lg ring-2 ring-slate-900/30 transition hover:scale-105 hover:text-violet-600"
                >
                  ✨
                </button>
              </div>
              <div className="sm:hidden">
                <div className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-300">🛡 Verified AI profile</div>
                <span className={`mt-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold ${tier.cls}`}>
                  👤 {tier.label}
                </span>
              </div>
            </div>

            {/* Identity */}
            <div className="min-w-0 flex-1">
              <div className="hidden sm:flex items-center gap-2.5">
                <span className="text-[11px] font-black uppercase tracking-[0.22em] text-indigo-300">🛡 Verified AI profile</span>
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${tier.cls}`}>👤 {tier.label}</span>
              </div>

              <div className="mt-2 flex items-center gap-3 flex-wrap">
                {editingName ? (
                  <span className="inline-flex items-center gap-2">
                    <input
                      value={nameDraft}
                      onChange={e => setNameDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') cancelEditName() }}
                      autoFocus
                      className="w-64 rounded-xl border border-white/25 bg-white/10 px-3 py-1.5 text-2xl font-black text-white outline-none focus:ring-2 focus:ring-indigo-400"
                    />
                    <button onClick={saveName} disabled={saving} className="rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
                    <button onClick={cancelEditName} className="rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold text-white">Cancel</button>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2.5">
                    <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-white truncate">{displayName}</h1>
                    {onboarded ? (
                      <button onClick={startEditName} title="Change name" className="rounded-full bg-white/10 p-1.5 text-white/70 transition hover:bg-white/20 hover:text-white">
                        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor"><path d="M13.6 3.2a2 2 0 0 1 2.83 0l.37.37a2 2 0 0 1 0 2.83L8 15.2 4.5 16l.8-3.5 8.3-8.3Z" /></svg>
                      </button>
                    ) : (
                      <Link href="/onboarding" className="rounded-full bg-amber-400/90 px-3 py-1 text-[11px] font-bold text-amber-950">Complete profile →</Link>
                    )}
                  </span>
                )}
              </div>

              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <span className="rounded-lg bg-white/10 border border-white/15 px-2.5 py-1 text-xs font-mono text-indigo-200">{handleFor(user.email, user.id)}</span>
                <span className="rounded-lg bg-white/10 border border-white/15 px-2.5 py-1 text-xs font-mono text-indigo-200">{roleTag(profile)}</span>
              </div>

              {/* Talent score */}
              <div className="mt-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">Talent score</span>
                    <button onClick={() => setShowWhy(w => !w)} className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-indigo-200 hover:bg-white/20" title="How the talent score is built">
                      ⓘ Why?
                    </button>
                  </div>
                  <span className="font-mono text-sm font-black text-white">{total}<span className="text-slate-400">/1000</span></span>
                </div>
                <div className="mt-2 h-2.5 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 transition-all duration-700" style={{ width: `${Math.min(100, total / 10)}%` }} />
                </div>
                {showWhy && (
                  <div className="animate-fade-in mt-2.5 rounded-xl bg-white/10 border border-white/15 p-3 text-[11px] leading-relaxed text-slate-300">
                    Your talent score is the sum of six assessment sections — English (200), Problem Solving (200), AI Debugging (150), AI Feature Development (150), Prompt Engineering (100) and Cognitive (200) — out of 1000. Tiers: Bronze &lt; 300 · Silver 300–599 · Gold 600–799 · Platinum 800+.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Avatar style picker */}
          <div className="relative mt-5 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">AI avatar style</span>
            {AVATAR_STYLES.map(s => (
              <button
                key={s.id}
                onClick={() => { setStyle(s.id); saveAvatar(makeAvatarConfig(displayName, s.id)) }}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition ${style === s.id ? 'border-white/60 bg-white/15 text-white' : 'border-white/15 bg-white/5 text-slate-300 hover:bg-white/10'}`}
              >
                <span className="h-3 w-3 rounded-full" style={{ background: `linear-gradient(135deg, ${s.swatch[0]}, ${s.swatch[1]})` }} />
                {s.label}
              </button>
            ))}
            <button onClick={() => saveAvatar(makeAvatarConfig(displayName, style))} className="ml-auto rounded-full bg-white text-slate-900 px-3.5 py-1.5 text-xs font-black shadow transition hover:scale-105">
              ✨ Generate new avatar
            </button>
          </div>
        </div>

        {/* ================= BODY GRID ================= */}
        <div className="grid gap-6 lg:grid-cols-12">
          {/* -------- Left column -------- */}
          <div className="lg:col-span-7 space-y-6">
            {/* Assessment score */}
            <div className="glass-card animate-fade-up hover-lift">
              <PanelHead
                tag="Assessment proof"
                title="Your talent score"
                right={activeScores ? (
                  <span className="rounded-full border border-indigo-100 bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-600">Grade {activeScores.grade} · {activeScores.percentile}th %ile</span>
                ) : (
                  <span className="rounded-full border border-slate-200 bg-white/70 px-2.5 py-1 text-xs font-bold text-slate-400">Not taken yet</span>
                )}
              />
              {activeScores ? (
                <>
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="text-4xl font-black text-gradient">{activeScores.total}</span>
                    <span className="text-slate-400 font-bold">/1000</span>
                  </div>
                  <div className="mt-4 grid sm:grid-cols-2 gap-2.5">
                    {SECTIONS.map(([label, key, max]) => (
                      <SectionBar key={key} label={label} value={sectionValue(activeScores, key)} max={max} />
                    ))}
                  </div>
                  <div className="mt-5 flex flex-wrap gap-3">
                    <button onClick={() => setShowReport(true)} className="btn-primary !py-2.5 text-xs">View report</button>
                    <button
                      onClick={async () => {
                        setDownloading(true)
                        try {
                          const { generateReportPdf } = await import('@/lib/reportPdf')
                          const doc = await generateReportPdf({ scores: activeScores, profile, user })
                          doc.save(`CalibiAI_Report_${activeScores?.session_id || 'scorecard'}.pdf`)
                        } catch (e) { console.warn('PDF generation failed:', e) }
                        finally { setDownloading(false) }
                      }}
                      disabled={downloading}
                      className="btn-soft !py-2.5 text-xs"
                    >
                      {downloading ? 'Preparing PDF…' : '⬇ Download PDF'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="mt-5 rounded-2xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 p-8 text-center">
                  <div className="text-4xl">🎯</div>
                  <p className="mt-2 text-sm text-slate-500">You haven't taken the assessment yet — it unlocks your score and skill graph.</p>
                  <Link href={onboarded ? '/instructions' : '/onboarding'} className="btn-primary mt-4 inline-flex">
                    {onboarded ? 'Start your assessment →' : 'Complete profile, then start →'}
                  </Link>
                </div>
              )}
            </div>

            {/* Resume */}
            <div className="glass-card animate-fade-up hover-lift" style={{ animationDelay: '.05s' }}>
              <PanelHead
                tag="Resume proof"
                title="Your resume"
                right={activeResume ? (
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-600">Score {activeResume.resume_score}/100</span>
                ) : (
                  <span className="rounded-full border border-slate-200 bg-white/70 px-2.5 py-1 text-xs font-bold text-slate-400">Not uploaded</span>
                )}
              />
              {activeResume ? (
                <div className="mt-4">
                  <div className="grid sm:grid-cols-3 gap-2.5">
                    <div className="panel p-3 text-center">
                      <div className="text-2xl font-black text-slate-800">{activeResume.parsed?.experience_years ?? 0}</div>
                      <div className="text-[11px] font-semibold text-slate-400">Years experience</div>
                    </div>
                    <div className="panel p-3 text-center">
                      <div className="text-2xl font-black text-slate-800">{activeResume.parsed?.projects ?? 0}</div>
                      <div className="text-[11px] font-semibold text-slate-400">Projects detected</div>
                    </div>
                    <div className="panel p-3 text-center">
                      <div className="text-2xl font-black text-slate-800">{(activeResume.parsed?.skills || []).length}</div>
                      <div className="text-[11px] font-semibold text-slate-400">Skills detected</div>
                    </div>
                  </div>
                  {(activeResume.feedback?.strengths?.length > 0 || activeResume.feedback?.gaps?.length > 0) && (
                    <div className="mt-4 grid sm:grid-cols-2 gap-3">
                      <div>
                        <div className="text-xs font-bold text-emerald-600">Strengths</div>
                        <ul className="mt-1.5 list-disc ml-4 text-xs text-slate-600 space-y-1">
                          {(activeResume.feedback.strengths || []).slice(0, 3).map((s: string) => <li key={s}>{s}</li>)}
                        </ul>
                      </div>
                      <div>
                        <div className="text-xs font-bold text-amber-600">Gaps</div>
                        <ul className="mt-1.5 list-disc ml-4 text-xs text-slate-600 space-y-1">
                          {(activeResume.feedback.gaps || []).slice(0, 3).map((g: string) => <li key={g}>{g}</li>)}
                        </ul>
                      </div>
                    </div>
                  )}
                  <Link href="/resume?edit=1" className="mt-4 inline-block text-xs font-semibold text-indigo-600 hover:text-indigo-700">Update resume →</Link>
                </div>
              ) : (
                <div className="mt-5 rounded-2xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 p-8 text-center">
                  <div className="text-4xl">📄</div>
                  <p className="mt-2 text-sm text-slate-500">Upload your resume — the AI extracts your skills, projects and experience.</p>
                  <Link href="/resume?edit=1" className="btn-primary mt-4 inline-flex">Upload resume →</Link>
                </div>
              )}
            </div>

            {/* AI feedback */}
            <div className="glass-card animate-fade-up hover-lift" style={{ animationDelay: '.1s' }}>
              <PanelHead tag="AI feedback" title="How you can improve" right={<span className="text-lg" aria-hidden>💡</span>} />
              {feedback.length > 0 ? (
                <ul className="mt-4 space-y-2.5">
                  {feedback.map((f, i) => (
                    <li key={i} className="flex items-start gap-2.5 rounded-xl border border-slate-200/70 bg-white/60 p-3 text-xs text-slate-700">
                      <span className="mt-0.5 shrink-0 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-600">{f.from}</span>
                      <span className="leading-relaxed">{f.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-5 rounded-2xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 p-8 text-center">
                  <div className="text-4xl">🤖</div>
                  <p className="mt-2 text-sm text-slate-500">After your assessment and resume analysis, the AI will list exactly how to improve — section by section.</p>
                </div>
              )}
            </div>
          </div>

          {/* -------- Right column -------- */}
          <div className="lg:col-span-5 space-y-6">
            {/* Skill graph */}
            <div className="glass-card animate-fade-up hover-lift" style={{ animationDelay: '.08s' }}>
              <PanelHead tag="Skill graph" title="Verified skills" right={skillGraph.length >= 3 ? <span className="text-lg" aria-hidden>🎯</span> : undefined} />
              <div className="mt-3">
                <SkillGraph skills={skillGraph.length >= 3 ? skillGraph : []} />
                {skillChips.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {skillChips.slice(0, 14).map(s => (
                      <span key={s.name} className="chip !py-1">
                        {s.name}
                        <span className="text-[9px] font-bold uppercase tracking-wide text-indigo-400">{s.sources.join(' + ')}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Profile details */}
            <div className="glass-card animate-fade-up hover-lift" style={{ animationDelay: '.12s' }}>
              <PanelHead
                tag="Profile"
                title="Your details"
                right={<Link href="/edit-profile" className="rounded-full bg-indigo-50 border border-indigo-100 px-3 py-1 text-xs font-bold text-indigo-600 hover:bg-indigo-100">✎ Edit profile</Link>}
              />
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                {[
                  ['PRN No.', profile?.prn || '—'],
                  ['Phone', profile?.phone ? phoneDisplay(profile.phone) : '—'],
                  ['Gender', profile?.gender || '—'],
                  ['Date of birth', profile?.dob ? `${profile.dob}${ageFromDob(profile.dob) !== null ? ` (${ageFromDob(profile.dob)})` : ''}` : '—'],
                  ['Degree', profile?.degree || '—'],
                  ['College', profile?.college || '—'],
                  ['Graduating', profile?.graduation_year || '—'],
                  ['CGPA', profile?.cgpa ? `${profile.cgpa}/10` : '—'],
                ].map(([k, v]) => (
                  <div key={k as string} className="min-w-0">
                    <dt className="text-[11px] font-semibold text-slate-400">{k}</dt>
                    <dd className="truncate font-semibold text-slate-700" title={String(v)}>{v}</dd>
                  </div>
                ))}
                <div className="col-span-2 min-w-0">
                  <dt className="text-[11px] font-semibold text-slate-400">Skills</dt>
                  <dd className="mt-1.5"><SkillChips skills={profile?.skills} /></dd>
                </div>
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                {profile?.linkedin_url && <a href={profile.linkedin_url} target="_blank" rel="noreferrer" className="chip !py-1.5 hover:border-indigo-300">🔗 LinkedIn</a>}
                {profile?.github_url && <a href={profile.github_url} target="_blank" rel="noreferrer" className="chip !py-1.5 hover:border-indigo-300">💻 GitHub</a>}
                {!profile?.linkedin_url && !profile?.github_url && (
                  <span className="text-xs text-slate-400">Add LinkedIn / GitHub in your profile to show them here.</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Report pop-up */}
      {showReport && activeScores && (
        <ReportModal scores={activeScores} onClose={() => setShowReport(false)} />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-md px-5 py-3 rounded-2xl bg-white/95 backdrop-blur border border-indigo-200 shadow-2xl text-sm font-semibold text-slate-800 animate-pop">
          {toast}
        </div>
      )}
    </div>
  )
}

export default function Page() {
  return <ProfileInner />
}
