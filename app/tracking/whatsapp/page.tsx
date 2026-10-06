'use client'
import { useRouter } from 'next/navigation'
import { Navbar } from '@/components/Navbar'
import { useStore } from '@/lib/store'
import { Stepper } from '@/components/Stepper'
import { WHATSAPP_COMMUNITY_URL } from '@/lib/community'
import { WhatsAppGlyph } from '@/components/WhatsAppCommunity'
import { authFetch } from '@/lib/apiFetch'
import { noteSyncWarning } from '@/lib/syncNotice'

function Inner(){
  const router = useRouter()
  const {tracking,setTracking,user} = useStore()
  const complete = async ()=>{
    setTracking({...tracking, whatsapp:true})
    try {
      const res = await authFetch('/api/user/tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user?.id, action: 'join_whatsapp', completed: true }),
      })
      noteSyncWarning(await res.json().catch(() => ({})))
    } catch { /* demo mode */ }
    setTimeout(()=> router.replace('/tracking/linkedin'), 450)
  }
  return (
    <div>
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
        <Stepper step={4} />
        <div className="mt-6 glass-card text-center animate-fade-up">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500 mx-auto flex items-center justify-center text-3xl shadow-lg shadow-emerald-200">💬</div>
          <h1 className="mt-4 text-2xl font-black text-slate-900">Join our student community</h1>
          <p className="text-slate-500 mt-2 text-sm max-w-md mx-auto">Get assessment tips, placement alerts and study with peers — all on WhatsApp. Optional but recommended.</p>

          <div className="mt-6 panel p-4 flex items-center gap-4 text-left max-w-md mx-auto">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500 flex items-center justify-center text-white font-black shrink-0">WA</div>
            <div className="text-sm">
              <div className="font-bold text-slate-800">CalibiAI Students</div>
              <div className="text-slate-500 text-xs">Placement updates, tips & jobs</div>
            </div>
          </div>

          <div className="mt-7 flex justify-center gap-3">
            <a href={WHATSAPP_COMMUNITY_URL} target="_blank" rel="noreferrer" onClick={complete} className="btn-primary !bg-none bg-emerald-500 !shadow-emerald-300/50 hover:bg-emerald-600 inline-flex items-center gap-2"><WhatsAppGlyph className="h-4 w-4" /> Join WhatsApp →</a>
            <button onClick={complete} className="btn-soft">I've joined ✓</button>
          </div>
          <button onClick={()=>router.replace('/tracking/linkedin')} className="mt-4 text-xs font-semibold text-slate-400 hover:text-slate-600">Skip for now</button>
          {tracking.whatsapp && <div className="mt-4 text-xs text-emerald-600 font-semibold animate-pop">✓ Done</div>}
        </div>
      </main>
    </div>
  )
}
export default function Page(){ return <Inner/> }
