'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { Navbar } from '@/components/Navbar'
import { Stepper } from '@/components/Stepper'
import { CollegeCombobox } from '@/components/CollegeCombobox'
import { SearchableSelect } from '@/components/SearchableSelect'
import { SkillPicker } from '@/components/SkillPicker'
import { useStore } from '@/lib/store'
import { normalizeOnboardingForm, type OnboardingForm as Form } from '@/lib/onboardingForm'
import {
  DEGREE_OPTIONS,
  GENDER_OPTIONS,
  GRAD_YEAR_MAX,
  GRAD_YEAR_MIN,
  MAX_AGE,
  MIN_AGE,
  PHONE_COUNTRY_CODE,
  PHONE_DIGITS,
  PRN_MAX_LENGTH,
  PRN_MIN_LENGTH,
  ageFrom,
  formatPhoneInternational,
  isValidCgpa,
  isValidDob,
  isValidGradYear,
  isValidPhone,
  isValidPrn,
  isValidUrl,
  normalizePhone,
  normalizePrn,
} from '@/lib/validate'
import { authFetch } from '@/lib/apiFetch'
import { noteSyncWarning } from '@/lib/syncNotice'
import { SyncWarningBanner } from '@/components/SyncWarningBanner'

const STEPS = [
  { id: 1, title: 'About you', blurb: 'The basics recruiters see first.', icon: '👤' },
  { id: 2, title: 'Academics', blurb: 'Your degree and results.', icon: '🎓' },
  { id: 3, title: 'Your presence', blurb: 'Links that prove the work.', icon: '🔗' },
]

/**
 * True when the user has actually added some presence content (skills or a
 * link). Step 3 is optional, but it must never be shown as "complete / auto
 * saved" while the fields are still empty — otherwise a candidate can't tell
 * they still need to add their presence.
 */
function hasPresence(f: Form): boolean {
  return Boolean(f.skills.trim() || f.linkedin_url.trim() || f.github_url.trim())
}

/** Validates a single step. Returns a map of field -> error message. */
function validateStep(step: number, f: Form): Record<string, string> {
  const e: Record<string, string> = {}
  if (step === 1) {
    if (f.full_name.trim().length < 2) e.full_name = 'Please enter your full name.'
    if (!f.phone) e.phone = 'Mobile number is required.'
    else if (!isValidPhone(f.phone)) e.phone = `Mobile number must be exactly ${PHONE_DIGITS} digits.`
    if (!f.dob) e.dob = 'Date of birth is required.'
    else if (!isValidDob(f.dob)) e.dob = `Enter a valid date of birth (age ${MIN_AGE}–${MAX_AGE}).`
    if (!f.gender) e.gender = 'Please select a gender.'
    else if (!GENDER_OPTIONS.includes(f.gender as any)) e.gender = 'Choose Male, Female or Other.'
  }
  if (step === 2) {
    // PRN is optional (blank is fine) but must look like one when given.
    if (!isValidPrn(f.prn)) {
      e.prn = `Use ${PRN_MIN_LENGTH}–${PRN_MAX_LENGTH} letters/numbers, or leave it blank.`
    }
    if (!f.degree.trim()) e.degree = 'Degree is required.'
    if (!f.college.trim()) e.college = 'College / university is required.'
    if (!f.graduation_year) e.graduation_year = 'Graduation year is required.'
    else if (!isValidGradYear(f.graduation_year)) e.graduation_year = `Enter a year between ${GRAD_YEAR_MIN} and ${GRAD_YEAR_MAX}.`
    if (!f.cgpa) e.cgpa = 'CGPA is required.'
    else if (!isValidCgpa(f.cgpa)) e.cgpa = 'CGPA must be between 0 and 10.'
  }
  if (step === 3) {
    if (!isValidUrl(f.linkedin_url)) e.linkedin_url = 'Enter a valid https:// URL or leave it blank.'
    if (!isValidUrl(f.github_url)) e.github_url = 'Enter a valid https:// URL or leave it blank.'
  }
  return e
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

function Field({
  label, hint, error, children, htmlFor, className = '',
}: {
  label: string; hint?: string; error?: string; children: React.ReactNode; htmlFor?: string; className?: string
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="text-xs font-semibold text-slate-600">{label}</label>
      <div className="mt-1.5">{children}</div>
      <div className="mt-1 min-h-[16px]">
        {error ? (
          <span className="animate-fade-in text-[11px] font-semibold text-rose-600">⚠ {error}</span>
        ) : hint ? (
          <span className="text-[11px] text-slate-400">{hint}</span>
        ) : null}
      </div>
    </div>
  )
}

/** +91 prefix locked to the field; the input accepts digits only, max 10. */
function PhoneInput({
  value, onChange, invalid, id,
}: {
  value: string; onChange: (v: string) => void; invalid: boolean; id: string
}) {
  const digits = normalizePhone(value)
  return (
    <div>
      <div
        className={`flex items-stretch overflow-hidden rounded-xl border bg-white/80 transition focus-within:bg-white focus-within:ring-4 ${
          invalid
            ? 'border-rose-300 focus-within:border-rose-400 focus-within:ring-rose-100'
            : 'border-slate-200 focus-within:border-indigo-400 focus-within:ring-indigo-100'
        }`}
      >
        <span className="flex items-center gap-1.5 border-r border-slate-200 bg-slate-50/80 px-3 text-sm font-bold text-slate-600">
          <span aria-hidden>🇮🇳</span>+{PHONE_COUNTRY_CODE}
        </span>
        {/* No native maxLength: it would truncate a pasted "+91 98765 43210"
            before onChange could strip the country code. The controlled value
            below is what caps the field at PHONE_DIGITS. */}
        <input
          id={id}
          inputMode="numeric"
          autoComplete="tel-national"
          placeholder="98765 43210"
          value={digits}
          aria-invalid={invalid}
          aria-describedby={`${id}-count`}
          onChange={(e) => onChange(normalizePhone(e.target.value).slice(0, PHONE_DIGITS))}
          className="w-full bg-transparent px-3.5 py-2.5 text-sm tracking-[0.06em] text-slate-800 outline-none placeholder:tracking-normal placeholder:text-slate-400"
        />
        <span
          id={`${id}-count`}
          className={`flex items-center px-3 text-[11px] font-bold tabular-nums ${
            digits.length === PHONE_DIGITS ? 'text-emerald-600' : 'text-slate-400'
          }`}
        >
          {digits.length}/{PHONE_DIGITS}
        </span>
      </div>
      {digits.length > 0 && (
        <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-indigo-50/80 px-2 py-1 text-[11px] font-semibold text-indigo-700">
          {formatPhoneInternational(digits)}
        </div>
      )}
    </div>
  )
}

/** Accessible custom dropdown (listbox) with a fixed option list — no free text. */
function Dropdown({
  value, onChange, invalid, id, options, placeholder, ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  invalid: boolean
  id: string
  options: readonly string[]
  placeholder: string
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  const selectedIndex = Math.max(0, options.indexOf(value))

  const openMenu = () => {
    setActive(selectedIndex)
    setOpen(true)
  }

  const choose = (v: string) => {
    onChange(v)
    setOpen(false)
  }

  return (
    <div ref={root} className="relative">
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${id}-list`}
        aria-invalid={invalid}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (!open) openMenu()
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
        className={`flex w-full items-center justify-between rounded-xl border bg-white/80 px-3.5 py-2.5 text-left text-sm transition focus:outline-none focus:ring-4 ${
          invalid
            ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
            : 'border-slate-200 focus:border-indigo-400 focus:ring-indigo-100'
        }`}
      >
        <span className={value ? 'font-semibold text-slate-800' : 'text-slate-400'}>
          {value || placeholder}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <path fill="currentColor" d="M5.5 7.5 10 12l4.5-4.5H5.5Z" />
        </svg>
      </button>

      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % options.length) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length) }
            else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(options[active]) }
            else if (e.key === 'Escape') { setOpen(false) }
          }}
          ref={(el) => { if (el && open) el.focus() }}
          className="animate-pop absolute z-30 mt-2 w-full overflow-hidden rounded-2xl border border-white/70 bg-white/95 p-1.5 shadow-2xl shadow-indigo-200/60 backdrop-blur-xl"
        >
          {options.map((opt, i) => {
            const selected = opt === value
            return (
              <li key={opt} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(opt)}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm transition ${
                    active === i ? 'calibiai-gradient text-white shadow-md shadow-indigo-300/50' : 'text-slate-700 hover:bg-indigo-50'
                  }`}
                >
                  <span className="font-semibold">{opt}</span>
                  {selected && <span aria-hidden className="text-xs font-bold">✓</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function ProgressRing({ pct }: { pct: number }) {
  const r = 26
  const c = 2 * Math.PI * r
  return (
    <div className="relative h-[68px] w-[68px] shrink-0">
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(148,163,184,.25)" strokeWidth="6" />
        <circle
          cx="32" cy="32" r={r} fill="none" stroke="url(#ring-grad)" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c - (c * Math.min(100, Math.max(0, pct))) / 100}
          style={{ transition: 'stroke-dashoffset .5s cubic-bezier(.22,.8,.32,1)' }}
        />
        <defs>
          <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#4f46e5" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-black text-slate-800 tabular-nums">
        {Math.round(pct)}%
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* The flow                                                            */
/* ------------------------------------------------------------------ */

export function OnboardingFlow({ variant = 'onboarding' }: { variant?: 'onboarding' | 'edit' }) {
  const router = useRouter()
  const { user, profile, setProfile } = useStore()
  const [form, setForm] = useState<Form>(() => normalizeOnboardingForm())
  const [step, setStep] = useState(1)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState('')

  // Hydrate from the saved profile (edit mode / returning user), else seed the
  // name from the signed-in user.
  useEffect(() => {
    if (profile) {
      setForm(normalizeOnboardingForm(profile))
    } else if (user) {
      setForm((f) => ({ ...f, full_name: user.name || f.full_name }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, profile?.updated_at])

  const set = (k: keyof Form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (touched) setErrors(validateStep(step, { ...form, [k]: v }))
  }

  const requiredOnStep = useMemo(() => {
    if (step === 1) return [form.full_name, form.phone, form.dob, form.gender]
    if (step === 2) return [form.degree, form.college, form.graduation_year, form.cgpa]
    return [null]
  }, [step, form])

  const pct = useMemo(() => {
    const weights = [4, 4, 2]
    let score = 0
    for (let i = 0; i < weights.length; i++) {
      const s = i + 1
      // Step 3 is optional but must be actively filled to count as complete —
      // a blank "Your presence" is not "100% done".
      const complete = s === 3 ? hasPresence(form) : Object.keys(validateStep(s, form)).length === 0
      if (complete) score += weights[i]
    }
    return (score / weights.reduce((a, b) => a + b, 0)) * 100
  }, [form])

  const stepComplete = requiredOnStep.every((v) => v !== null && v !== undefined && String(v).trim() !== '')

  const goNext = (event: React.MouseEvent<HTMLButtonElement>) => {
    // This button becomes a submit button on step 3; don't submit on the same click.
    event.preventDefault()
    setTouched(true)
    const e = validateStep(step, form)
    setErrors(e)
    if (Object.keys(e).length) return
    setTouched(false)
    setStep((s) => Math.min(STEPS.length, s + 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const goBack = () => {
    setErrors({})
    setTouched(false)
    setStep((s) => Math.max(1, s - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const initials = (form.full_name.trim() || user?.email || '?')
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')
    // Validate every step, not just the visible one, before persisting.
    for (const s of [1, 2, 3]) {
      const errs = validateStep(s, form)
      if (Object.keys(errs).length) {
        setTouched(true)
        setStep(s)
        setErrors(errs)
        setFormError('Some details still need attention — check the highlighted fields.')
        return
      }
    }
    setBusy(true)
    const payload = {
      ...form,
      full_name: form.full_name.trim(),
      prn: normalizePrn(form.prn),
      phone: normalizePhone(form.phone),
      graduation_year: Number(form.graduation_year),
      cgpa: Number(form.cgpa),
    }
    setProfile(payload)
    try {
      const res = await authFetch('/api/user/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, user_id: user?.id, email: user?.email }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Could not save your profile.')
      }
      // Supabase configured but the row did not land: keep going (the local
      // store has the details) but make the gap visible on the next page.
      noteSyncWarning(data)
    } catch (err: any) {
      // Offline / demo mode: the profile is still kept in the local store.
      console.warn('profile save fell back to local store:', err?.message)
    }
    setSaved(true)
    // First-time onboarding continues to resume upload; the edit form returns
    // to the (real) profile page. Onboarding is a one-time step, so `replace`
    // (not `push`) keeps it out of the browser history — otherwise the Back
    // button from the dashboard walks back through the whole onboarding flow.
    setTimeout(() => {
      if (variant === 'edit') router.replace('/profile')
      else router.replace('/resume')
    }, 900)
  }

  if (!user) {
    return (
      <div>
        <Navbar />
        <main className="mx-auto max-w-md px-6 py-20 text-center">
          <div className="glass-card animate-fade-up">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl calibiai-gradient text-2xl text-white shadow-lg shadow-indigo-300/50">🔐</div>
            <h1 className="mt-4 text-2xl font-black text-slate-900">Sign in to continue</h1>
            <p className="mt-2 text-sm text-slate-500">Your onboarding details are tied to your account.</p>
            <Link href="/login" className="btn-primary mt-6">Sign in →</Link>
          </div>
        </main>
      </div>
    )
  }

  const err = (k: string) => (touched ? errors[k] : undefined)

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Ambient brand glow */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="blob-a absolute -left-24 top-10 h-72 w-72 rounded-full bg-violet-300/30 blur-3xl" />
        <div className="blob-b absolute -right-16 top-40 h-80 w-80 rounded-full bg-indigo-300/30 blur-3xl" />
      </div>

      <Navbar />

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-6 sm:px-6">
        <Stepper step={2} />
        <SyncWarningBanner className="mb-5" />

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          {/* ---------------- Left rail: identity + progress ---------------- */}
          <aside className="animate-fade-up">
            <div className="glass-card !p-6">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl calibiai-gradient text-lg font-black text-white shadow-lg shadow-indigo-300/50">
                    {initials || 'C'}
                  </div>
                  <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-emerald-500 text-[10px] text-white">✓</span>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900">{form.full_name.trim() || 'New student'}</p>
                  <p className="truncate text-xs text-slate-500">{user.email}</p>
                </div>
              </div>

              <div className="mt-5 flex items-center gap-4 rounded-2xl border border-slate-200/70 bg-white/60 p-4">
                <ProgressRing pct={pct} />
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">
                    {variant === 'edit' ? 'Profile complete' : 'Onboarding'}
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-slate-700">
                    {pct >= 100 ? 'All set — you’re ready!' : `${Math.round(pct)}% filled in`}
                  </p>
                </div>
              </div>

              <ol className="mt-5 space-y-1.5">
                {STEPS.map((s) => {
                  const stepValid = s.id === 3 ? hasPresence(form) : Object.keys(validateStep(s.id, form)).length === 0
                  const done = s.id < step || stepValid
                  const current = s.id === step
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => { if (s.id < step) { setStep(s.id); setErrors({}); setTouched(false) } }}
                        className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition ${
                          current ? 'bg-white/85 shadow-md shadow-indigo-100 ring-1 ring-indigo-200' : 'hover:bg-white/60'
                        } ${s.id < step ? 'cursor-pointer' : 'cursor-default'}`}
                      >
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-xs font-black transition ${
                            current ? 'calibiai-gradient text-white shadow-md shadow-indigo-300/50'
                              : done ? 'bg-emerald-500 text-white'
                              : 'border border-slate-200 bg-white/70 text-slate-400'
                          }`}
                        >
                          {done && !current ? '✓' : s.id}
                        </span>
                        <span className="min-w-0">
                          <span className={`block text-sm font-bold ${current ? 'text-slate-900' : 'text-slate-600'}`}>{s.title}</span>
                          <span className="block truncate text-[11px] text-slate-400">{s.blurb}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ol>

              <p className="mt-5 flex items-start gap-2 rounded-2xl bg-slate-50/80 p-3 text-[11px] leading-relaxed text-slate-500">
                <span aria-hidden>🔒</span>
                <span>Used only to verify your scorecard and build your employability report.</span>
              </p>
            </div>
          </aside>

          {/* ---------------- Right: the wizard ---------------- */}
          <section className="animate-fade-up" style={{ animationDelay: '.08s' }}>
            <form onSubmit={submit} className="glass-card relative overflow-hidden">
              {saved && (
                <div className="animate-pop absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-white/85 backdrop-blur-sm">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-3xl text-white shadow-xl shadow-emerald-300/60">✓</div>
                  <p className="text-lg font-black text-slate-900">Profile saved</p>
                  <p className="text-sm text-slate-500">{variant === 'edit' ? 'Taking you to your profile…' : 'Taking you to resume upload…'}</p>
                </div>
              )}

              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">
                    {variant === 'edit' ? 'Edit profile' : `Step ${step} of ${STEPS.length}`}
                  </p>
                  <h1 className="mt-1.5 text-2xl font-black tracking-tight text-slate-900 sm:text-3xl">
                    {STEPS[step - 1].title}
                  </h1>
                  <p className="mt-1 text-sm text-slate-500">{STEPS[step - 1].blurb}</p>
                </div>
                <span aria-hidden className="hidden text-3xl sm:block">{STEPS[step - 1].icon}</span>
              </div>

              {/* segmented progress */}
              <div className="mt-5 flex gap-1.5" aria-hidden>
                {STEPS.map((s) => (
                  <span
                    key={s.id}
                    className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                      s.id <= step ? 'calibiai-gradient' : 'bg-slate-200/80'
                    }`}
                  />
                ))}
              </div>

              <div key={step} className="animate-fade-up mt-6">
                {step === 1 && (
                  <div className="grid gap-x-5 sm:grid-cols-2">
                    <Field label="Full name" htmlFor="full_name" error={err('full_name')} className="sm:col-span-2" hint="As it should appear on your scorecard">
                      <input
                        id="full_name"
                        value={form.full_name}
                        onChange={(e) => set('full_name', e.target.value)}
                        placeholder="Priya Sharma"
                        className={`field ${err('full_name') ? 'border-rose-300' : ''}`}
                      />
                    </Field>

                    <Field
                      label="Mobile number"
                      htmlFor="phone"
                      error={err('phone')}
                      hint={`Use your correct number — it will be verified against your resume (ATS). Exactly ${PHONE_DIGITS} digits.`}
                    >
                      <PhoneInput id="phone" value={form.phone} invalid={!!err('phone')} onChange={(v) => set('phone', v)} />
                    </Field>

                    <Field label="Gender" htmlFor="gender" error={err('gender')} hint="Male, Female or Other">
                      <Dropdown id="gender" options={GENDER_OPTIONS} placeholder="Select gender" ariaLabel="Gender" value={form.gender} invalid={!!err('gender')} onChange={(v) => set('gender', v)} />
                    </Field>

                    <Field
                      label="Date of birth"
                      htmlFor="dob"
                      error={err('dob')}
                      hint={form.dob && !err('dob') && ageFrom(form.dob) !== null ? `Age ${ageFrom(form.dob)} — picked from the calendar` : 'Pick your date from the calendar'}
                    >
                      <input
                        id="dob"
                        type="date"
                        value={form.dob}
                        onChange={(e) => set('dob', e.target.value)}
                        className={`field ${err('dob') ? 'border-rose-300' : ''}`}
                      />
                    </Field>
                  </div>
                )}

                {step === 2 && (
                  <div className="grid gap-x-5 sm:grid-cols-2">
                    <Field label="Degree" htmlFor="degree" error={err('degree')} hint="Search and pick your programme">
                      <SearchableSelect id="degree" options={DEGREE_OPTIONS} placeholder="Search degree…" ariaLabel="Degree" value={form.degree} invalid={!!err('degree')} onChange={(v) => set('degree', v)} />
                    </Field>
                    <Field
                      label="College / University"
                      htmlFor="college"
                      error={err('college')}
                      hint="Type to search — Pune & Amravati colleges are preloaded"
                    >
                      <CollegeCombobox
                        id="college"
                        value={form.college}
                        invalid={!!err('college')}
                        onChange={(v) => set('college', v)}
                      />
                    </Field>
                    <Field
                      label="PRN No."
                      htmlFor="prn"
                      error={err('prn')}
                      hint={`Optional — ${PRN_MIN_LENGTH}–${PRN_MAX_LENGTH} characters. Helps your college match this score with its own records.`}
                    >
                      <input
                        id="prn"
                        value={form.prn}
                        onChange={(e) => set('prn', normalizePrn(e.target.value).slice(0, PRN_MAX_LENGTH))}
                        placeholder="2021COEP001"
                        autoComplete="off"
                        maxLength={PRN_MAX_LENGTH}
                        className={`field ${err('prn') ? 'border-rose-300' : ''}`}
                      />
                    </Field>
                    <Field label="Graduation year" htmlFor="graduation_year" error={err('graduation_year')} hint={`${GRAD_YEAR_MIN}–${GRAD_YEAR_MAX}`}>
                      <input
                        id="graduation_year"
                        inputMode="numeric"
                        maxLength={4}
                        value={form.graduation_year}
                        onChange={(e) => set('graduation_year', e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="2026"
                        className={`field ${err('graduation_year') ? 'border-rose-300' : ''}`}
                      />
                    </Field>
                    <Field label="CGPA" htmlFor="cgpa" error={err('cgpa')} hint="On a 10 point scale">
                      <input
                        id="cgpa"
                        inputMode="decimal"
                        value={form.cgpa}
                        onChange={(e) => set('cgpa', e.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
                        placeholder="8.7"
                        className={`field ${err('cgpa') ? 'border-rose-300' : ''}`}
                      />
                    </Field>
                  </div>
                )}

                {step === 3 && (
                  <div className="grid gap-x-5 sm:grid-cols-2">
                    <Field label="Skills" htmlFor="skills" className="sm:col-span-2" hint="Tap trending skills to add them, or type your own and press Enter">
                      <SkillPicker id="skills" value={form.skills} onChange={(v) => set('skills', v)} />
                    </Field>
                    <Field label="LinkedIn URL" htmlFor="linkedin_url" error={err('linkedin_url')} hint="Optional">
                      <input
                        id="linkedin_url"
                        value={form.linkedin_url}
                        onChange={(e) => set('linkedin_url', e.target.value)}
                        placeholder="https://linkedin.com/in/you"
                        className={`field ${err('linkedin_url') ? 'border-rose-300' : ''}`}
                      />
                    </Field>
                    <Field label="GitHub URL" htmlFor="github_url" error={err('github_url')} hint="Optional">
                      <input
                        id="github_url"
                        value={form.github_url}
                        onChange={(e) => set('github_url', e.target.value)}
                        placeholder="https://github.com/you"
                        className={`field ${err('github_url') ? 'border-rose-300' : ''}`}
                      />
                    </Field>

                    <div className="sm:col-span-2">
                      <div className="panel mt-1 p-4">
                        <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Review</p>
                        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                          {[
                            ['Name', form.full_name],
                            ['PRN No.', form.prn],
                            ['Mobile', formatPhoneInternational(form.phone)],
                            ['Gender', form.gender],
                            ['Degree', form.degree],
                            ['College', form.college],
                            ['Graduating', form.graduation_year],
                            ['CGPA', form.cgpa],
                            ['Age', ageFrom(form.dob) !== null ? String(ageFrom(form.dob)) : ''],
                          ].map(([k, v]) => (
                            <div key={k} className="min-w-0">
                              <dt className="text-[11px] font-semibold text-slate-400">{k}</dt>
                              <dd className="truncate font-semibold text-slate-700">{v || '—'}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {formError && (
                <div className="animate-fade-in mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-semibold text-rose-700">
                  {formError}
                </div>
              )}

              <div className="mt-6 flex flex-col-reverse items-center gap-3 border-t border-slate-200/70 pt-5 sm:flex-row sm:justify-between">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={step === 1 || busy}
                  className="group inline-flex w-full items-center justify-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-semibold text-slate-600 transition duration-200 hover:bg-white hover:text-slate-900 hover:shadow-md hover:shadow-slate-200/60 active:scale-[.98] disabled:pointer-events-none disabled:opacity-40 sm:w-auto"
                >
                  <ChevronLeft className="h-4 w-4 transition-transform duration-200 group-hover:-translate-x-0.5" aria-hidden />
                  Back
                </button>

                <div className="flex w-full items-center gap-3 sm:w-auto">
                  {!stepComplete && step < STEPS.length && (
                    <span className="hidden text-[11px] font-semibold text-slate-400 sm:block">
                      Fill the required fields to continue
                    </span>
                  )}
                  {step < STEPS.length ? (
                    <button type="button" onClick={goNext} className="btn-primary w-full sm:w-auto">
                      Continue →
                    </button>
                  ) : (
                    <button type="submit" disabled={busy} className="btn-primary w-full sm:w-auto">
                      {busy ? 'Saving…' : variant === 'edit' ? 'Save changes →' : 'Complete onboarding →'}
                    </button>
                  )}
                </div>
              </div>
            </form>
          </section>
        </div>
      </main>
    </div>
  )
}
