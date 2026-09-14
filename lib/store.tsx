'use client'
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { flattenAssessmentResult } from './resultShape'

type User = { id: string, email: string, role: string, institution_id: string, name?: string }
type Store = {
  user: User | null,
  setUser: (u: User | null) => void,
  profile: any, setProfile: (p:any)=>void,
  resume: any, setResume: (r:any)=>void,
  tracking: { whatsapp:boolean, linkedin:boolean }, setTracking: (t:any)=>void,
  session: any, setSession: (s:any)=>void,
  scores: any, setScores: (s:any)=>void,
  hydrated: boolean,
  logout: ()=>void,
  hasLocalKey: (key: string) => boolean,
  reconcileForUser: (live: { id: string, email?: string, role?: string, name?: string }) => Promise<{ profile: any, hasAssessment: boolean }>,
}

const Ctx = createContext<Store | null>(null)

function StoreProviderRoot({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<User | null>(null)
  // Reconciliation and persistence callbacks are memoized below. Keep the
  // latest account available to those stable callbacks without making their
  // identities change on every auth/profile update.
  const userRef = useRef<User | null>(null)
  userRef.current = user
  const [profile, setProfile] = useState<any>(null)
  const [resume, setResume] = useState<any>(null)
  const [tracking, setTracking] = useState({ whatsapp: false, linkedin: false })
  const [session, setSession] = useState<any>(null)
  const [scores, setScores] = useState<any>(null)
  // Gate persistence until localStorage has been read once. Without this, the
  // session effect sees the initial `null` on mount and wipes `calibiai_session`
  // before hydration finishes — which made /assessment bounce straight back to
  // /instructions after clicking "START 120-MIN TIMER →".
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    try {
      const rawU = localStorage.getItem('calibiai_user')
      const rawP = localStorage.getItem('calibiai_profile')
      if (rawU) {
        const u = JSON.parse(rawU)
        // The profile's full name is the display name the user chose — make
        // sure a stale email-derived account name (e.g. "prajwalgulhane85")
        // never wins over it after a refresh.
        const full = rawP ? String(JSON.parse(rawP)?.full_name || '').trim() : ''
        if (full && u?.name !== full) {
          const merged = { ...u, name: full }
          setUserState(merged)
          localStorage.setItem('calibiai_user', JSON.stringify(merged))
        } else {
          setUserState(u)
        }
      }
      const p = localStorage.getItem('calibiai_profile'); if (p) setProfile(JSON.parse(p))
      const r = localStorage.getItem('calibiai_resume'); if (r) setResume(JSON.parse(r))
      const t = localStorage.getItem('calibiai_tracking'); if (t) setTracking(JSON.parse(t))
      const s = localStorage.getItem('calibiai_session'); if (s) setSession(JSON.parse(s))
      const sc = localStorage.getItem('calibiai_scores'); if (sc) setScores(JSON.parse(sc))
    } catch {}
    setHydrated(true)
  }, [])

  const setUser = useCallback((u: User | null) => {
    setUserState(u)
    if (u) localStorage.setItem('calibiai_user', JSON.stringify(u))
    else localStorage.removeItem('calibiai_user')
  }, [])
  // Persist synchronously inside the setters too. Relying only on the
  // useEffect-based persistence below is unsafe: callers can navigate away
  // in the same tick, unloading the page before React flushes the effect.
  // These callbacks must stay stable: many pages use them from effects, and a
  // new identity after every store update can turn a harmless refresh into a
  // render/request loop.
  const setProfileSafe = useCallback((p: any) => {
    setProfile(p)
    if (p) localStorage.setItem('calibiai_profile', JSON.stringify(p))
    else localStorage.removeItem('calibiai_profile')
    const full = typeof p?.full_name === 'string' ? p.full_name.trim() : ''
    if (full) {
      setUserState(current => {
        if (!current || current.name === full) return current
        const merged = { ...current, name: full }
        localStorage.setItem('calibiai_user', JSON.stringify(merged))
        return merged
      })
    }
  }, [])
  useEffect(() => {
    if (!hydrated) return
    const full = typeof profile?.full_name === 'string' ? profile.full_name.trim() : ''
    if (!full || !user || user.name === full) return
    const merged = { ...user, name: full }
    setUserState(merged)
    localStorage.setItem('calibiai_user', JSON.stringify(merged))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, profile?.full_name])
  const setResumeSafe = useCallback((r: any) => {
    setResume(r)
    if (r) localStorage.setItem('calibiai_resume', JSON.stringify(r))
    else localStorage.removeItem('calibiai_resume')
  }, [])
  const setSessionSafe = useCallback((s: any) => {
    setSession(s)
    if (s) localStorage.setItem('calibiai_session', JSON.stringify(s))
    else localStorage.removeItem('calibiai_session')
  }, [])
  const setScoresSafe = useCallback((s: any) => {
    setScores(s)
    if (s) localStorage.setItem('calibiai_scores', JSON.stringify(s))
    else localStorage.removeItem('calibiai_scores')
  }, [])
  useEffect(() => { if (!hydrated) return; if (profile) localStorage.setItem('calibiai_profile', JSON.stringify(profile)) }, [profile, hydrated])
  useEffect(() => { if (!hydrated) return; if (resume) localStorage.setItem('calibiai_resume', JSON.stringify(resume)) }, [resume, hydrated])
  useEffect(() => { if (!hydrated) return; localStorage.setItem('calibiai_tracking', JSON.stringify(tracking)) }, [tracking, hydrated])
  useEffect(() => { if (!hydrated) return; if (session) localStorage.setItem('calibiai_session', JSON.stringify(session)) }, [session, hydrated])
  useEffect(() => { if (!hydrated) return; if (scores) localStorage.setItem('calibiai_scores', JSON.stringify(scores)) }, [scores, hydrated])

  const logout = useCallback(() => {
    localStorage.clear()
    setUserState(null); setProfile(null); setResume(null); setTracking({ whatsapp: false, linkedin: false }); setSession(null); setScores(null)
    window.location.href = '/login'
  }, [])

  const hasLocalKey = useCallback((key: string) => {
    try { return localStorage.getItem(key) != null } catch { return false }
  }, [])

  /** Drop every cached slice that belongs to an account, keeping session ids/tickets intact. */
  const clearLocalState = useCallback(() => {
    for (const k of ['calibiai_profile', 'calibiai_resume', 'calibiai_scores', 'calibiai_tracking', 'calibiai_report_ready', 'calibiai_just_submitted']) {
      try { localStorage.removeItem(k) } catch {}
    }
    setProfile(null); setResume(null); setScores(null); setTracking({ whatsapp: false, linkedin: false })
  }, [])

  /**
   * Re-sync the client store against the live Supabase account after login /
   * OAuth callback. If the cached user belongs to a *different* account (e.g.
   * the old account was deleted in Supabase and a new one was created), all of
   * the old account's cached data is wiped first so nothing leaks across. The
   * profile and scores are then re-hydrated from the DB, never from the cache.
   *
   * The cached account id is read from React state AND raw localStorage because
   * this can run from `/auth/callback` before hydration has completed.
   *
   * Returns the DB profile + whether the user has an assessment result so
   * callers can compute the post-login route without a second fetch.
   */
  const reconcileForUser = useCallback(async (live: { id: string, email?: string, role?: string, name?: string }) => {
    let cachedId = userRef.current?.id
    try {
      if (!cachedId) {
        const raw = localStorage.getItem('calibiai_user')
        if (raw) cachedId = JSON.parse(raw)?.id
      }
    } catch { /* ignore corrupt cache */ }
    if (cachedId && cachedId !== live.id) clearLocalState()
    setUser({ id: live.id, email: live.email || '', role: live.role || 'student', institution_id: 'inst_iitm', name: live.name })
    let profile: any = null
    let hasAssessment = false
    let resultRow: any = null
    let fetched = false
    try {
      const [pRes, sRes] = await Promise.all([
        fetch(`/api/user/profile?user_id=${encodeURIComponent(live.id)}`),
        fetch(`/api/user/scores?student_id=${encodeURIComponent(live.id)}`),
      ])
      const p = await pRes.json()
      const s = await sRes.json()
      fetched = true
      profile = p?.profile || null
      resultRow = s?.result || null
      hasAssessment = !!resultRow
    } catch { /* transient failure — keep whatever is already cached */ }
    // Only write through (and possibly clear) when the DB fetch succeeded; a
    // network hiccup must never wipe cached profile/scores.
    if (fetched) {
      setProfileSafe(profile)
      setScoresSafe(flattenAssessmentResult(resultRow))
    }
    return { profile, hasAssessment }
  }, [clearLocalState, setProfileSafe, setScoresSafe, setUser])

  const value = useMemo<Store>(() => ({
    user,
    setUser,
    profile,
    setProfile: setProfileSafe,
    resume,
    setResume: setResumeSafe,
    tracking,
    setTracking,
    session,
    setSession: setSessionSafe,
    scores,
    setScores: setScoresSafe,
    hydrated,
    logout,
    hasLocalKey,
    reconcileForUser,
  }), [
    user, setUser, profile, setProfileSafe, resume, setResumeSafe,
    tracking, session, setSessionSafe, scores, setScoresSafe, hydrated,
    logout, hasLocalKey, reconcileForUser,
  ])

  return (
    <Ctx.Provider value={value}>
      {children}
    </Ctx.Provider>
  )
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const existing = useContext(Ctx)
  if (existing) {
    return <>{children}</>
  }
  return <StoreProviderRoot>{children}</StoreProviderRoot>
}

export const useStore = () => {
  const ctx = useContext(Ctx)
  if (!ctx) {
    throw new Error('useStore must be used within a StoreProvider')
  }
  return ctx
}
