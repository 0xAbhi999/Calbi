'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Eye, EyeOff } from 'lucide-react'
import { useStore } from '@/lib/store'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { Logo } from '@/components/Logo'
import { afterSignInRoute, signedInLandingRoute } from '@/lib/nextStep'
import { isProfileComplete } from '@/lib/validate'
import { getLiveUser } from '@/lib/session'
import { authFetch } from '@/lib/apiFetch'

function GoogleIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      />
    </svg>
  )
}

export default function LoginPage() {
  const router = useRouter()
  const { setUser, setProfile, setScores, setResume, user, profile, hydrated, reconcileForUser } = useStore()

  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [googleBusy, setGoogleBusy] = useState(false)
  const [redirecting, setRedirecting] = useState(false)

  const leavingRef = useRef(false)

  // A signed-in candidate should never see this screen. The cached user cannot
  // be trusted on its own — after a Supabase deletion + re-signup the old
  // profile/scores still sit in localStorage and would route the new account
  // straight to the dashboard. Validate against Supabase Auth, reconcile from
  // the DB when the cached account no longer matches, and only then route.
  useEffect(() => {
    if (leavingRef.current) return
    if (!user || !hydrated) return
    leavingRef.current = true
    setRedirecting(true)
    ;(async () => {
      let route = signedInLandingRoute(profile)
      const live = await getLiveUser()
      if (live === null) {
        // No live Supabase session for this cached account (deleted / expired)
        // — clear the stale cache and show the form again.
        localStorage.clear()
        setUser(null)
        setProfile(null)
        leavingRef.current = false
        setRedirecting(false)
        return
      }
      if (live && live.id !== user.id) {
        const { profile: p, hasAssessment } = await reconcileForUser(live)
        route = afterSignInRoute({ has_assessment: hasAssessment, has_onboarding: isProfileComplete(p) })
      }
      router.replace(route)
    })()
  }, [user, profile, hydrated, router, setUser, setProfile, reconcileForUser])

  // Supabase Google OAuth — redirects to Google, returns via /auth/callback.
  const handleGoogleAuth = async () => {
    setErr('')
    if (!isSupabaseConfigured()) {
      setErr('Google sign-in is not configured yet. Please use email instead.')
      return
    }
    const sb = getSupabase()
    if (!sb) {
      setErr('Google sign-in is unavailable right now. Please use email instead.')
      return
    }
    setGoogleBusy(true)
    try {
      const redirectTo = `${window.location.origin}/auth/callback`
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      })
      if (error) throw error
      // The browser leaves for Google here; the callback page finishes sign-in.
    } catch (e: any) {
      setErr(e?.message || 'Google sign-in could not be completed.')
      setGoogleBusy(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')

    if (!email.includes('@')) return setErr('Please enter a valid email address.')
    if (password.length < 6) return setErr('Password must be at least 6 characters.')

    setBusy(true)
    try {
      const endpoint = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login'
      const payload: any = {
        email: email.trim().toLowerCase(),
        password,
        role: 'student',
        full_name: fullName.trim() || email.split('@')[0],
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Authentication failed.')

      const authUser = data.user
      let resolvedName = authUser.name || payload.full_name

      // If we signed into a *different* account than the one cached (e.g. the
      // previous account was deleted in Supabase and re-created), drop the old
      // account's cached profile/resume/scores so nothing leaks across.
      if (authUser.id && user && user.id !== authUser.id) {
        setProfile(null)
        setScores(null)
        setResume(null)
      }

      // Hand the session to supabase-js BEFORE the profile prefetch: the
      // profile read is RLS-scoped to `auth.uid() = id`, and lib/apiFetch.ts can
      // only forward the access token once the session exists locally.
      try {
        const sb = getSupabase()
        if (sb && data.access_token && data.refresh_token) {
          await sb.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token })
        }
      } catch {
        /* demo mode */
      }

      if (authUser.id && data.has_onboarding) {
        try {
          const pr = await authFetch('/api/user/profile?user_id=' + authUser.id).then((r) => r.json())
          if (pr?.profile?.full_name?.trim()) {
            resolvedName = pr.profile.full_name.trim()
            setProfile(pr.profile)
          }
        } catch {
          /* keep server name */
        }
      }

      // After a successful sign-in/sign-up, send the user where they belong:
      // brand-new accounts go to /onboarding, but anyone who already completed
      // onboarding (or has a score) goes straight to their dashboard — so a
      // completed profile is never pushed back into the onboarding flow.
      const dest = afterSignInRoute(data)
      leavingRef.current = true
      setRedirecting(true)

      setUser({
        id: authUser.id,
        email: authUser.email,
        role: authUser.role || 'student',
        institution_id: authUser.institution_id || 'inst_iitm',
        name: resolvedName,
      })

      router.replace(dest)
    } catch (e: any) {
      setErr(e?.message || 'Authentication failed. Please try again.')
      setBusy(false)
    }
  }

  const switchMode = (m: 'signin' | 'signup') => {
    setMode(m)
    setErr('')
  }

  if (!hydrated || user || redirecting) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="glass-card animate-fade-up flex items-center gap-3 px-6 py-4">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
          <span className="text-sm font-bold text-slate-700">Signing you in…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm animate-fade-up">
        {/* Logo */}
        <Link href="/" className="flex flex-col items-center gap-2">
          <Logo height={44} />
          <span className="font-display text-lg font-extrabold tracking-tight text-slate-900">
            CALIBIAI<span className="text-indigo-600"> SCORE</span>
          </span>
        </Link>

        {/* Card */}
        <div className="glass-card mt-6 !p-7 sm:!p-8">
          <h1 className="font-display text-center text-2xl font-extrabold tracking-tight text-slate-900">
            {mode === 'signin' ? 'Welcome back' : 'Create account'}
          </h1>
          <p className="mt-1 text-center text-sm text-slate-500">
            {mode === 'signin' ? 'Sign in to continue' : 'Start your assessment journey'}
          </p>

          {/* Mode switch */}
          <div className="mt-5 grid grid-cols-2 gap-1 rounded-2xl border border-slate-200 bg-slate-100/80 p-1">
            <button
              type="button"
              onClick={() => switchMode('signin')}
              className={`rounded-xl py-2 text-sm font-bold transition-all duration-200 ${
                mode === 'signin'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => switchMode('signup')}
              className={`rounded-xl py-2 text-sm font-bold transition-all duration-200 ${
                mode === 'signup'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Sign up
            </button>
          </div>

          {/* Google */}
          <button
            type="button"
            disabled={googleBusy || busy}
            onClick={handleGoogleAuth}
            className="mt-5 flex w-full items-center justify-center gap-2.5 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-800 shadow-sm transition hover:border-slate-300 hover:shadow-md active:scale-[.99] disabled:opacity-60"
          >
            {googleBusy ? (
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600" />
            ) : (
              <GoogleIcon />
            )}
            Continue with Google
          </button>

          {/* Divider */}
          <div className="relative my-5 flex items-center justify-center">
            <div className="w-full border-t border-slate-200" />
            <span className="absolute bg-white px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              or
            </span>
          </div>

          {/* Email form */}
          <form onSubmit={handleSubmit} className="space-y-3.5">
            {mode === 'signup' && (
              <div className="animate-fade-in">
                <label htmlFor="fullName" className="mb-1.5 block text-xs font-bold text-slate-700">
                  Full name
                </label>
                <input
                  id="fullName"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Priya Sharma"
                  autoComplete="name"
                  className="field"
                />
              </div>
            )}
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-bold text-slate-700">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@college.edu"
                autoComplete="email"
                className="field"
              />
              {mode === 'signup' && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-indigo-600/90">
                  <span aria-hidden>💼</span>
                  <span>Use your <b>professional email</b> — it will be used for the hiring process and printed on your scorecard.</span>
                </p>
              )}
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-bold text-slate-700">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
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
              <div className="animate-fade-in rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-semibold text-rose-600">
                {err}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || googleBusy}
              className="btn-primary w-full !py-3 disabled:opacity-60"
            >
              {busy ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  {mode === 'signup' ? 'Creating account…' : 'Signing in…'}
                </span>
              ) : mode === 'signup' ? (
                'Create account'
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          {/* Bottom switch */}
          <p className="mt-5 text-center text-xs text-slate-500">
            {mode === 'signin' ? (
              <>
                New here?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('signup')}
                  className="font-bold text-indigo-600 hover:text-indigo-700"
                >
                  Create an account
                </button>
              </>
            ) : (
              <>
                Have an account?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('signin')}
                  className="font-bold text-indigo-600 hover:text-indigo-700"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>

        <Link
          href="/"
          className="mt-5 block text-center text-xs font-semibold text-slate-400 transition hover:text-slate-600"
        >
          ← Back to home
        </Link>
      </div>
    </div>
  )
}
