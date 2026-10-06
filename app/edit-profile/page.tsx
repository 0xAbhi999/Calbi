'use client'
/**
 * /edit-profile — a dedicated, one-page profile editor for returning users.
 *
 * This is NOT the onboarding wizard. Onboarding is a one-time step for new
 * sign-ups (/onboarding); once the profile is complete the user is never sent
 * back there. Here they edit any field (name, contact, academics, presence),
 * save to the same backend as the rest of the app, and land back on their
 * student dashboard where the updated profile and resume data show immediately.
 *
 * Editing a profile never changes the 1000-point assessment score (that is
 * locked after submission), but it IS what the score card, resume score and
 * report display — so we keep the store in sync and re-verify against the
 * server right before navigating home.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { Navbar } from '@/components/Navbar'
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
  PHONE_COUNTRY_CODE,
  PHONE_DIGITS,
  ageFrom,
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
        {error ? <span className="animate-fade-in text-[11px] font-semibold text-rose-600">⚠ {error}</span>
          : hint ? <span className="text-[11px] text-slate-400">{hint}</span> : null}
      </div>
    </div>
  )
}

function Spinner({ light = false }: { light?: boolean }) {
  return <span className={`h-4 w-4 animate-spin rounded-full border-2 ${light ? 'border-white/40 border-t-white' : 'border-slate-200 border-t-indigo-600'}`} />
}

export default function EditProfilePage() {
  const router = useRouter()
  const { user, profile, setProfile, hydrated } = useStore()
  const [form, setForm] = useState<Form>(() => normalizeOnboardingForm())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState('')
  const [loaded, setLoaded] = useState(false)

  // Prefill from the profile in the store; if it wasn't hydrated yet, pull it
  // from the server so returning users on a fresh device see their real rows.
  useEffect(() => {
    if (!hydrated || !user?.id) return
    if (profile) {
      setForm(normalizeOnboardingForm(profile))
      setLoaded(true)
      return
    }
    authFetch('/api/user/profile?user_id=' + user.id)
      .then((r) => r.json())
      .then((d) => {
        if (d.profile) {
          setProfile(d.profile)
          setForm(normalizeOnboardingForm(d.profile))
        } else {
          setForm((f) => ({ ...f, full_name: user.name || f.full_name }))
        }
      })
      .catch(() => setForm((f) => ({ ...f, full_name: user.name || f.full_name })))
      .finally(() => setLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, user?.id])

  // Guard: signed-out visitors go to login.
  useEffect(() => {
    if (hydrated && !user) router.replace('/login')
  }, [hydrated, user, router])

  const set = (k: keyof Form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (touched) setErrors(validateAll({ ...form, [k]: v }))
  }

  function validateAll(f: Form): Record<string, string> {
    const e: Record<string, string> = {}
    if (f.full_name.trim().length < 2) e.full_name = 'Please enter your full name.'
    if (!isValidPhone(f.phone)) e.phone = `Mobile number must be exactly ${PHONE_DIGITS} digits.`
    if (!isValidDob(f.dob)) e.dob = `Enter a valid date of birth (age ${15}–${100}).`
    if (!GENDER_OPTIONS.includes(f.gender as any)) e.gender = 'Choose Male, Female or Other.'
    if (!isValidPrn(f.prn)) e.prn = 'Use 4–20 letters/numbers, or leave it blank.'
    if (!f.degree.trim()) e.degree = 'Degree is required.'
    if (!f.college.trim()) e.college = 'College / university is required.'
    if (!f.graduation_year) e.graduation_year = 'Graduation year is required.'
    else if (!isValidGradYear(f.graduation_year)) e.graduation_year = `Enter a year between ${GRAD_YEAR_MIN} and ${GRAD_YEAR_MAX}.`
    if (!isValidCgpa(f.cgpa)) e.cgpa = 'CGPA must be between 0 and 10.'
    if (!isValidUrl(f.linkedin_url)) e.linkedin_url = 'Enter a valid https:// URL or leave it blank.'
    if (!isValidUrl(f.github_url)) e.github_url = 'Enter a valid https:// URL or leave it blank.'
    return e
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')
    const errs = validateAll(form)
    setErrors(errs)
    setTouched(true)
    if (Object.keys(errs).length) {
      setFormError('Some details still need attention — check the highlighted fields.')
      return
    }
    setBusy(true)
    const payload = {
      ...form,
      id: user?.id,
      email: user?.email,
      full_name: form.full_name.trim(),
      prn: normalizePrn(form.prn),
      phone: normalizePhone(form.phone),
      graduation_year: Number(form.graduation_year),
      cgpa: Number(form.cgpa),
    }
    try {
      const res = await authFetch('/api/user/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not save your profile.')
      noteSyncWarning(data)
      setProfile(data.profile || payload)
    } catch (err: any) {
      // Offline / demo mode — still keep the local store so the change sticks.
      console.warn('profile save fell back to local store:', err?.message)
      setProfile(payload)
    }
    setBusy(false)
    setSaved(true)
    setTimeout(() => router.replace('/dashboard/student'), 700)
  }

  const err = (k: string) => (touched ? errors[k] : undefined)

  if (!hydrated) {
    return (
      <div>
        <Navbar />
        <main className="flex min-h-screen items-center justify-center px-4">
          <div className="glass-card animate-fade-up flex items-center gap-3 px-6 py-4">
            <Spinner /> <span className="text-sm font-bold text-slate-700">Loading your profile…</span>
          </div>
        </main>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="glass-card animate-fade-up flex items-center gap-3 px-6 py-4">
          <Spinner /> <span className="text-sm font-bold text-slate-700">Redirecting to login…</span>
        </div>
      </div>
    )
  }

  const displayName = form.full_name.trim() || user.name || user.email

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="blob-a absolute -left-24 top-10 h-72 w-72 rounded-full bg-violet-300/30 blur-3xl" />
        <div className="blob-b absolute -right-16 top-40 h-80 w-80 rounded-full bg-indigo-300/30 blur-3xl" />
      </div>
      <Navbar />
      <main className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <SyncWarningBanner className="mb-5" />
        <div className="flex items-center justify-between gap-3 animate-fade-up">
          <div>
            <h1 className="text-2xl font-black text-slate-900 sm:text-3xl">Edit your profile</h1>
            <p className="mt-1 text-sm text-slate-500">Keep your details accurate — they drive your scorecard and report.</p>
          </div>
          <Link
            href="/dashboard/student"
            className="group inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/70 px-3.5 py-2 text-xs font-bold text-slate-600 backdrop-blur transition duration-200 hover:bg-white hover:text-slate-900 hover:shadow-md"
          >
            <ChevronLeft className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" aria-hidden />
            Back
          </Link>
        </div>

        <form onSubmit={submit} className="glass-card relative mt-6 animate-fade-up overflow-hidden">
          {saved && (
            <div className="animate-pop absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-white/85 backdrop-blur-sm">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-3xl text-white shadow-xl shadow-emerald-300/60">✓</div>
              <p className="text-lg font-black text-slate-900">Profile updated</p>
              <p className="text-sm text-slate-500">Taking you to your dashboard…</p>
            </div>
          )}

          <div className="p-7 sm:p-8">
            <div className="flex items-center gap-4 rounded-2xl border border-slate-200/70 bg-white/60 p-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl calibiai-gradient text-lg font-black text-white shadow-lg shadow-indigo-300/50">
                {(displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('')) || 'C'}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-900">{displayName}</p>
                <p className="truncate text-xs text-slate-500">{user.email}</p>
              </div>
            </div>

            {/* About you */}
            <h2 className="mt-7 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-slate-400">
              <span aria-hidden>👤</span> About you
            </h2>
            <div className="mt-3 grid gap-x-5 sm:grid-cols-2">
              <Field label="Full name" htmlFor="full_name" error={err('full_name')} className="sm:col-span-2" hint="As it should appear on your scorecard">
                <input id="full_name" value={form.full_name} onChange={(e) => set('full_name', e.target.value)} placeholder="Priya Sharma" className={`field ${err('full_name') ? 'border-rose-300' : ''}`} />
              </Field>

              <Field label="Mobile number" htmlFor="phone" error={err('phone')} hint={`Exactly ${PHONE_DIGITS} digits — digits only`}>
                <div className="flex items-stretch overflow-hidden rounded-xl border bg-white/80 focus-within:ring-4 focus-within:border-indigo-400 focus-within:ring-indigo-100">
                  <span className="flex items-center gap-1.5 border-r border-slate-200 bg-slate-50/80 px-3 text-sm font-bold text-slate-600">
                    <span aria-hidden>🇮🇳</span>+{PHONE_COUNTRY_CODE}
                  </span>
                  <input id="phone" inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210"
                    value={normalizePhone(form.phone)}
                    onChange={(e) => set('phone', normalizePhone(e.target.value).slice(0, PHONE_DIGITS))}
                    aria-invalid={!!err('phone')} className={`w-full bg-transparent px-3.5 py-2.5 text-sm tracking-[0.06em] outline-none placeholder:tracking-normal placeholder:text-slate-400 ${err('phone') ? 'text-rose-600' : 'text-slate-800'}`} />
                </div>
              </Field>

              <Field label="Gender" htmlFor="gender" error={err('gender')} hint="Male, Female or Other">
                <select id="gender" value={form.gender} onChange={(e) => set('gender', e.target.value)} className={`field ${err('gender') ? 'border-rose-300' : ''}`}>
                  <option value="">Select gender</option>
                  {GENDER_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </Field>

              <Field label="Date of birth" htmlFor="dob" error={err('dob')} hint={form.dob && !err('dob') && ageFrom(form.dob) !== null ? `Age ${ageFrom(form.dob)}` : 'Pick your date of birth'}>
                <input id="dob" type="date" value={form.dob} onChange={(e) => set('dob', e.target.value)} className={`field ${err('dob') ? 'border-rose-300' : ''}`} />
              </Field>
            </div>

            {/* Academics */}
            <h2 className="mt-7 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-slate-400">
              <span aria-hidden>🎓</span> Academics
            </h2>
            <div className="mt-3 grid gap-x-5 sm:grid-cols-2">
              <Field label="Degree" htmlFor="degree" error={err('degree')} hint="Search and pick your programme">
                <SearchableSelect id="degree" options={DEGREE_OPTIONS} placeholder="Search degree…" ariaLabel="Degree" value={form.degree} invalid={!!err('degree')} onChange={(v) => set('degree', v)} />
              </Field>

              <Field label="College / University" htmlFor="college" error={err('college')} hint="Type to search — Pune & Amravati colleges are preloaded">
                <CollegeCombobox
                  id="college"
                  value={form.college}
                  invalid={!!err('college')}
                  onChange={(v) => set('college', v)}
                />
              </Field>

              <Field label="PRN No." htmlFor="prn" error={err('prn')} hint="Optional — helps your college match this score">
                <input id="prn" value={form.prn} onChange={(e) => set('prn', normalizePrn(e.target.value).slice(0, 20))} placeholder="2021COEP001" autoComplete="off" className={`field ${err('prn') ? 'border-rose-300' : ''}`} />
              </Field>

              <Field label="Graduation year" htmlFor="graduation_year" error={err('graduation_year')} hint={`${GRAD_YEAR_MIN}–${GRAD_YEAR_MAX}`}>
                <input id="graduation_year" inputMode="numeric" maxLength={4} value={form.graduation_year} onChange={(e) => set('graduation_year', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="2026" className={`field ${err('graduation_year') ? 'border-rose-300' : ''}`} />
              </Field>

              <Field label="CGPA" htmlFor="cgpa" error={err('cgpa')} hint="On a 10 point scale">
                <input id="cgpa" inputMode="decimal" value={form.cgpa} onChange={(e) => set('cgpa', e.target.value.replace(/[^\d.]/g, '').slice(0, 5))} placeholder="8.7" className={`field ${err('cgpa') ? 'border-rose-300' : ''}`} />
              </Field>
            </div>

            {/* Presence */}
            <h2 className="mt-7 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-slate-400">
              <span aria-hidden>🔗</span> Your presence
            </h2>
            <div className="mt-3 grid gap-x-5 sm:grid-cols-2">
              <Field label="Skills" htmlFor="skills" className="sm:col-span-2" hint="Tap trending skills to add them, or type your own and press Enter">
                <SkillPicker id="skills" value={form.skills} onChange={(v) => set('skills', v)} />
              </Field>
              <Field label="LinkedIn URL" htmlFor="linkedin_url" error={err('linkedin_url')} hint="Optional">
                <input id="linkedin_url" value={form.linkedin_url} onChange={(e) => set('linkedin_url', e.target.value)} placeholder="https://linkedin.com/in/you" className={`field ${err('linkedin_url') ? 'border-rose-300' : ''}`} />
              </Field>
              <Field label="GitHub URL" htmlFor="github_url" error={err('github_url')} hint="Optional">
                <input id="github_url" value={form.github_url} onChange={(e) => set('github_url', e.target.value)} placeholder="https://github.com/you" className={`field ${err('github_url') ? 'border-rose-300' : ''}`} />
              </Field>
            </div>

            {formError && (
              <div className="animate-fade-in mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-semibold text-rose-700">
                {formError}
              </div>
            )}

            <div className="mt-8 flex flex-col-reverse items-center gap-3 border-t border-slate-200/70 pt-5 sm:flex-row sm:justify-between">
              <Link href="/dashboard/student" className="btn-soft w-full sm:w-auto">Cancel</Link>
              <button type="submit" disabled={busy} className="btn-primary w-full sm:w-auto">
                {busy ? <span className="flex items-center gap-2"><Spinner light /> Saving…</span> : 'Save changes'}
              </button>
            </div>
          </div>
        </form>
      </main>
    </div>
  )
}
