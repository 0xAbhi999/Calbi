'use client'
import { useEffect, useState } from 'react'
import { clearSyncWarning, readSyncWarning } from '@/lib/syncNotice'

/**
 * Shows the "saved locally, Supabase write failed" notice an API route returned
 * (see lib/syncNotice.ts). Deliberately non-blocking: the student's data is safe
 * on this device, but they (and whoever supports the deployment) need to see
 * that Postgres is out of sync instead of assuming the save reached the
 * database. Renders nothing when there is no pending warning.
 */
export function SyncWarningBanner({ className = '' }: { className?: string }) {
  const [message, setMessage] = useState('')

  useEffect(() => {
    const warning = readSyncWarning()
    if (warning) setMessage(warning.message)
  }, [])

  if (!message) return null

  return (
    <div
      role="status"
      className={`animate-fade-in flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800 ${className}`}
    >
      <span aria-hidden className="text-sm leading-none">⚠️</span>
      <p className="flex-1 leading-snug">{message}</p>
      <button
        type="button"
        onClick={() => {
          clearSyncWarning()
          setMessage('')
        }}
        className="rounded-lg px-2 py-1 text-[11px] font-bold text-amber-700 transition hover:bg-amber-100"
      >
        Dismiss
      </button>
    </div>
  )
}
