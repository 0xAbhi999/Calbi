'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleHelp, Loader2, Mail, Send, ShieldCheck, X } from 'lucide-react'
import { useStore } from '@/lib/store'
import { fetchWithTimeout } from '@/lib/fetchTimeout'
import { validHelpMessage, validHelpPhone } from '@/lib/help'

/** In-document help: no new tab, navigation, fullscreen exit, or proctoring bypass. */
export function HelpButton({ assessment = false, disabled = false }: { assessment?: boolean; disabled?: boolean }) {
  const { user } = useStore()
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const emailField = useRef<HTMLInputElement>(null)
  const requestLock = useRef(false)
  // Reused while retrying, so a duplicated click cannot store the request twice.
  const requestId = useRef('')
  const [host, setHost] = useState<Element | null>(null)
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  function close() {
    dialog.current?.close()
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }

  function launch() {
    if (!email) setEmail(user?.email || '')
    // A portal escapes the navbar's backdrop-filter stacking context; placing
    // it inside the fullscreen element also works for element-level fullscreen.
    setHost(document.fullscreenElement || document.body)
    setOpen(true)
  }

  useEffect(() => {
    if (!open || !dialog.current) return
    const element = dialog.current
    element.showModal() // native focus trap + inert background, still in this document
    emailField.current?.focus({ preventScroll: true })
    return () => { if (element.open) element.close() }
  }, [open])

  // Timer expiry / a genuine proctoring violation must never be hidden by help.
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (requestLock.current) return
    if (!validHelpPhone(phone)) { setError('Enter a valid phone number with 7–15 digits, including your country code where applicable.'); return }
    if (!validHelpMessage(message)) { setError('Please describe your issue in 10–3,000 characters.'); return }
    requestLock.current = true
    setBusy(true); setError('')
    if (!requestId.current) requestId.current = crypto.randomUUID()
    try {
      // Our own API: the request is stored in Supabase (`help_requests`) instead
      // of an external form service with a monthly submission limit, and the
      // server queues + retries it if the database is momentarily unreachable.
      const response = await fetchWithTimeout('/api/help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: requestId.current,
          student_id: user?.id || '',
          email: email.trim(),
          phone: phone.trim(),
          message: message.trim(),
          page: window.location.pathname,
        }),
      }, 20000)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Your request could not be sent. Please try again. Your message has been kept.')
      setSent(true)
      setMessage('')
      requestId.current = ''
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your request could not be sent. Check your connection and try again. Your message has been kept.')
    } finally {
      setBusy(false)
      requestLock.current = false
    }
  }

  return <>
    <button ref={trigger} type="button" onClick={launch} disabled={disabled} aria-label="Ask for help" title="Ask for help" aria-haspopup="dialog" aria-expanded={open} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-indigo-200 bg-indigo-50/80 text-indigo-600 shadow-sm transition hover:bg-indigo-100 hover:text-indigo-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-200 disabled:opacity-40">
      <CircleHelp size={20} aria-hidden="true" />
    </button>
    {open && host && createPortal(
      <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`} onCancel={event => { event.preventDefault(); close() }} onKeyDown={event => {
        // Handle Escape in-page rather than asking the browser to leave fullscreen.
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      }} className="m-auto w-[calc(100%_-_2rem)] max-w-lg max-h-[90dvh] overflow-y-auto rounded-3xl border border-white/80 bg-slate-50 p-0 text-slate-800 shadow-2xl shadow-indigo-950/20 backdrop:bg-slate-900/45 backdrop:backdrop-blur-sm motion-safe:animate-fade-up">
        <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-400" />
        <div className="p-5 sm:p-8">
          <div className="mb-5 flex items-center justify-between">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-600"><CircleHelp size={26} aria-hidden="true" /></span>
            <button type="button" onClick={close} aria-label="Close help" className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 hover:bg-slate-200 focus-visible:ring-4 focus-visible:ring-indigo-200"><X size={20} /></button>
          </div>
          <h2 id={`${id}-title`} className="font-display text-2xl font-extrabold text-slate-900">{sent ? 'We’ve received your request.' : 'A little help, right here.'}</h2>
          <p id={`${id}-intro`} className="mt-2 text-sm leading-relaxed text-slate-500">{sent ? 'Our team will review your message and use the contact details you shared to get in touch.' : 'Something not working as expected? Tell us what happened and our team can help.'}</p>
          {assessment && <div className="mt-4 flex gap-2 rounded-xl border border-indigo-100 bg-indigo-50 p-3 text-xs leading-relaxed text-indigo-700"><ShieldCheck size={17} className="shrink-0" /><span>Using this help form won’t trigger a warning. Stay in this tab and fullscreen. Your assessment timer keeps running.</span></div>}
          {sent ? <div className="mt-7 text-center" role="status">
            <CheckCircle2 size={44} className="mx-auto text-emerald-500" />
            <p className="mt-3 text-sm font-semibold text-slate-700">Help request sent successfully</p>
            <button type="button" onClick={close} className="btn-primary mt-6 w-full">{assessment ? 'Back to assessment' : 'Done'}</button>
            <button type="button" onClick={() => { setSent(false); setError('') }} className="mt-4 text-xs font-semibold text-indigo-600 underline underline-offset-4">Send another request</button>
          </div> : <form onSubmit={submit} className="mt-6 space-y-4">
            <div><label htmlFor={`${id}-email`} className="mb-1.5 block text-sm font-semibold text-slate-700">Email address <span className="text-indigo-600">*</span></label>
              <input ref={emailField} id={`${id}-email`} name="email" type="email" autoComplete="email" required maxLength={254} disabled={busy} value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" className="field" />
            </div>
            <div><label htmlFor={`${id}-phone`} className="mb-1.5 block text-sm font-semibold text-slate-700">Phone number <span className="text-indigo-600">*</span></label>
              <input id={`${id}-phone`} name="phone" type="tel" autoComplete="tel" required maxLength={30} disabled={busy} value={phone} onChange={event => setPhone(event.target.value)} placeholder="+91 98765 43210" className="field" aria-describedby={`${id}-phone-hint`} />
              <p id={`${id}-phone-hint`} className="mt-1.5 text-xs text-slate-500">Include your country code if outside India.</p>
            </div>
            <div><label htmlFor={`${id}-message`} className="mb-1.5 block text-sm font-semibold text-slate-700">How can we help? <span className="text-indigo-600">*</span></label>
              <textarea id={`${id}-message`} name="message" required minLength={10} maxLength={3000} rows={4} disabled={busy} value={message} onChange={event => setMessage(event.target.value)} placeholder="Describe the issue and what you were trying to do…" className="field resize-y" aria-describedby={`${id}-message-hint`} />
              <div id={`${id}-message-hint`} className="mt-1.5 flex justify-between gap-3 text-xs text-slate-500"><span>At least 10 characters. Don’t share passwords.</span><span className="shrink-0 tabular-nums">{message.length}/3,000</span></div>
            </div>
            <p className="flex gap-2 text-xs leading-relaxed text-slate-500"><Mail size={15} className="mt-0.5 shrink-0" /><span>Your contact details, message and current page are stored securely in your CalibiAI account for our support team.</span></p>
            {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
            <button type="submit" disabled={busy} className="btn-primary w-full">{busy ? <><Loader2 size={16} className="animate-spin" />Sending request…</> : <><Send size={16} />Send help request</>}</button>
            <p className="text-center text-xs text-slate-400">{busy ? 'You can close this form; sending will continue.' : 'All fields are required.'}</p>
          </form>}
        </div>
      </dialog>, host,
    )}
  </>
}
