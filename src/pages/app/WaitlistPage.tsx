import { useState } from 'react'
import type { ReactNode } from 'react'
import { CalendarDays, CheckCircle2, Building2, Mail, Phone, Send, User } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { submitWaitlist } from '../../lib/waitlist'
import { isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'

const fieldCls = 'w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-violet/50'

export default function WaitlistPage() {
  const { t } = useI18n()
  const [form, setForm] = useState({ name: '', email: '', phone: '', company: '', leads: '100-300/month', note: '' })
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  // Honeypot: невидимое поле, которое заполняют только боты.
  const [website, setWebsite] = useState('')

  const submit = async () => {
    if (busy) return
    setError(false)
    setBusy(true)
    const ok = await submitWaitlist({ ...form, source: 'waitlist', website })
    setBusy(false)
    if (!ok) {
      setError(true)
      return
    }
    setSaved(true)
  }

  return (
    <div className="container-page max-w-6xl py-8">
      <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-3xl border border-white/10 bg-panel/80 p-8">
          <p className="mono-label">Pilot waitlist</p>
          <h1 className="mt-2 text-4xl font-extrabold tracking-tight text-text">Book a demo for your business</h1>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            We are onboarding high-growth businesses that lose leads because follow-up and CRM are manual. The pilot focuses on one workflow: qualify business leads, write follow-ups, update CRM, and send daily reports.
          </p>
          <div className="mt-6 space-y-3">
            {[
              ['30-minute demo', 'See the AI Sales Team process your lead examples.'],
              ['Pilot setup', 'Telegram/Sheets/CRM can be connected after the demo.'],
              ['Founder-led onboarding', 'We work directly with our pilot companies.'],
            ].map(([title, desc]) => (
              <div key={title} className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-teal" />
                <div><p className="text-sm font-semibold text-text">{title}</p><p className="mt-1 text-xs text-muted">{desc}</p></div>
              </div>
            ))}
          </div>
        </div>

        <div className="card rounded-3xl p-6">
          {saved ? (
            <div className="grid min-h-[460px] place-items-center text-center">
              <div>
                <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-teal/15 text-teal"><CheckCircle2 size={28} /></span>
                <h2 className="mt-5 text-2xl font-bold text-text">{isSupabaseEnabled ? t('waitlistPage.receivedTitle') : t('waitlistPage.demoTitle')}</h2>
                <p className="mt-2 max-w-md text-sm text-muted">
                  {isSupabaseEnabled ? t('waitlistPage.receivedNote') : t('waitlistPage.demoSavedNote')}
                </p>
                <div className="mt-6 flex justify-center gap-3"><Button to="/app/create-team">Back to demo</Button><Button to="/app/results" variant="outline">View results</Button></div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand text-white"><CalendarDays size={20} /></span>
                <div><h2 className="text-xl font-bold text-text">Request pilot access</h2><p className="text-xs text-muted">{isSupabaseEnabled ? t('waitlistPage.replyNote') : t('waitlistPage.demoNote')}</p></div>
              </div>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <Field icon={User} label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={fieldCls} placeholder="Founder / manager" /></Field>
                <Field icon={Mail} label="Email"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={fieldCls} placeholder="you@company.com" /></Field>
                <Field icon={Phone} label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={fieldCls} placeholder="+998..." /></Field>
                <Field icon={Building2} label="Company"><input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className={fieldCls} placeholder="Company name" /></Field>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5"><span className="text-xs text-muted">Monthly leads</span><select value={form.leads} onChange={(e) => setForm({ ...form, leads: e.target.value })} className={fieldCls}><option>0-100/month</option><option>100-300/month</option><option>300-1000/month</option><option>1000+/month</option></select></label>
                <label className="block space-y-1.5"><span className="text-xs text-muted">Biggest problem</span><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className={fieldCls} placeholder="Follow-up, CRM, reporting..." /></label>
              </div>
              {/* Honeypot: вне экрана, недоступно людям — боты заполняют его сами. */}
              <input
                type="text"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                name="website"
                autoComplete="off"
                tabIndex={-1}
                aria-hidden="true"
                className="absolute -left-[9999px] h-0 w-0 opacity-0"
              />
              {error && <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{t('waitlistPage.error')}</p>}
              <Button onClick={submit} disabled={busy || !form.email.trim() || !form.company.trim()} fullWidth className="mt-5"><Send size={16} /> {busy ? '…' : 'Book demo'}</Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ icon: Icon, label, children }: { icon: typeof User; label: string; children: ReactNode }) {
  return <label className="block space-y-1.5"><span className="flex items-center gap-1.5 text-xs text-muted"><Icon size={13} /> {label}</span>{children}</label>
}
