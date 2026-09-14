'use client'
/**
 * Admin dashboard — /admin
 * ------------------------
 * Admin logs in with the fixed credentials (username: `admin`, password:
 * `CalibiAdmin@777`) via /api/admin/login (HttpOnly signed cookie). Once in, they
 * see every student (profile + latest assessment result + latest resume + the
 * feedback they submitted) and can:
 *   • filter by college (dropdown) and search (name/email/PRN/mobile/college)
 *   • page through the results (50 per page) and sort by score or name
 *   • download the whole student dataset as CSV — every score, skill and
 *     personal field — or just the currently filtered view
 * Filtering, sorting and pagination all run SERVER-side
 * (GET /api/admin/students), so each table page costs one small SQL window
 * instead of the full multi-MB dataset; the CSV is rendered server-side too
 * (GET /api/admin/export) from the same filters.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Eye, EyeOff,
  GraduationCap, LogOut, RefreshCw, Search, ShieldCheck, Star, Trophy, UploadCloud, Users, X,
} from 'lucide-react'
import { Logo } from '@/components/Logo'
import type { AdminStudentRow } from '@/lib/csv'
import { downloadFilename } from '@/lib/csv'

type AuthState = 'checking' | 'guest' | 'authed'
type SortKey = 'score' | 'name'
type DataSource = 'supabase' | 'local' | ''

/** How often the dashboard checks for new data so it stays live.
 *  Each tick is a ~1KB fingerprint probe (`?check=1`); the full multi-MB
 *  dataset is re-downloaded only when the fingerprint changed, so leaving the
 *  tab open no longer burns Supabase egress. Override with
 *  NEXT_PUBLIC_ADMIN_REFRESH_MS (e.g. 5000 for 5s). */
const REFRESH_MS = Number(process.env.NEXT_PUBLIC_ADMIN_REFRESH_MS) || 30000

const n = (v: string) => (v === '' || v === null || v === undefined ? '—' : v)
const gradeChip = (g: string) => g === 'S' ? 'bg-emerald-100 text-emerald-700' : g === 'A' ? 'bg-indigo-100 text-indigo-700' : g === 'B' ? 'bg-violet-100 text-violet-700' : g === 'C' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'
const fmtDate = (iso: string) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

const fmtTime = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Small live badge that pulses while an auto-refresh is active. */
function LiveBadge({ lastUpdated }: { lastUpdated: string | null }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-bold text-emerald-700">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
      Live
      {lastUpdated && <span className="hidden font-semibold text-emerald-600/80 md:inline">· {fmtTime(lastUpdated)}</span>}
    </span>
  )
}

/** True on localhost / 127.0.0.1 — used only to show the demo credential hint. */
function isLocalHost() {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1'
}

function Spinner({ light = false }: { light?: boolean }) {
  return <span className={`h-4 w-4 animate-spin rounded-full border-2 ${light ? 'border-white/40 border-t-white' : 'border-slate-200 border-t-indigo-600'}`} />
}

// ===========================================================================
// Login screen
// ===========================================================================
function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (!username.trim() || !password) {
      setErr('Please enter both username and password.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Sign in failed.')
      onSuccess()
    } catch (e: any) {
      setErr(e?.message || 'Sign in failed.')
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="flex flex-col items-center gap-2">
          <Logo height={44} />
          <span className="font-display text-lg font-extrabold tracking-tight text-slate-900">
            CALIBIAI<span className="text-indigo-600"> SCORE</span>
          </span>
        </div>

        <div className="glass-card mt-6 !p-7 sm:!p-8">
          <div className="flex items-center justify-center gap-2 text-slate-900">
            <ShieldCheck className="h-5 w-5 text-indigo-600" />
            <h1 className="font-display text-xl font-extrabold tracking-tight">Admin dashboard</h1>
          </div>
          <p className="mt-1.5 text-center text-sm text-slate-500">
            Restricted access — administrators only
          </p>

          <form onSubmit={submit} className="mt-6 space-y-3.5">
            <div>
              <label htmlFor="adminUser" className="mb-1.5 block text-xs font-bold text-slate-700">Username</label>
              <input
                id="adminUser"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                autoComplete="username"
                autoCapitalize="none"
                className="field"
              />
            </div>
            <div>
              <label htmlFor="adminPass" className="mb-1.5 block text-xs font-bold text-slate-700">Password</label>
              <div className="relative">
                <input
                  id="adminPass"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="field pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-700"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {err && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-semibold text-rose-600">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{err}</span>
              </div>
            )}

            <button type="submit" disabled={busy} className="btn-primary w-full !py-3 disabled:opacity-60">
              {busy ? <span className="flex items-center justify-center gap-2"><Spinner light /> Signing in…</span> : 'Sign in to dashboard'}
            </button>
          </form>

          {isLocalHost() && (
            <p className="mt-4 rounded-xl bg-indigo-50 px-3.5 py-2.5 text-center text-[11px] leading-relaxed text-indigo-600">
              <b>Demo credentials</b> — username <code className="font-mono">admin</code> · password <code className="font-mono">CalibiAdmin@777</code>
            </p>
          )}
        </div>

        <Link href="/" className="mt-5 block text-center text-xs font-semibold text-slate-400 transition hover:text-slate-600">
          ← Back to home
        </Link>
      </div>
    </div>
  )
}

// ===========================================================================
// Stat card
// ===========================================================================
function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className="glass-card !p-4 hover-lift animate-fade-up">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
        <span className="text-indigo-600">{icon}</span>{label}
      </div>
      <div className="mt-1 text-2xl font-black text-slate-900">{value}</div>
      <div className="text-xs text-slate-400">{sub}</div>
    </div>
  )
}

// ===========================================================================
// Row details (expanded)
// ===========================================================================
function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl bg-slate-50/80 px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-xs font-semibold text-slate-700 break-words ${mono ? 'font-mono' : ''}`}>{n(value)}</div>
    </div>
  )
}

/** 1–5 star rating as shown to the candidate. */
function Stars({ rating, size = 13 }: { rating: string; size?: number }) {
  if (rating === '' || rating === null || rating === undefined) return <span className="text-slate-300">—</span>
  const value = Math.max(0, Math.min(5, Math.round(Number(rating))))
  return (
    <span className="inline-flex items-center gap-0.5" title={`${value}/5`} aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map(i => (
        <Star
          key={i}
          size={size}
          strokeWidth={1.75}
          className={i <= value ? 'text-amber-400' : 'text-slate-300'}
          fill={i <= value ? 'currentColor' : 'none'}
        />
      ))}
    </span>
  )
}

function ModuleBar({ label, value, max }: { label: string; value: string; max: number }) {
  const v = value === '' ? 0 : Number(value)
  const pct = Math.min(100, Math.round((v / max) * 100))
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="font-semibold text-slate-600">{label}</span>
        <span className="font-mono font-bold text-slate-700">{value === '' ? '—' : `${value}/${max}`}</span>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full calibiai-gradient rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function ExpandedRow({ row }: { row: AdminStudentRow }) {
  const traits: [string, string][] = [
    ['Teamwork', row.teamwork], ['Accountability', row.accountability], ['Adaptability', row.adaptability],
    ['Responsible AI', row.responsible_ai], ['Decision Making', row.decision_making], ['Learning Mindset', row.learning_mindset],
  ]
  return (
    <tr className="border-t border-slate-100 bg-white/70">
      <td colSpan={13} className="px-5 py-4">
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-2">
            <div className="text-xs font-black uppercase tracking-wide text-slate-400">Personal & college</div>
            <div className="grid grid-cols-2 gap-2">
              <DetailRow label="Email" value={row.email} />
              <DetailRow label="Date of birth" value={row.dob} />
              <DetailRow label="Gender" value={row.gender} />
              <DetailRow label="Degree" value={row.degree} />
              <DetailRow label="Graduation year" value={row.graduation_year} />
              <DetailRow label="CGPA" value={row.cgpa} />
              <div className="col-span-2"><DetailRow label="LinkedIn" value={row.linkedin_url} /></div>
              <div className="col-span-2"><DetailRow label="GitHub" value={row.github_url} /></div>
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-xs font-black uppercase tracking-wide text-slate-400">Scores /1000</div>
            <div className="space-y-1.5">
              <ModuleBar label="English" value={row.english} max={200} />
              <ModuleBar label="Problem Solving" value={row.problem_solving} max={200} />
              <ModuleBar label="AI Debugging" value={row.ai_debugging} max={150} />
              <ModuleBar label="AI Feature Dev" value={row.ai_feature} max={150} />
              <ModuleBar label="Prompt Engineering" value={row.prompt_engineering} max={100} />
              <ModuleBar label="Cognitive" value={row.cognitive} max={200} />
            </div>
            {row.resume_score !== '' && (
              <div className="pt-1"><ModuleBar label="Resume score" value={row.resume_score} max={100} /></div>
            )}
          </div>
          <div className="space-y-2">
            <div className="text-xs font-black uppercase tracking-wide text-slate-400">Behavioural traits</div>
            <div className="grid grid-cols-2 gap-2">
              {traits.map(([label, v]) => (
                <div key={label} className="rounded-xl border border-slate-100 px-3 py-2">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
                  <div className="mt-0.5 text-sm font-black text-slate-800">{v === '' ? '—' : v}<span className="text-[10px] text-slate-400">/100</span></div>
                </div>
              ))}
            </div>
            {row.all_skills && (
              <div>
                <div className="text-xs font-black uppercase tracking-wide text-slate-400">Skills</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {row.all_skills.split(',').map(s => s.trim()).filter(Boolean).map(s => (
                    <span key={s} className="chip !py-1">{s}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Feedback this candidate gave about the assessment */}
        <div className="mt-5 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-xs font-black uppercase tracking-wide text-slate-400">Candidate feedback</div>
            {Number(row.feedback_count) > 1 && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                {row.feedback_count} submissions
              </span>
            )}
          </div>
          {row.feedback_history?.length ? (
            <div className="space-y-2">
              {row.feedback_history.map((feedback, index) => (
                <div
                  key={feedback.id || `${feedback.created_at}-${index}`}
                  className="rounded-2xl border border-amber-100 bg-amber-50/60 p-4"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Stars rating={feedback.rating} size={15} />
                    <span className="text-xs font-bold text-amber-700">
                      {feedback.rating ? `${feedback.rating}/5` : 'rated'}
                    </span>
                    {index === 0 && (
                      <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-amber-700">Latest</span>
                    )}
                    <span className="text-xs text-slate-500">{fmtDate(feedback.created_at)}</span>
                    {feedback.session_id && (
                      <span className="font-mono text-[10px] text-slate-400">{feedback.session_id}</span>
                    )}
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{feedback.message}</p>
                </div>
              ))}
            </div>
          ) : row.feedback_message || row.feedback_rating ? (
            <div className="rounded-2xl border border-amber-100 bg-amber-50/60 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Stars rating={row.feedback_rating} size={15} />
                <span className="text-xs font-bold text-amber-700">
                  {row.feedback_rating ? `${row.feedback_rating}/5` : 'rated'}
                </span>
                <span className="text-xs text-slate-500">{fmtDate(row.feedback_at)}</span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{row.feedback_message}</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3 text-xs font-semibold text-slate-400">
              No feedback submitted yet.
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

// ===========================================================================
// Main dashboard (authed)
// ===========================================================================
/* ---------------------------------------------------------------------------
 * Help requests — messages sent through the in-app help form. They used to go
 * to an external form service (and were lost once its monthly limit was hit);
 * they now live in `public.help_requests`, so the team can read them here.
 * ------------------------------------------------------------------------- */
interface HelpRequestRow {
  id?: string
  email?: string
  phone?: string
  message?: string
  page?: string
  created_at?: string
  synced?: boolean
  sync_error?: string
}

function HelpRequests() {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<HelpRequestRow[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/help')
      if (!res.ok) return
      const data = await res.json()
      setRows(data.requests || [])
    } catch (e: any) {
      setError(e?.message || 'Could not load help requests.')
    }
  }, [])

  // Only fetched when the panel is opened, so the dashboard stays fast.
  useEffect(() => { if (open && rows === null && !error) load() }, [open, rows, error, load])

  return (
    <section className="glass-card !p-5 mb-6">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-black text-slate-700">
          <AlertCircle size={16} className="text-indigo-600" /> Help requests
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-600">
            stored in Supabase · help_requests
          </span>
        </span>
        {open ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
      </button>

      {open && (
        <div className="mt-4">
          {error && <p className="text-xs text-rose-600">{error}</p>}
          {rows === null && !error && <p className="text-xs text-slate-500">Loading…</p>}
          {rows && rows.length === 0 && (
            <p className="text-xs text-slate-500">No help requests yet.</p>
          )}
          {rows && rows.length > 0 && (
            <ul className="space-y-3">
              {rows.map((row, index) => (
                <li key={row.id || `${row.created_at}-${index}`} className="rounded-2xl border border-slate-200 bg-white/70 p-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-slate-700">
                    <span>{row.email || '—'}</span>
                    {row.phone && <span className="font-normal text-slate-500">{row.phone}</span>}
                    <span className="text-slate-500 font-normal">{fmtDate(row.created_at || '')}</span>
                    {row.page && <span className="font-mono text-[10px] text-slate-400">{row.page}</span>}
                    {row.synced === false && (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700" title={row.sync_error || ''}>
                        queued — waiting for Supabase
                      </span>
                    )}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{row.message}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

interface DashboardMeta {
  colleges: string[]
  stats: { total: number; colleges: number; assessed: number; avg: number }
}

/** Windowed page numbers: always 1 + last, plus the neighbourhood of `page`. */
function pageNumbers(page: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const keep = new Set([1, 2, page - 1, page, page + 1, totalPages - 1, totalPages])
  const out: Array<number | '…'> = []
  for (let p = 1; p <= totalPages; p++) {
    if (!keep.has(p)) {
      if (out[out.length - 1] !== '…') out.push('…')
      continue
    }
    out.push(p)
  }
  return out
}

function Pagination({
  page, totalPages, pageSize, total, onPage, onSize,
}: {
  page: number
  totalPages: number
  pageSize: number
  total: number
  onPage: (p: number) => void
  onSize: (s: number) => void
}) {
  if (total === 0) return null
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  const btn = 'flex h-8 min-w-8 items-center justify-center rounded-full px-2.5 text-xs font-bold transition'
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-white/60 px-4 py-3 sm:px-5">
      <div className="text-xs font-semibold text-slate-500">
        Showing <span className="font-black text-slate-800">{start}–{end}</span> of {total}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className={`${btn} text-slate-500 hover:bg-slate-100 disabled:opacity-40`}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        {pageNumbers(page, totalPages).map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="px-1 text-xs font-bold text-slate-300">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p)}
              aria-current={p === page ? 'page' : undefined}
              className={`${btn} ${p === page ? 'bg-indigo-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              {p}
            </button>
          ),
        )}
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
          className={`${btn} text-slate-500 hover:bg-slate-100 disabled:opacity-40`}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
        Rows per page
        <select
          value={pageSize}
          onChange={(e) => onSize(Number(e.target.value))}
          className="field !w-auto !rounded-full !py-1.5 !text-xs"
        >
          {[25, 50, 100].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
    </div>
  )
}

function AdminDashboard({ onLogout }: { onLogout: () => void }) {
  // Current table page (server-filtered, server-sorted) + paging state.
  const [students, setStudents] = useState<AdminStudentRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [totalPages, setTotalPages] = useState(1)
  // College dropdown values + global stat cards (separate cheap endpoint).
  const [meta, setMeta] = useState<DashboardMeta | null>(null)
  const [loadError, setLoadError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [dataSource, setDataSource] = useState<DataSource>('')
  const [sources, setSources] = useState<{ supabase: number; local: number } | null>(null)
  const [canSync, setCanSync] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [warning, setWarning] = useState('')
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  const [college, setCollege] = useState('all')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [withScoreOnly, setWithScoreOnly] = useState(false)
  const [sortBy, setSortBy] = useState<SortKey>('score')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [exported, setExported] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Fingerprint of the dataset currently on screen. The auto-refresh polls the
  // cheap `?check=1` probe and only reloads the page when this differs.
  const fingerprintRef = useRef<string | null>(null)
  // Mirror of the server-driven query state so stable callbacks never close
  // over stale filters (avoids effect churn on every keystroke).
  const queryRef = useRef({ page, pageSize, college, q, withScoreOnly, sortBy, sortDir })
  queryRef.current = { page, pageSize, college, q, withScoreOnly, sortBy, sortDir }
  // Meta (stats/colleges) refreshes on demand — at most every 2 minutes via
  // the auto-poll, so unmigrated deployments don't rescan it every tick.
  const lastMetaRef = useRef(0)

  const load = useCallback(async () => {
    const cur = queryRef.current
    setRefreshing(true)
    setLoadError('')
    try {
      const params = new URLSearchParams({
        page: String(cur.page),
        pageSize: String(cur.pageSize),
        sort: cur.sortBy,
        dir: cur.sortDir,
      })
      if (cur.college && cur.college !== 'all') params.set('college', cur.college)
      if (cur.q) params.set('q', cur.q)
      if (cur.withScoreOnly) params.set('assessed', '1')
      const res = await fetch('/api/admin/students?' + params.toString())
      if (res.status === 401) {
        onLogout()
        return
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load students.')
      setStudents(data.students || [])
      setTotal(typeof data.total === 'number' ? data.total : 0)
      if (typeof data.page === 'number' && data.page !== cur.page) setPage(data.page)
      setTotalPages(typeof data.totalPages === 'number' && data.totalPages > 0 ? data.totalPages : 1)
      setDataSource((data.source as DataSource) || '')
      setSources(data.sources || null)
      setCanSync(!!data.canSync)
      setWarning(data.warning || '')
      if (typeof data.fingerprint === 'string') fingerprintRef.current = data.fingerprint
      setLastUpdated(data.updated_at || new Date().toISOString())
    } catch (e: any) {
      setLoadError(e?.message || 'Failed to load students.')
    } finally {
      setRefreshing(false)
    }
  }, [onLogout])

  const loadMeta = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/meta')
      if (res.status === 401) {
        onLogout()
        return
      }
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.colleges) && data.stats) {
        setMeta({ colleges: data.colleges, stats: data.stats })
        lastMetaRef.current = Date.now()
      }
    } catch {
      // Keep the previous meta; stats are non-critical.
    }
  }, [onLogout])

  // Cheap liveness probe: ask the server whether anything changed (~1KB) and
  // reload the current page only when it did. A transient probe failure keeps
  // the last good data on screen instead of flashing an error.
  const poll = useCallback(async () => {
    try {
      if (fingerprintRef.current === null) {
        await load()
        return
      }
      const res = await fetch('/api/admin/students?check=1')
      if (res.status === 401) {
        onLogout()
        return
      }
      if (!res.ok) return
      const data = await res.json()
      if (typeof data.fingerprint === 'string' && data.fingerprint !== fingerprintRef.current) {
        await load()
        if (Date.now() - lastMetaRef.current > 120000) loadMeta()
      }
    } catch {
      // Keep showing last good data; the next tick retries.
    }
  }, [load, loadMeta, onLogout])

  // Server-driven reload whenever the query changes (page 1 on mount).
  useEffect(() => {
    load()
  }, [load, page, pageSize, college, q, withScoreOnly, sortBy, sortDir])

  // Meta once on mount; refreshed on manual refresh + (guarded) auto-poll.
  useEffect(() => {
    loadMeta()
  }, [loadMeta])

  // Debounce the search box so one server query fires per pause in typing —
  // and jump back to page 1 together with it (batched: a single reload).
  // Skipped when the trimmed query is unchanged (e.g. typed then erased).
  useEffect(() => {
    const t = setTimeout(() => {
      const next = qInput.trim()
      if (next !== queryRef.current.q) {
        setPage(1)
        setQ(next)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [qInput])

  // Keep the dashboard live: probe on an interval while the tab is visible,
  // and immediately on tab focus. Pauses when the tab is hidden to save calls.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer) return
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') poll()
      }, REFRESH_MS)
    }
    const stop = () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        poll()
        start()
      } else {
        stop()
      }
    }
    const onFocus = () => poll()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [poll])

  // Where the matching rows came from — both stores are merged server-side.
  // (`dataSource` is the fallback for an older server that only sent `source`.)
  const liveCount = sources?.supabase ?? (dataSource === 'supabase' ? total : 0)
  const localCount = sources?.local ?? (dataSource === 'local' ? total : 0)
  const colleges = meta?.colleges || []
  const stats = meta?.stats || { total: 0, colleges: 0, assessed: 0, avg: 0 }
  const filtersActive = college !== 'all' || q !== '' || withScoreOnly

  const toggleSort = (key: SortKey) => {
    setPage(1)
    if (sortBy === key) setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))
    else {
      setSortBy(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  const gotoPage = (p: number) => {
    const next = Math.min(Math.max(1, p), totalPages)
    if (next === page) return
    setExpandedId(null)
    setPage(next)
  }

  const clearFilters = () => {
    setCollege('all')
    setQInput('')
    setQ('')
    setWithScoreOnly(false)
    setPage(1)
  }

  /**
   * Write the local candidates into Supabase (auth user + profile + sessions /
   * results / resumes / feedback). Needs SUPABASE_SERVICE_ROLE_KEY on the host;
   * the button only appears when the server says it can do it.
   */
  const handleSync = async () => {
    if (syncing) return
    setSyncing(true); setSyncMsg('')
    try {
      const res = await fetch('/api/admin/sync', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Sync failed.')
      const parts = data.summary
        ? `profiles ${data.summary.profiles}, sessions ${data.summary.assessment_sessions}, results ${data.summary.assessment_results}, resumes ${data.summary.resume_analyses}, feedback ${data.summary.feedback_submissions}`
        : ''
      setSyncMsg(
        data.ok
          ? `Synced into Supabase — ${parts}${data.reusedAccounts ? ` (${data.reusedAccounts} account(s) reused)` : ''}.`
          : `Sync finished with ${data.failures?.length || 0} failure(s): ${(data.failures || []).slice(0, 2).map((f: any) => `${f.table} ${f.id}: ${f.error}`).join(' · ')}`,
      )
      if (data.feedbackTableMissing) setSyncMsg(m => `${m} Feedback table missing — run supabase/migrations/0004_feedback_submissions.sql.`)
      load()
      loadMeta()
    } catch (e: any) {
      setSyncMsg(e?.message || 'Sync failed.')
    } finally {
      setSyncing(false)
    }
  }

  /**
   * CSV export, rendered server-side from the same filters as the table
   * (the browser only holds one page, so it can no longer build the CSV).
   * Always freshly computed — never served from the page cache.
   */
  const handleExport = async (scope: 'filtered' | 'all') => {
    if (exporting) return
    if (scope === 'filtered' && total === 0) return
    setExporting(true)
    try {
      const params = new URLSearchParams({ scope })
      if (scope === 'filtered') {
        if (college !== 'all') params.set('college', college)
        if (q) params.set('q', q)
        if (withScoreOnly) params.set('assessed', '1')
      }
      const res = await fetch('/api/admin/export?' + params.toString())
      if (res.status === 401) {
        onLogout()
        return
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed.')
      const blob = await res.blob()
      const match = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = match?.[1] || downloadFilename(scope)
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
      setExported(true)
      setTimeout(() => setExported(false), 2500)
    } catch (e: any) {
      setLoadError(e?.message || 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  const scoreSortIcon = (key: SortKey) => {
    if (sortBy !== key) return null
    return sortDir === 'desc' ? <ChevronDown className="inline h-3 w-3" /> : <ChevronUp className="inline h-3 w-3" />
  }

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-white/50 bg-white/55 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo className="drop-shadow-lg" />
            <span className="text-lg font-extrabold tracking-tight text-slate-900">
              CALIBIAI<span className="text-indigo-600"> SCORE</span>
            </span>
            <span className="ml-1 rounded-full bg-indigo-600/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-indigo-600">Admin</span>
          </Link>
          <div className="flex items-center gap-2 text-sm">
            {students && <LiveBadge lastUpdated={lastUpdated} />}
            <button
              onClick={() => { load(); loadMeta() }}
              disabled={refreshing}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/80 px-3.5 py-1.5 text-xs font-bold text-slate-600 transition hover:border-slate-300 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button
              onClick={() => { fetch('/api/admin/logout', { method: 'POST' }).finally(onLogout) }}
              className="flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3.5 py-1.5 text-xs font-bold text-rose-600 transition hover:bg-rose-100"
            >
              <LogOut className="h-3.5 w-3.5" /> Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3 animate-fade-up">
          <div>
            <h1 className="text-2xl font-black text-slate-900">Admin dashboard</h1>
            <p className="mt-1 text-sm text-slate-500">Every student's profile, CalibiAI score, module scores and skills — filter by college and download as CSV.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <button onClick={() => handleExport('all')} disabled={exporting} className="btn-soft !px-4 !py-2 font-bold disabled:opacity-50">
              <Download className="mr-1.5 inline h-3.5 w-3.5" /> {exporting ? 'Preparing…' : 'Download all students CSV'}
            </button>
            <button onClick={() => handleExport('filtered')} disabled={!total || exporting} className="btn-primary !px-4 !py-2 disabled:opacity-50">
              <Download className="mr-1.5 inline h-3.5 w-3.5" /> {exporting ? 'Preparing…' : `Download CSV (${total})`}
            </button>
          </div>
        </div>

        {exported && (
          <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-sm font-semibold text-emerald-700 animate-fade-up">
            <CheckCircle2 className="h-4 w-4" /> CSV downloaded — open it in Excel / Google Sheets. It includes name, PRN, mobile number, college, skills, resume score and every CalibiAI module score.
          </div>
        )}

        {/* Data source / degraded-read banner */}
        {students && warning && (
          <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-xs font-semibold text-rose-600 animate-fade-up">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{warning}</span>
          </div>
        )}
        {students && localCount > 0 && (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-xs font-semibold text-amber-700 animate-fade-up">
            <span className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {liveCount > 0
                  ? `Showing ${liveCount} live student${liveCount === 1 ? '' : 's'} from Supabase plus ${localCount} candidate${localCount === 1 ? '' : 's'} that exist only in the local demo store and were never written to Postgres.`
                  : `Showing ${localCount} local demo candidate${localCount === 1 ? '' : 's'} — no live rows came back from Supabase (see the notice above). Connect Supabase (set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY on the host) to pull every live student record.`}
              </span>
            </span>
            {canSync ? (
              <button
                onClick={handleSync}
                disabled={syncing}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-300 bg-white px-3 py-1.5 text-[11px] font-bold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50"
              >
                {syncing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                {syncing ? 'Syncing…' : 'Write candidates into Supabase'}
              </button>
            ) : (
              <span className="shrink-0 rounded-full bg-white px-3 py-1.5 text-[11px] font-bold text-amber-700">
                Set SUPABASE_SERVICE_ROLE_KEY to write them into Supabase
              </span>
            )}
          </div>
        )}
        {syncMsg && (
          <div className="rounded-2xl border border-indigo-200 bg-indigo-50/80 px-4 py-3 text-xs font-semibold text-indigo-700 animate-fade-up">
            {syncMsg}
          </div>
        )}

        {/* Stats (global — unaffected by the table filters below) */}
        {meta && (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              icon={<Users className="h-4 w-4" />}
              label="Total students"
              value={String(stats.total)}
              sub="Across all colleges"
            />
            <StatCard icon={<GraduationCap className="h-4 w-4" />} label="Colleges" value={String(stats.colleges)} sub="Distinct institutions" />
            <StatCard icon={<ShieldCheck className="h-4 w-4" />} label="Assessed" value={String(stats.assessed)} sub="Took the assessment" />
            <StatCard icon={<Trophy className="h-4 w-4" />} label="Average score" value={stats.assessed ? String(stats.avg) : '—'} sub="Top 10%: 900+ · Ready: 750+" />
          </div>
        )}

        {/* Filters */}
        <div className="glass-card !p-4 animate-fade-up">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search name, email, PRN, mobile, college…"
                className="field !rounded-full !py-2.5 pl-10 pr-9 w-full sm:w-80"
              />
              {qInput && (
                <button onClick={() => { setQInput(''); setQ(''); setPage(1) }} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold text-slate-500" htmlFor="collegeFilter">College</label>
              <select
                id="collegeFilter"
                value={college}
                onChange={(e) => { setCollege(e.target.value); setPage(1) }}
                className="field !rounded-full !py-2.5 pr-8"
              >
                <option value="all">All colleges</option>
                {colleges.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600">
              <input
                type="checkbox"
                checked={withScoreOnly}
                onChange={(e) => { setWithScoreOnly(e.target.checked); setPage(1) }}
                className="h-4 w-4 rounded accent-indigo-600"
              />
              Assessed only
            </label>
            <div className="ml-auto text-xs font-semibold text-slate-500">
              {total === 0
                ? 'No students found'
                : <>Showing <span className="font-black text-slate-800">{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}</span> of {total} students</>}
            </div>
          </div>
          {loadError && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-semibold text-rose-600">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {loadError}
              <button onClick={load} className="ml-auto font-black underline">Retry</button>
            </div>
          )}
        </div>

        {/* Table */}
        {!students ? (
          <div className="glass-card !p-10 text-center animate-fade-up">
            <RefreshCw className="mx-auto h-6 w-6 animate-spin text-indigo-500" />
            <p className="mt-3 text-sm font-bold text-slate-600">Loading students…</p>
          </div>
        ) : total === 0 ? (
          filtersActive ? (
            <div className="glass-card !p-10 text-center animate-fade-up">
              <Search className="mx-auto h-6 w-6 text-slate-300" />
              <p className="mt-3 text-sm font-bold text-slate-600">No students match the current filters</p>
              <button onClick={clearFilters} className="btn-soft mt-4 !py-2 text-xs font-bold">Clear filters</button>
            </div>
          ) : (
            <div className="glass-card !p-10 text-center animate-fade-up">
              <div className="text-4xl">🗂️</div>
              <p className="mt-3 text-sm font-bold text-slate-700">No students found</p>
              <p className="mt-1 text-xs text-slate-500">Student profiles will appear here once candidates sign up and complete onboarding.</p>
            </div>
          )
        ) : (
          <div className="glass-card !p-0 animate-fade-up overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wider text-slate-400">
                    <th className="px-4 py-3 text-left font-black">Student</th>
                    <th className="px-3 py-3 text-left font-black">PRN</th>
                    <th className="px-3 py-3 text-left font-black">Mobile</th>
                    <th className="px-3 py-3 text-left font-black">College</th>
                    <th className="px-3 py-3 text-left font-black">Degree</th>
                    <th className="px-3 py-3 text-left font-black">Skills</th>
                    <th className="px-3 py-3 text-center font-black">Resume</th>
                    <th className="px-3 py-3 text-center font-black">
                      <button onClick={() => toggleSort('score')} className="inline-flex items-center gap-0.5 hover:text-slate-700">
                        Score /1000 {scoreSortIcon('score')}
                      </button>
                    </th>
                    <th className="px-3 py-3 text-center font-black">Grade</th>
                    <th className="px-3 py-3 text-center font-black">%ile</th>
                    <th className="px-3 py-3 text-center font-black">Feedback</th>
                    <th className="px-3 py-3 text-center font-black">Assessed</th>
                    <th className="px-3 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {(students || []).map(s => {
                    const open = expandedId === s.student_id
                    const skillList = s.all_skills.split(',').map(x => x.trim()).filter(Boolean)
                    const shownSkills = skillList.slice(0, 3)
                    return (
                      <Fragment key={s.student_id}>
                        <tr
                          onClick={() => setExpandedId(open ? null : s.student_id)}
                          className="cursor-pointer border-t border-slate-100 transition hover:bg-indigo-50/40"
                        >
                          <td className="px-4 py-3">
                            <div className="font-bold text-slate-800">{n(s.name)}</div>
                            <div className="font-mono text-[10px] text-slate-400">{s.email}</div>
                          </td>
                          <td className="px-3 py-3 font-mono text-slate-600">{n(s.prn)}</td>
                          <td className="px-3 py-3 font-mono text-slate-600">{n(s.phone)}</td>
                          <td className="px-3 py-3 font-semibold text-slate-700">{n(s.college)}</td>
                          <td className="px-3 py-3 text-slate-500">
                            {n(s.degree)}{s.graduation_year ? ` · ${s.graduation_year}` : ''}
                          </td>
                          <td className="px-3 py-3">
                            {shownSkills.length ? (
                              <div className="flex flex-wrap gap-1">
                                {shownSkills.map(k => <span key={k} className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-600">{k}</span>)}
                                {skillList.length > 3 && <span className="px-1 text-[10px] font-bold text-slate-400">+{skillList.length - 3}</span>}
                              </div>
                            ) : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-3 py-3 text-center font-mono font-bold text-slate-700">{n(s.resume_score)}</td>
                          <td className="px-3 py-3 text-center">
                            {s.has_assessment === 'Yes' ? (
                              s.score
                                ? <span className="font-mono text-sm font-black text-slate-900">{s.score}</span>
                                : <span className="font-semibold text-amber-600">Taken · result pending</span>
                            ) : <span className="text-slate-300">Not taken</span>}
                          </td>
                          <td className="px-3 py-3 text-center">
                            {s.grade ? <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${gradeChip(s.grade)}`}>{s.grade}</span> : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-3 py-3 text-center font-mono text-slate-600">{s.percentile === '' ? '—' : s.percentile}</td>
                          <td className="px-3 py-3 text-center">
                            <Stars rating={s.feedback_rating} />
                          </td>
                          <td className="px-3 py-3 text-center text-slate-500">{fmtDate(s.assessed_at)}</td>
                          <td className="px-2 py-3 text-slate-400">
                            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </td>
                        </tr>
                        {open && <ExpandedRow row={s} />}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              totalPages={totalPages}
              pageSize={pageSize}
              total={total}
              onPage={gotoPage}
              onSize={(s) => { setPageSize(s); setPage(1) }}
            />
          </div>
        )}

        {students && total > 0 && (
          <p className="pb-4 text-center text-[11px] text-slate-400">
            Data includes personal information — handle responsibly. The CSV exports 52 columns: personal details, college, PRN, mobile, skills, resume, every CalibiAI module score and the candidate's own feedback.
          </p>
        )}

        <HelpRequests />
      </main>
    </div>
  )
}

// ===========================================================================
// Page
// ===========================================================================
export default function AdminPage() {
  const [auth, setAuth] = useState<AuthState>('checking')

  useEffect(() => {
    let cancelled = false
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => { if (!cancelled) setAuth(d.authed ? 'authed' : 'guest') })
      .catch(() => { if (!cancelled) setAuth('guest') })
    return () => { cancelled = true }
  }, [])

  const handleLogout = useCallback(() => setAuth('guest'), [])

  if (auth === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="glass-card animate-fade-up flex items-center gap-3 px-6 py-4">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
          <span className="text-sm font-bold text-slate-700">Checking admin session…</span>
        </div>
      </div>
    )
  }
  return auth === 'authed'
    ? <AdminDashboard onLogout={handleLogout} />
    : <AdminLogin onSuccess={() => setAuth('authed')} />
}
