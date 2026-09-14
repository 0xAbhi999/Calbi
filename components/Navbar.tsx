'use client'
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useStore } from '@/lib/store'
import { HelpButton } from '@/components/HelpButton'
import { Logo } from '@/components/Logo'
import { AiAvatar } from '@/components/AiAvatar'
import { User, LogOut, ChevronDown, Users } from 'lucide-react'
import { COMMUNITY_APP_URL, COMMUNITY_NAV_ROUTES } from '@/lib/community'

/** The name the user chose on their profile page wins over the account /
 *  email-derived username (e.g. "Prajwal" over "prajwalgulhane85"). */
function displayNameFor(profile: any, user: any): string {
  const fromProfile = profile?.full_name?.trim?.()
  if (fromProfile) return fromProfile
  const fromUser = user?.name?.trim?.()
  if (fromUser) return fromUser
  return (user?.email?.split('@')[0] || 'User').trim()
}

export function Navbar() {
  const { user, profile, logout, hydrated } = useStore()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const pathname = usePathname()

  // The CalibiAI Community link is intentionally limited to the home page, the
  // student dashboard and the profile — it must never appear on /assessment or
  // any other flow (see COMMUNITY_NAV_ROUTES).
  const showCommunity = COMMUNITY_NAV_ROUTES.includes(pathname ?? '')

  // The brand links to the student dashboard when signed in, and to the
  // marketing home page when signed out. A signed-in user should never land on
  // the public home page by clicking the logo.
  const homeHref = user ? '/dashboard/student' : '/'

  // Close the dropdown when clicking outside.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  // The name from the saved profile (what the user typed on the profile page)
  // takes priority over the account username derived from the email at signup.
  const displayName = displayNameFor(profile, user)

  return (
    <header className="sticky top-0 z-40 border-b border-white/50 bg-white/55 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link href={homeHref} className="flex items-center gap-2.5">
          <Logo className="drop-shadow-lg" />
          <span className="font-extrabold tracking-tight text-slate-900 text-lg">CALIBIAI<span className="text-indigo-600"> SCORE</span></span>
        </Link>
        <div className="flex items-center gap-2 text-sm">
          <HelpButton />
          {showCommunity && (
            <a
              href={COMMUNITY_APP_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Open CalibiAI Community in a new tab"
              className="flex items-center gap-1.5 rounded-full border border-indigo-100 bg-indigo-50/80 px-3 py-2 text-xs font-bold text-indigo-600 transition hover:bg-indigo-100 hover:text-indigo-700"
            >
              <Users className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">CalibiAI Community</span>
            </a>
          )}
          {!hydrated ? (
            /* Not hydrated yet: hold a placeholder the same size as the account
               control. Without it the top-right corner renders "Sign in" on the
               first paint and then swaps to the avatar + name once localStorage
               has been read — a visible jump on every page, and part of the
               flicker seen when arriving on /instructions. */
            <span
              aria-hidden
              className="flex h-9 w-9 animate-pulse items-center justify-center rounded-full bg-slate-200/60"
            />
          ) : user ? (
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Account menu"
                className="group flex items-center gap-1.5 rounded-full border border-white/60 bg-white/70 py-1 pl-1 pr-2 shadow-sm backdrop-blur transition hover:bg-white hover:shadow-md"
              >
                {/* Circular AI avatar — the same generated avatar the user set up
                    on the profile page (falls back to a default face if none is
                    saved yet). */}
                <span className="relative flex h-9 w-9 items-center justify-center rounded-full select-none shadow-inner ring-2 ring-white/70">
                  <AiAvatar name={displayName} config={profile?.ai_avatar} size={36} className="block" />
                </span>
                <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
              </button>

              {open && (
                <div
                  role="menu"
                  className="absolute right-0 mt-2 w-64 origin-top-right animate-pop overflow-hidden rounded-2xl border border-white/60 bg-white/95 shadow-xl shadow-slate-500/15 backdrop-blur-xl"
                >
                  {/* Account header */}
                  <div className="border-b border-slate-100 px-4 py-3">
                    <div className="truncate text-sm font-bold text-slate-800">{displayName}</div>
                    <div className="truncate text-xs text-slate-500">{user.email}</div>
                    <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-xs font-semibold capitalize text-indigo-600">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      {user.role}
                    </span>
                  </div>

                  {/* Menu items */}
                  <div className="p-1.5">
                    <Link
                      href="/profile"
                      role="menuitem"
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-indigo-50 hover:text-indigo-700"
                    >
                      <User className="h-4 w-4 text-slate-400" />
                      See My Profile
                    </Link>
                    <button
                      onClick={logout}
                      role="menuitem"
                      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-rose-50 hover:text-rose-600"
                    >
                      <LogOut className="h-4 w-4 text-slate-400" />
                      Logout
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Link href="/login" className="btn-primary !px-5 !py-2 text-xs">Sign in</Link>
          )}
        </div>
      </div>
    </header>
  )
}
