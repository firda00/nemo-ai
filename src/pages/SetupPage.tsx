import { useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Rocket } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { Logo } from '../components/ui/Logo'
import { useAuth } from '../context/AuthContext'
import { supabase, isSupabaseEnabled } from '../lib/supabase'

const input = 'w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-text outline-none focus:border-violet/50'
const choices = (items: { id: string; label: string }[], value: string[], toggle: (id: string) => void) => <div className="grid gap-2 sm:grid-cols-2">{items.map((item) => <button type="button" key={item.id} onClick={() => toggle(item.id)} className={`rounded-xl border p-3 text-left text-sm ${value.includes(item.id) ? 'border-violet/60 bg-violet/10 text-text' : 'border-white/10 text-muted'}`}>{item.label}{value.includes(item.id) && <Check size={14} className="float-right text-violet" />}</button>)}</div>

export default function SetupPage() {
  const navigate = useNavigate()
  const { updateUser } = useAuth()
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ company: '', market: '', role: '', goal: '', tasks: [] as string[], sources: [] as string[], action_policy: 'approval_required', accept_privacy: false, accept_terms: false, marketing_email: false, marketing_telegram: false })
  const set = (patch: Partial<typeof form>) => setForm((v) => ({ ...v, ...patch }))
  const toggle = (key: 'tasks' | 'sources', id: string) => set({ [key]: form[key].includes(id) ? form[key].filter((v) => v !== id) : [...form[key], id] })
  const valid = step === 1 ? Boolean(form.company.trim() && form.market && form.role) : step === 2 ? form.goal.trim().length >= 10 && form.tasks.length > 0 : step === 3 ? form.sources.length > 0 : step === 4 ? Boolean(form.action_policy) : form.accept_privacy && form.accept_terms
  const finish = async () => {
    if (!valid) return
    setBusy(true); setError('')
    if (isSupabaseEnabled && supabase) {
      const { data, error: invokeError } = await supabase.functions.invoke('complete-onboarding', { body: form })
      if (invokeError || !(data as { ok?: boolean } | null)?.ok) { setError('Не удалось сохранить onboarding. Попробуйте ещё раз.'); setBusy(false); return }
      await supabase.auth.refreshSession()
    }
    updateUser({ onboardingCompleted: true })
    setBusy(false)
    navigate('/onboarding', { replace: true })
  }
  // theme-dark-scope рядом с тёмным фоном: без него цвета текста следуют теме ПОСЕТИТЕЛЯ, и у
  // человека со светлой темой форма онбординга оказывается тёмным текстом на тёмном фоне. Та же
  // причина, что была на странице тарифов, где контраст падал до 1.17 при норме 4.5.
  return <div className="theme-dark-scope min-h-screen bg-void px-4 py-6"><div className="mx-auto max-w-2xl"><Logo /><div className="mt-8 flex gap-2">{[1,2,3,4,5].map((n) => <span key={n} className={`h-1.5 flex-1 rounded-full ${n <= step ? 'bg-violet' : 'bg-white/10'}`} />)}</div><div className="card mt-5 rounded-3xl p-6 sm:p-8">
    {step === 1 && <><h1 className="text-2xl font-semibold text-text">Расскажите о бизнесе</h1><p className="mt-2 text-sm text-muted">Это обязательно: Nemo использует контекст для первой команды.</p><div className="mt-5 space-y-4"><input className={input} value={form.company} onChange={(e) => set({ company: e.target.value })} placeholder="Компания или проект" /><select className={input} value={form.market} onChange={(e) => set({ market: e.target.value })}><option value="">Рынок</option><option value="uz">Узбекистан</option><option value="us">США</option><option value="uz_us">Узбекистан и США</option><option value="other">Другой</option></select><select className={input} value={form.role} onChange={(e) => set({ role: e.target.value })}><option value="">Ваша роль</option><option value="founder">Founder</option><option value="seller">Seller</option><option value="agency">Agency</option><option value="developer">Developer</option><option value="operations">Operations</option><option value="other">Other</option></select></div></>}
    {step === 2 && <><h1 className="text-2xl font-semibold text-text">Главная цель</h1><textarea className={`${input} mt-5`} rows={4} value={form.goal} onChange={(e) => set({ goal: e.target.value })} placeholder="Какой результат нужен в ближайшие 30 дней?" /><div className="mt-4">{choices([{id:'sales',label:'Продажи'},{id:'marketplace',label:'Marketplace'},{id:'support',label:'Поддержка'},{id:'content',label:'Контент'},{id:'operations',label:'Операции'},{id:'development',label:'Разработка'},{id:'research',label:'Исследования'}], form.tasks, (id) => toggle('tasks', id))}</div></>}
    {step === 3 && <><h1 className="text-2xl font-semibold text-text">Данные и каналы</h1><p className="mt-2 text-sm text-muted">Выберите всё, что есть сейчас. «Подключу позже» является допустимым ответом.</p><div className="mt-5">{choices([{id:'website',label:'Website'},{id:'files',label:'Файлы и таблицы'},{id:'uzum',label:'Uzum'},{id:'telegram',label:'Telegram'},{id:'email',label:'Email'},{id:'crm',label:'CRM'},{id:'github',label:'GitHub'},{id:'google',label:'Google'},{id:'later',label:'Подключу позже'}], form.sources, (id) => toggle('sources', id))}</div></>}
    {step === 4 && <><h1 className="text-2xl font-semibold text-text">Политика действий</h1><div className="mt-5 space-y-3"><button type="button" onClick={() => set({ action_policy:'read_only' })} className={`w-full rounded-2xl border p-4 text-left ${form.action_policy === 'read_only' ? 'border-violet/60 bg-violet/10' : 'border-white/10'}`}><b className="text-text">Read-only</b><p className="mt-1 text-sm text-muted">Только читать, анализировать и готовить отчёты.</p></button><button type="button" onClick={() => set({ action_policy:'approval_required' })} className={`w-full rounded-2xl border p-4 text-left ${form.action_policy === 'approval_required' ? 'border-violet/60 bg-violet/10' : 'border-white/10'}`}><b className="text-text">Draft + owner approval</b><p className="mt-1 text-sm text-muted">Любое внешнее действие сначала попадает в очередь подтверждений.</p></button></div></>}
    {step === 5 && <><h1 className="text-2xl font-semibold text-text">Условия и связь</h1><div className="mt-5 space-y-3 text-sm"><label className="flex gap-3 text-text"><input type="checkbox" checked={form.accept_privacy} onChange={(e) => set({ accept_privacy:e.target.checked })} />Я принимаю <Link className="text-cyan underline" to="/privacy" target="_blank">Privacy Policy</Link></label><label className="flex gap-3 text-text"><input type="checkbox" checked={form.accept_terms} onChange={(e) => set({ accept_terms:e.target.checked })} />Я принимаю <Link className="text-cyan underline" to="/terms" target="_blank">Terms of Service</Link></label><p className="pt-3 text-xs text-muted">Рассылки необязательны и не влияют на доступ.</p><label className="flex gap-3 text-muted"><input type="checkbox" checked={form.marketing_email} onChange={(e) => set({ marketing_email:e.target.checked })} />Получать полезные обновления по Email</label><label className="flex gap-3 text-muted"><input type="checkbox" checked={form.marketing_telegram} onChange={(e) => set({ marketing_telegram:e.target.checked })} />Получать полезные обновления в Telegram</label></div></>}
    {error && <p className="mt-4 text-sm text-danger">{error}</p>}<div className="mt-7 flex justify-between"><Button variant="ghost" disabled={step === 1 || busy} onClick={() => setStep((v) => v - 1)}><ArrowLeft size={16}/>Назад</Button>{step < 5 ? <Button disabled={!valid} onClick={() => setStep((v) => v + 1)}>Далее<ArrowRight size={16}/></Button> : <Button disabled={!valid || busy} onClick={finish}><Rocket size={16}/>{busy ? 'Сохраняем...' : 'Создать первую команду'}</Button>}</div>
  </div></div></div>
}
