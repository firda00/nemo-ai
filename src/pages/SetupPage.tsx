import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Building2, Check, CircleHelp, Database, Rocket, Sparkles, Target } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { FeedbackWidget } from '../components/platform/FeedbackWidget'
import { Logo } from '../components/ui/Logo'
import { useAuth } from '../context/AuthContext'
import { supabase, isSupabaseEnabled } from '../lib/supabase'

const input = 'w-full rounded-xl border border-ice/[0.1] bg-bg/45 px-3.5 py-3 text-sm text-text outline-none transition placeholder:text-fog focus:border-accent-cyan/40 focus:ring-2 focus:ring-accent-cyan/10'
const choices = (items: { id: string; label: string }[], value: string[], toggle: (id: string) => void) => <div className="grid gap-2 sm:grid-cols-2">{items.map((item) => <button type="button" key={item.id} onClick={() => toggle(item.id)} className={`group flex min-h-12 items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left text-sm font-medium transition duration-200 active:scale-[0.99] ${value.includes(item.id) ? 'border-accent-cyan/35 bg-accent-cyan/[0.08] text-text' : 'border-ice/[0.08] bg-card/[0.025] text-muted hover:border-ice/[0.14] hover:bg-card/[0.06] hover:text-text'}`}><span>{item.label}</span><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${value.includes(item.id) ? 'border-accent-cyan bg-accent-cyan text-white' : 'border-ice/15 group-hover:border-ice/25'}`}>{value.includes(item.id) && <Check size={13} />}</span></button>)}</div>

const DEFAULT_FORM = { company: '', market: '', business_type: '', role: 'founder', goal: '', tasks: [] as string[], sources: [] as string[], action_policy: 'approval_required', accept_privacy: false, accept_terms: false, marketing_email: false, marketing_telegram: false }
const SETUP_STEP_NUMBERS = [1,2,3] as const

const goalSuggestions: Record<string, string[]> = {
  store: ['Понять продажи и остатки, затем увеличить прибыль магазина', 'Улучшить карточки товаров и убрать дефицит популярных SKU'],
  services: ['Получать больше целевых заявок и быстрее отвечать клиентам', 'Автоматизировать консультации и передачу горячих лидов менеджеру'],
  production: ['Сократить ручную работу и видеть отклонения в операциях', 'Контролировать сроки, ответственных и качество выполнения задач'],
}

export default function SetupPage() {
  const navigate = useNavigate()
  const { updateUser } = useAuth()
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState(() => {
    try {
      const saved = sessionStorage.getItem('nemo.setup.draft')
      if (!saved) return DEFAULT_FORM
      const parsed = JSON.parse(saved) as Partial<typeof DEFAULT_FORM>
      return { ...DEFAULT_FORM, ...parsed, accept_privacy: false, accept_terms: false }
    } catch { return DEFAULT_FORM }
  })
  const set = (patch: Partial<typeof form>) => setForm((v) => ({ ...v, ...patch }))
  const toggle = (key: 'tasks' | 'sources', id: string) => set({ [key]: form[key].includes(id) ? form[key].filter((v) => v !== id) : [...form[key], id] })
  const selectBusinessType = (businessType: string) => {
    const suggestedTask = businessType === 'store' ? 'marketplace' : businessType === 'services' ? 'sales' : 'operations'
    set({ business_type: businessType, tasks: form.tasks.length ? form.tasks : [suggestedTask] })
  }
  useEffect(() => {
    const { accept_privacy: _privacy, accept_terms: _terms, ...safeDraft } = form
    void _privacy; void _terms
    try { sessionStorage.setItem('nemo.setup.draft', JSON.stringify(safeDraft)) } catch { /* private mode */ }
  }, [form])
  const valid = step === 1
    ? Boolean(form.company.trim() && form.market && form.business_type)
    : step === 2
      ? form.goal.trim().length >= 10 && form.tasks.length > 0
      : form.sources.length > 0 && Boolean(form.action_policy) && form.accept_privacy && form.accept_terms
  const finish = async () => {
    if (!valid) return
    setBusy(true); setError('')
    if (isSupabaseEnabled && supabase) {
      const { data, error: invokeError } = await supabase.functions.invoke('complete-onboarding', { body: form })
      if (invokeError || !(data as { ok?: boolean } | null)?.ok) { setError('Не удалось сохранить onboarding. Попробуйте ещё раз.'); setBusy(false); return }
      await supabase.auth.refreshSession()
    }
    updateUser({ onboardingCompleted: true })
    try { sessionStorage.removeItem('nemo.setup.draft') } catch { /* private mode */ }
    setBusy(false)
    navigate('/onboarding', { replace: true })
  }
  // theme-dark-scope рядом с тёмным фоном: без него цвета текста следуют теме ПОСЕТИТЕЛЯ, и у
  // человека со светлой темой форма онбординга оказывается тёмным текстом на тёмном фоне. Та же
  // причина, что была на странице тарифов, где контраст падал до 1.17 при норме 4.5.
  const steps = [{ icon: Building2, label: 'Бизнес' }, { icon: Target, label: 'Цель' }, { icon: Database, label: 'Данные и доступ' }]
  const currentStep = steps[step - 1]
  const CurrentStepIcon = currentStep.icon
  return <div className="theme-dark-scope min-h-screen bg-void px-4 py-5 sm:py-8">
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between"><Logo /><span className="font-mono text-xs text-fog">Шаг {step} из {SETUP_STEP_NUMBERS.length}</span></div>
      <div className="mt-7 grid overflow-hidden rounded-[28px] border border-ice/[0.1] bg-panel/90 shadow-[0_30px_100px_-45px_rgba(31,41,90,0.9)] backdrop-blur-xl lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b border-ice/[0.08] bg-card/[0.025] p-5 lg:border-b-0 lg:border-r lg:p-7">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-cyan">Первый запуск Nemo</p>
          <h1 className="mt-3 text-2xl font-semibold leading-tight tracking-[-0.03em] text-text">Настроим команду под ваш бизнес</h1>
          <p className="mt-3 text-sm leading-6 text-muted">Три коротких шага. Обычно это занимает меньше двух минут.</p>
          <ol className="mt-6 flex gap-2 lg:flex-col lg:gap-1.5">{steps.map(({ icon: Icon, label }, index) => { const number = index + 1; const done = number < step; const active = number === step; return <li key={label} className={`flex flex-1 items-center gap-3 rounded-xl px-2.5 py-2.5 text-xs transition ${active ? 'bg-accent-cyan/[0.08] text-text' : 'text-muted'}`}><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${done ? 'border-teal/30 bg-teal/10 text-teal' : active ? 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan' : 'border-ice/[0.08]'}`}>{done ? <Check size={15} /> : <Icon size={15} />}</span><span className="hidden font-medium sm:inline">{label}</span></li>})}</ol>
          <div className="mt-6 hidden rounded-2xl border border-ice/[0.08] bg-bg/30 p-4 text-xs leading-5 text-muted lg:block"><CircleHelp size={16} className="mb-2 text-violet" />Черновик сохраняется в этом браузере. Пароли и ключи на этом этапе не нужны.</div>
        </aside>

        <main className="p-5 sm:p-8 lg:p-10">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/[0.09] text-accent-cyan"><CurrentStepIcon size={19} /></span><div><p className="text-xs font-medium text-accent-cyan">{currentStep.label}</p><p className="text-xs text-muted">Ответы можно изменить позже в настройках.</p></div></div>
          <div className="mt-6 min-h-[410px]">
            {step === 1 && <><h2 className="text-2xl font-semibold tracking-[-0.025em] text-text">Как устроен ваш бизнес?</h2><p className="mt-2 max-w-[58ch] text-sm leading-6 text-muted">Nemo использует это только для выбора первой команды и подходящих инструментов.</p><div className="mt-6 space-y-4"><label className="block"><span className="mb-2 block text-xs font-semibold text-text">Название компании или проекта</span><input autoFocus className={input} value={form.company} onChange={(e) => set({ company: e.target.value })} placeholder="Например, магазин Atlas" /></label><label className="block"><span className="mb-2 block text-xs font-semibold text-text">Основной рынок</span><select className={input} value={form.market} onChange={(e) => set({ market: e.target.value })}><option value="">Выберите рынок</option><option value="uz">Узбекистан</option><option value="us">США</option><option value="uz_us">Узбекистан и США</option><option value="other">Другой</option></select></label><div><p className="mb-2 text-xs font-semibold text-text">Тип бизнеса</p>{choices([{id:'store',label:'Интернет-магазин / marketplace'},{id:'services',label:'Услуги / обучение'},{id:'production',label:'Производство / операции'}], form.business_type ? [form.business_type] : [], selectBusinessType)}</div></div></>}
            {step === 2 && <><h2 className="text-2xl font-semibold tracking-[-0.025em] text-text">Какой результат нужен первым?</h2><p className="mt-2 max-w-[58ch] text-sm leading-6 text-muted">Опишите один измеримый результат на ближайшие 30 дней. Nemo не будет заставлять вас заполнять технические настройки.</p><textarea autoFocus className={`${input} mt-6 resize-none`} rows={4} value={form.goal} onChange={(e) => set({ goal: e.target.value })} placeholder="Например: каждую неделю видеть продажи, остатки и товары, которые нужно пополнить" />{goalSuggestions[form.business_type]?.length ? <div className="mt-3 flex flex-wrap gap-2">{goalSuggestions[form.business_type].map((suggestion) => <button key={suggestion} type="button" onClick={() => set({ goal: suggestion })} className="rounded-lg border border-ice/[0.08] px-2.5 py-1.5 text-left text-xs text-muted transition hover:border-violet/30 hover:text-text"><Sparkles size={12} className="mr-1.5 inline text-violet" />{suggestion}</button>)}</div> : null}<p className="mb-2 mt-6 text-xs font-semibold text-text">Что должна уметь первая команда?</p>{choices([{id:'sales',label:'Продажи'},{id:'marketplace',label:'Marketplace'},{id:'support',label:'Поддержка'},{id:'content',label:'Контент'},{id:'operations',label:'Операции'},{id:'development',label:'Разработка'},{id:'research',label:'Исследования'}], form.tasks, (id) => toggle('tasks', id))}</>}
            {step === 3 && <><h2 className="text-2xl font-semibold tracking-[-0.025em] text-text">Откуда брать данные?</h2><p className="mt-2 max-w-[58ch] text-sm leading-6 text-muted">Выберите источники. Подключение можно выполнить позже — сейчас пароли и API-ключи не запрашиваются.</p><div className="mt-6">{choices([{id:'website',label:'Сайты и браузер'},{id:'files',label:'Файлы и таблицы'},{id:'uzum',label:'Uzum Market'},{id:'telegram',label:'Telegram'},{id:'email',label:'Email'},{id:'crm',label:'CRM'},{id:'github',label:'GitHub'},{id:'google',label:'Google Workspace'},{id:'later',label:'Пока без подключений'}], form.sources, (id) => toggle('sources', id))}</div><p className="mb-2 mt-6 text-xs font-semibold text-text">Что агент может делать сам?</p><div className="grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => set({ action_policy:'read_only' })} className={`rounded-2xl border p-3.5 text-left transition ${form.action_policy === 'read_only' ? 'border-accent-cyan/35 bg-accent-cyan/[0.08]' : 'border-ice/[0.08] hover:bg-card/[0.05]'}`}><b className="text-sm text-text">Только анализ</b><p className="mt-1 text-xs leading-5 text-muted">Читает данные, ничего не меняет.</p></button><button type="button" onClick={() => set({ action_policy:'approval_required' })} className={`rounded-2xl border p-3.5 text-left transition ${form.action_policy === 'approval_required' ? 'border-accent-cyan/35 bg-accent-cyan/[0.08]' : 'border-ice/[0.08] hover:bg-card/[0.05]'}`}><b className="text-sm text-text">Действия после подтверждения</b><p className="mt-1 text-xs leading-5 text-muted">Готовит изменение и ждёт вашего решения.</p></button></div><div className="mt-6 space-y-3 rounded-2xl border border-ice/[0.08] bg-bg/25 p-4 text-sm"><label className="flex items-start gap-3 text-text"><input className="mt-1 accent-cyan" type="checkbox" checked={form.accept_privacy} onChange={(e) => set({ accept_privacy:e.target.checked })} /><span>Я принимаю <Link className="text-accent-cyan underline underline-offset-2" to="/privacy" target="_blank">Privacy Policy</Link></span></label><label className="flex items-start gap-3 text-text"><input className="mt-1 accent-cyan" type="checkbox" checked={form.accept_terms} onChange={(e) => set({ accept_terms:e.target.checked })} /><span>Я принимаю <Link className="text-accent-cyan underline underline-offset-2" to="/terms" target="_blank">Terms of Service</Link></span></label><details className="pt-1 text-xs text-muted"><summary className="cursor-pointer select-none font-medium">Необязательные обновления</summary><div className="mt-3 space-y-2"><p>Рассылки необязательны и не влияют на доступ.</p><label className="flex gap-3"><input type="checkbox" checked={form.marketing_email} onChange={(e) => set({ marketing_email:e.target.checked })} />Полезные обновления по Email</label><label className="flex gap-3"><input type="checkbox" checked={form.marketing_telegram} onChange={(e) => set({ marketing_telegram:e.target.checked })} />Полезные обновления в Telegram</label></div></details></div></>}
          </div>
          {error && <p role="alert" className="mt-4 rounded-xl border border-danger/20 bg-danger/10 px-3 py-2.5 text-sm text-danger">{error}</p>}
          <div className="mt-7 flex items-center justify-between border-t border-ice/[0.08] pt-5"><Button variant="ghost" disabled={step === 1 || busy} onClick={() => setStep((v) => v - 1)}><ArrowLeft size={16}/>Назад</Button>{step < 3 ? <Button disabled={!valid} onClick={() => setStep((v) => v + 1)}>Далее<ArrowRight size={16}/></Button> : <Button disabled={!valid || busy} onClick={finish}><Rocket size={16}/>{busy ? 'Сохраняем…' : 'Собрать первую команду'}</Button>}</div>
        </main>
      </div>
      <FeedbackWidget />
    </div>
  </div>
}
