import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Bot, Check, Loader2, Search } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useI18n } from '../../i18n'
import { EMPLOYEE_PRESETS, EMPLOYEE_PRESET_LIMITS, employeePresetConfig, getEmployeePreset, type EmployeePreset } from '../../data/employeePresets'
import { MODELS } from '../../data/platform'
import { blankAgent, useAgentStore } from '../../store/useAgentStore'
import { isSupabaseEnabled } from '../../lib/supabase'
import { cn } from '../../lib/cn'
import type { PlatformAgent } from '../../types/platform'

const field = 'w-full min-w-0 rounded-xl border border-ice/15 bg-bg/70 px-3 py-2.5 text-sm text-text outline-none focus:border-cyan/60 focus:ring-2 focus:ring-cyan/15 disabled:opacity-60'

export default function EmployeesPage() {
  const { user, sessionGeneration } = useAuth()
  return <EmployeeStudio key={`${user?.id ?? 'guest'}:${sessionGeneration}`} />
}

function EmployeeStudio() {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const initial = getEmployeePreset(params.get('role') ?? '') ?? EMPLOYEE_PRESETS[0]
  const [selected, setSelected] = useState(initial)
  const [query, setQuery] = useState('')
  const [name, setName] = useState(initial.title[lang])
  const [goal, setGoal] = useState(initial.examples[lang])
  const [context, setContext] = useState('')
  const [language, setLanguage] = useState(lang)
  const [model, setModel] = useState(MODELS[0].id)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const alive = useRef(true)
  const attempt = useRef<{ signature: string; draft: PlatformAgent } | null>(null)
  const addAgent = useAgentStore(state => state.addAgent)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const choose = (preset: EmployeePreset) => {
    if (savingRef.current) return
    setSelected(preset)
    setName(preset.title[lang])
    setGoal(preset.examples[lang])
    setError('')
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (savingRef.current) return
    setError('')
    let config: Partial<PlatformAgent>
    try { config = employeePresetConfig(selected, { name, goal, context, language, model }) }
    catch { setError(t('employees.invalid')); return }
    const signature = JSON.stringify(config)
    if (!attempt.current || attempt.current.signature !== signature) {
      attempt.current = { signature, draft: { ...blankAgent(), ...config, id: crypto.randomUUID() } }
    }
    savingRef.current = true
    setSaving(true)
    try {
      const result = await addAgent(attempt.current.draft)
      if (!alive.current) return
      if (result.error || !result.id) { setError(t('employees.saveError')); return }
      navigate(`/app/agents/${encodeURIComponent(result.id)}`)
    } catch {
      if (alive.current) setError(t('employees.saveError'))
    } finally {
      savingRef.current = false
      if (alive.current) setSaving(false)
    }
  }

  const found = EMPLOYEE_PRESETS.filter(preset => `${preset.title[lang]} ${preset.description[lang]}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  return <main className="container-page max-w-6xl py-6 sm:py-9">
    <Link to="/app/teams" className="inline-flex items-center gap-2 text-sm text-muted hover:text-text"><ArrowLeft size={16} />{t('employees.back')}</Link>
    <header className="mt-6 border-b border-ice/10 pb-6">
      <p className="text-xs font-medium text-cyan">{t('employees.count', { count: EMPLOYEE_PRESETS.length - 1 })}</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text sm:text-4xl">{t('employees.title')}</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">{t('employees.subtitle')}</p>
      <nav className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-cyan"><Link to="/app/approvals" className="underline-offset-4 hover:underline">{t('approvals.title')}</Link></nav>
    </header>
    <div className="mt-6 grid min-w-0 gap-7 lg:grid-cols-[290px_minmax(0,1fr)] lg:gap-9">
      <aside className="min-w-0" aria-label={t('employees.browse')}>
        <label className="relative block">
          <Search size={16} className="pointer-events-none absolute left-3 top-3.5 text-muted" />
          <span className="sr-only">{t('employees.search')}</span>
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('employees.search')} className={`${field} pl-9`} />
        </label>
        <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-1">
          {found.map(preset => <button key={preset.id} type="button" disabled={saving} aria-pressed={selected.id === preset.id} onClick={() => choose(preset)} className={cn('flex min-w-0 items-start gap-3 rounded-xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/50 disabled:opacity-60', selected.id === preset.id ? 'border-cyan/30 bg-cyan/[0.07]' : 'border-transparent hover:border-ice/10 hover:bg-white/[0.03]')}>
            <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-text">{preset.title[lang]}</span><span className="mt-1 block text-xs leading-5 text-muted">{preset.description[lang]}</span></span>
            {selected.id === preset.id && <Check size={15} className="mt-0.5 shrink-0 text-cyan" aria-label={t('employees.selected')} />}
          </button>)}
        </div>
        {!found.length && <div className="py-5 text-sm leading-6 text-muted"><p>{t('employees.empty')}</p><button type="button" onClick={() => { setQuery(''); choose(getEmployeePreset('custom')!) }} className="mt-3 text-cyan underline underline-offset-4">{t('employees.custom')}</button></div>}
      </aside>
      <section className="min-w-0" aria-labelledby="employee-heading">
        <div className="flex items-center gap-3"><span className="rounded-xl bg-cyan/10 p-2.5 text-cyan"><Bot size={21} /></span><h2 id="employee-heading" className="text-xl font-semibold text-text">{selected.title[lang]}</h2></div>
        <dl className="mt-5 space-y-4 border-b border-ice/10 pb-6 text-sm">
          {(['inputs', 'outputs', 'limits'] as const).map(key => <div key={key}><dt className="font-medium text-text">{t(`employees.${key}`)}</dt><dd className="mt-1 leading-6 text-muted">{selected[key][lang]}</dd></div>)}
        </dl>
        <form onSubmit={save} className="mt-6 space-y-4" aria-label={t('employees.configure')}>
          <fieldset disabled={saving} className="min-w-0 space-y-4">
            <label className="block space-y-1.5"><span className="text-xs font-medium text-muted">{t('employees.name')}</span><input name="employeeName" required maxLength={EMPLOYEE_PRESET_LIMITS.name} value={name} onChange={event => setName(event.target.value)} className={field} /></label>
            <label className="block space-y-1.5"><span className="text-xs font-medium text-muted">{t('employees.goal')}</span><textarea name="employeeGoal" required maxLength={EMPLOYEE_PRESET_LIMITS.goal} rows={4} value={goal} onChange={event => setGoal(event.target.value)} className={`${field} resize-y`} /></label>
            <label className="block space-y-1.5"><span className="text-xs font-medium text-muted">{t('employees.context')}</span><textarea name="employeeContext" maxLength={EMPLOYEE_PRESET_LIMITS.context} rows={3} value={context} onChange={event => setContext(event.target.value)} className={`${field} resize-y`} /><span className="block text-xs leading-5 text-muted">{t('employees.contextHint')}</span></label>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <label className="block min-w-0 space-y-1.5"><span className="text-xs font-medium text-muted">{t('employees.model')}</span><select value={model} onChange={event => setModel(event.target.value)} className={field}>{MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <label className="block min-w-0 space-y-1.5"><span className="text-xs font-medium text-muted">{t('employees.language')}</span><select value={language} onChange={event => setLanguage(event.target.value as typeof language)} className={field}><option value="uz">O‘zbekcha</option><option value="ru">Русский</option><option value="en">English</option></select></label>
            </div>
          </fieldset>
          <p className="text-xs leading-5 text-muted">{t('employees.draft')}</p>
          {selected.riskTier === 'regulated' && <p className="text-xs leading-5 text-muted">{t('employees.regulated')}</p>}
          {!isSupabaseEnabled && <p className="rounded-xl border border-amber/20 bg-amber/5 px-3 py-2 text-xs leading-5 text-amber">{t('employees.demo')}</p>}
          {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          <button type="submit" disabled={saving || !name.trim() || !goal.trim()} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-cyan px-4 py-2.5 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-50 sm:w-auto">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}{t(saving ? 'employees.saving' : 'employees.save')}
          </button>
          <p className="max-w-xl text-xs leading-5 text-muted">{t('employees.next')}</p>
        </form>
      </section>
    </div>
  </main>
}
