import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ArrowLeft, ArrowRight, Check, Rocket, HelpCircle, Plus, FileText, Trash2, Sparkles, Cpu, SlidersHorizontal, ChevronDown } from 'lucide-react'
import { useI18n } from '../i18n'
import { useAgentStore, blankAgent } from '../store/useAgentStore'
import { useToast } from '../components/ui/Toast'
import { supabase, isSupabaseEnabled } from '../lib/supabase'
import { templates, PROVIDERS, kindPresets, COUNTRIES, NICHES } from '../data/platform'
import { AGENT_PRICE_USD } from '../data/billing'
import { channelMeta, channelLabel, agentTypeMeta, AGENT_KINDS } from '../lib/platformMeta'
import { Logo } from '../components/ui/Logo'
import { Button } from '../components/ui/Button'
import { LanguageToggle } from '../components/ui/LanguageToggle'
import { Stepper } from '../components/ui/Stepper'
import { TestChat } from '../components/platform/TestChat'
import { TimezoneField, LanguageField } from '../components/platform/TimezoneField'
import { cn } from '../lib/cn'
import type { ChannelType, PlatformAgent, KnowledgeDoc, AgentKind } from '../types/platform'

const inputCls = 'glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-cobalt/50 focus:shadow-glow'

export default function OnboardingPage() {
  const { t, lang, dict } = useI18n()
  const navigate = useNavigate()
  const toast = useToast()
  const addAgent = useAgentStore((s) => s.addAgent)

  const [mode, setMode] = useState<'start' | 'wizard'>('start')
  const [step, setStep] = useState(1)
  const [draft, setDraft] = useState<PlatformAgent>(blankAgent())
  const [saving, setSaving] = useState(false)
  const [aiDesc, setAiDesc] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [tgToken, setTgToken] = useState('')
  const [showDetails, setShowDetails] = useState(false)

  const set = (patch: Partial<PlatformAgent>) => setDraft((d) => ({ ...d, ...patch }))
  const setPrompt = (patch: Partial<PlatformAgent['prompt']>) => setDraft((d) => ({ ...d, prompt: { ...d.prompt, ...patch } }))

  // dynamic wizard steps — runner agents (research / multi-agent) skip channels + test
  const isRunner = draft.type === 'research' || draft.type === 'workflow'
  const stepKeys: ('agent' | 'prompt' | 'channels' | 'test')[] = isRunner ? ['agent', 'prompt'] : ['agent', 'prompt', 'channels', 'test']
  const stepLabels = isRunner ? dict.platform.onboarding.steps.slice(0, 2) : dict.platform.onboarding.steps
  const cur = stepKeys[step - 1]
  const lastStep = stepKeys.length

  const addKnowledge = () => {
    const doc: KnowledgeDoc = { id: `k${Date.now()}`, name: 'Yangi_manba.pdf', source: 'file', status: 'indexed', size: '1.1 MB' }
    set({ knowledge: [...draft.knowledge, doc] })
  }

  // start the wizard with a chosen kind. Apply the kind's preset prompt when the
  // prompt is still empty (so each type acts like a ready preset); qualifier also
  // auto-enables the lead form.
  const chooseType = (k: AgentKind) => {
    setDraft((d) => {
      const empty = !d.prompt.role && !d.prompt.tasks && !d.prompt.tone && !d.prompt.rules
      const preset = kindPresets[k]
      return {
        ...d,
        type: k,
        prompt: empty && preset ? { ...preset } : d.prompt,
        role: empty && preset ? preset.role : d.role,
        leadForm: { ...d.leadForm, enabled: k === 'qualifier' ? true : d.leadForm.enabled },
      }
    })
    setStep(1)
    setMode('wizard')
  }

  const pickTemplate = (id: string) => {
    const tpl = templates.find((x) => x.id === id)
    if (tpl) setDraft((d) => ({ ...d, name: tpl.name[lang], role: tpl.name[lang], avatarColor: tpl.color, prompt: tpl.preset, type: id === 'qualifier' ? 'qualifier' : 'chat' }))
    setStep(1)
    setMode('wizard')
  }

  // "ИИ создаёт агента" — the built-in agent WRITES the prompt from a description.
  // keepType=true (in-wizard) only fills the prompt for the type the user picked;
  // keepType=false (start card) lets the AI also choose the type, then opens the wizard.
  const composeWithAI = async (opts?: { keepType?: boolean }) => {
    if (aiDesc.trim().length < 8 || aiBusy) return
    const keepType = opts?.keepType ?? false
    setAiError('')
    setAiBusy(true)
    try {
      if (isSupabaseEnabled && supabase) {
        const { data, error } = await supabase.functions.invoke('compose-agent', {
          body: { description: aiDesc.trim(), ui_lang: lang, ...(keepType ? { type: draft.type } : {}) },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload = data as any
        if (error || !payload?.ok) {
          setAiError(t('platform.onboarding.aiError'))
          return
        }
        const a = payload.agent
        setDraft((d) => ({
          ...d,
          name: a.name || d.name,
          type: keepType ? d.type : a.type || d.type,
          role: a.prompt?.role || d.role,
          prompt: {
            role: a.prompt?.role ?? d.prompt.role,
            tasks: a.prompt?.tasks ?? d.prompt.tasks,
            tone: a.prompt?.tone ?? d.prompt.tone,
            rules: a.prompt?.rules ?? d.prompt.rules,
          },
          model: a.model || d.model,
          language: (a.default_lang as PlatformAgent['language']) || d.language,
          channels: keepType ? d.channels : Array.isArray(a.channels) ? a.channels : d.channels,
        }))
      } else {
        // demo fallback (no backend): light local prefill so the flow still works
        setDraft((d) => ({ ...d, name: d.name || aiDesc.trim().split(/\s+/).slice(0, 3).join(' '), prompt: { ...d.prompt, tasks: aiDesc.trim() } }))
      }
      if (!keepType) {
        setStep(1)
        setMode('wizard')
      }
    } finally {
      setAiBusy(false)
    }
  }

  const toggleChannel = (c: ChannelType) =>
    set({ channels: draft.channels.includes(c) ? draft.channels.filter((x) => x !== c) : [...draft.channels, c] })

  const finish = async () => {
    setSaving(true)
    const res = await addAgent({ ...draft, status: 'active', lastActivity: 'hozir' })
    if (res.error || !res.id) {
      setSaving(false)
      toast(t('platform.onboarding.createError'))
      return
    }
    if (isSupabaseEnabled && supabase && tgToken.trim() && draft.channels.includes('telegram')) {
      await supabase.functions
        .invoke('connect-telegram', { body: { bot_token: tgToken.trim(), agent_id: res.id } })
        .catch(() => {})
    }
    setSaving(false)
    toast(t('platform.onboarding.created'))
    navigate(`/app/agents/${res.id}`)
  }

  const canNext = cur === 'agent' ? draft.name.trim().length > 0 : true

  return (
    <div className="relative min-h-screen overflow-hidden bg-void">
      <div className="dot-field pointer-events-none absolute inset-0 opacity-50" />
      <div className="aurora pointer-events-none absolute inset-x-0 top-0 h-80 opacity-40" />

      <header className="relative flex items-center justify-between px-5 py-4">
        <Logo />
        <div className="flex items-center gap-3">
          <LanguageToggle />
          <button onClick={() => navigate('/app')} className="rounded-lg p-2 text-muted hover:bg-ice/[0.05]" aria-label={t('common.close')}>
            <X size={20} />
          </button>
        </div>
      </header>

      <div className="container-page relative max-w-3xl py-6">
        {mode === 'start' ? (
          <div className="animate-fadeInUp">
            <h1 className="text-2xl font-normal tracking-tight text-text sm:text-3xl">{t('platform.onboarding.chooseTitle')}</h1>
            <p className="mt-2 text-muted">{t('platform.onboarding.chooseSubtitle')}</p>
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-pill border border-ice/10 bg-ice/[0.03] px-3 py-1 text-xs text-muted">
              {t('platform.billing.perAgent')}: <span className="text-text">${AGENT_PRICE_USD}/{t('platform.billing.mo')}</span> · {t('platform.onboarding.priceTokens')}
            </p>

            {/* AI builds the agent — the built-in agent writes the prompt */}
            <div className="mt-7 gradient-ring rounded-2xl p-px">
              <div className="rounded-[15px] bg-void/80 p-5 sm:p-6">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-glow">
                    <Sparkles size={18} />
                  </span>
                  <div className="min-w-0">
                    <h2 className="font-normal text-text">{t('platform.onboarding.aiTitle')}</h2>
                    <p className="text-xs leading-snug text-muted">{t('platform.onboarding.aiSubtitle')}</p>
                  </div>
                </div>
                <textarea
                  value={aiDesc}
                  onChange={(e) => setAiDesc(e.target.value)}
                  rows={3}
                  placeholder={t('platform.onboarding.aiPlaceholder')}
                  className={`${inputCls} mt-4 resize-none`}
                />
                {aiError && <p className="mt-2 text-xs text-danger">{aiError}</p>}
                <div className="mt-3">
                  <Button onClick={() => composeWithAI()} disabled={aiBusy || aiDesc.trim().length < 8}>
                    <Sparkles size={16} /> {aiBusy ? t('platform.onboarding.aiGenerating') : t('platform.onboarding.aiGenerate')}
                  </Button>
                </div>
              </div>
            </div>

            {/* choose a type manually */}
            <div className="mt-7 mb-1 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-ice/10" />
              {t('platform.onboarding.orType')}
              <span className="h-px flex-1 bg-ice/10" />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {AGENT_KINDS.map((k) => {
                const meta = agentTypeMeta[k]
                return (
                  <button key={k} onClick={() => chooseType(k)} className="card group rounded-2xl p-5 text-left transition-colors hover:border-ice/30">
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: `${meta.color}1f`, color: meta.color }}>
                      <meta.Icon size={20} />
                    </span>
                    <p className="mt-4 font-normal text-text group-hover:text-cobalt">{t(meta.key)}</p>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(`platform.agentTypes.${k}Desc`)}</p>
                  </button>
                )
              })}
            </div>

            {/* ready-made templates (secondary) */}
            <div className="mt-7 mb-1 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-ice/10" />
              {t('platform.onboarding.templatesTitle')}
              <span className="h-px flex-1 bg-ice/10" />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => pickTemplate(tpl.id)}
                  className="rounded-xl border border-ice/10 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-ice/30 hover:text-text"
                >
                  {tpl.name[lang]}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="animate-fadeInUp">
            <Stepper steps={stepLabels} current={step} />

            <div className="mt-8">
              {cur === 'agent' && (
                <Section title={t('platform.onboarding.s1Title')}>
                  <Field label={t('platform.onboarding.name')}>
                    <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder={t('platform.onboarding.namePh')} autoFocus />
                  </Field>
                  <Field label={t('platform.agentTypes.pickTitle')}>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {AGENT_KINDS.map((k) => {
                        const meta = agentTypeMeta[k]
                        const on = draft.type === k
                        return (
                          <button
                            key={k}
                            type="button"
                            onClick={() => chooseType(k)}
                            className={cn('rounded-xl border p-3 text-left transition', on ? 'border-violet/60 bg-violet/10' : 'border-ice/10 hover:border-ice/25')}
                          >
                            <span className="flex items-center gap-1.5 text-sm font-normal text-text">
                              <meta.Icon size={15} style={{ color: meta.color }} /> {t(meta.key)}
                              {on && <Check size={14} className="ml-auto text-violet" />}
                            </span>
                            <p className="mt-1 text-[11px] leading-snug text-muted">{t(`platform.agentTypes.${k}Desc`)}</p>
                          </button>
                        )
                      })}
                    </div>
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TimezoneField value={draft.timezone} onChange={(v) => set({ timezone: v })} />
                    <LanguageField value={draft.language} onChange={(v) => set({ language: v as PlatformAgent['language'] })} />
                  </div>
                  <Field label={t('platform.onboarding.schedule')}>
                    <div className="flex gap-2">
                      {(['24/7', 'work-hours'] as const).map((s) => (
                        <button key={s} onClick={() => set({ schedule: s })} className={cn('rounded-xl border px-4 py-2 text-sm font-medium transition', draft.schedule === s ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}>
                          {s === '24/7' ? t('platform.onboarding.schedule247') : t('platform.onboarding.scheduleWork')}
                        </button>
                      ))}
                    </div>
                    {draft.schedule === 'work-hours' && (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <input type="time" value={draft.workStart ?? '09:00'} onChange={(e) => set({ workStart: e.target.value })} className="glass rounded-xl px-3 py-2 text-sm text-text outline-none focus:border-violet/50" />
                        <span className="text-muted">—</span>
                        <input type="time" value={draft.workEnd ?? '18:00'} onChange={(e) => set({ workEnd: e.target.value })} className="glass rounded-xl px-3 py-2 text-sm text-text outline-none focus:border-violet/50" />
                        <span className="text-[11px] text-muted">{t('platform.onboarding.workHoursHint')}</span>
                      </div>
                    )}
                  </Field>
                  <Field label={t('platform.onboarding.model')}>
                    <ModelChips value={draft.model} onChange={(id) => set({ model: id })} />
                    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted"><Cpu size={13} /> {t('platform.onboarding.modelHint')}</p>
                  </Field>

                  <div className="border-t border-ice/10 pt-4">
                    <button type="button" onClick={() => setShowDetails((v) => !v)} className="flex w-full items-center justify-between text-xs font-normal text-muted">
                      <span className="flex items-center gap-1.5"><SlidersHorizontal size={13} /> {t('platform.onboarding.details')} · {t('common.optional')}</span>
                      <ChevronDown size={15} className={cn('transition-transform', showDetails && 'rotate-180')} />
                    </button>
                    {showDetails && (
                      <div className="mt-3 space-y-4">
                        <p className="text-[11px] text-muted">{t('platform.onboarding.detailsHint')}</p>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field label={t('platform.onboarding.country')}>
                            <input list="nemo-countries" value={draft.country ?? ''} onChange={(e) => set({ country: e.target.value })} className={inputCls} placeholder={t('platform.onboarding.countryPh')} />
                          </Field>
                          <Field label={t('platform.onboarding.niche')}>
                            <input list="nemo-niches" value={draft.niche ?? ''} onChange={(e) => set({ niche: e.target.value })} className={inputCls} placeholder={t('platform.onboarding.nichePh')} />
                          </Field>
                        </div>
                        <Field label={t('platform.onboarding.purpose')}>
                          <input value={draft.purpose ?? ''} onChange={(e) => set({ purpose: e.target.value })} className={inputCls} placeholder={t('platform.onboarding.purposePh')} />
                        </Field>
                        <datalist id="nemo-countries">{COUNTRIES.map((c) => <option key={c} value={c} />)}</datalist>
                        <datalist id="nemo-niches">{NICHES.map((c) => <option key={c} value={c} />)}</datalist>
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {cur === 'prompt' && (
                <Section title={t('platform.onboarding.s2Title')}>
                  {/* the built-in agent writes the prompt */}
                  <div className="rounded-2xl border border-violet/25 bg-violet/[0.05] p-4">
                    <p className="flex items-center gap-1.5 text-xs font-normal text-text"><Sparkles size={14} className="text-violet" /> {t('platform.onboarding.aiWriteHint')}</p>
                    <textarea
                      value={aiDesc}
                      onChange={(e) => setAiDesc(e.target.value)}
                      rows={2}
                      placeholder={t('platform.onboarding.describePh')}
                      className={`${inputCls} mt-3 resize-none`}
                    />
                    {aiError && <p className="mt-2 text-xs text-danger">{aiError}</p>}
                    <div className="mt-3">
                      <Button size="sm" onClick={() => composeWithAI({ keepType: true })} disabled={aiBusy || aiDesc.trim().length < 8}>
                        <Sparkles size={15} /> {aiBusy ? t('platform.onboarding.aiWriting') : t('platform.onboarding.aiWrite')}
                      </Button>
                    </div>
                  </div>

                  <Field label={t('platform.onboarding.role')}>
                    <textarea value={draft.prompt.role} onChange={(e) => setPrompt({ role: e.target.value })} rows={2} className={inputCls} placeholder={t('platform.onboarding.rolePh')} />
                  </Field>
                  <Field label={t('platform.onboarding.tasks')}>
                    <textarea value={draft.prompt.tasks} onChange={(e) => setPrompt({ tasks: e.target.value })} rows={3} className={inputCls} placeholder={t('platform.onboarding.tasksPh')} />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t('platform.onboarding.tone')}>
                      <textarea value={draft.prompt.tone} onChange={(e) => setPrompt({ tone: e.target.value })} rows={2} className={inputCls} placeholder={t('platform.onboarding.tonePh')} />
                    </Field>
                    <Field label={t('platform.onboarding.rules')}>
                      <textarea value={draft.prompt.rules} onChange={(e) => setPrompt({ rules: e.target.value })} rows={2} className={inputCls} placeholder={t('platform.onboarding.rulesPh')} />
                    </Field>
                  </div>
                  <p className="flex items-center gap-2 text-xs text-muted"><HelpCircle size={14} /> {t('platform.onboarding.hint')}</p>

                  <div className="space-y-2 border-t border-ice/10 pt-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-normal text-muted">{t('platform.editor.knowledgeTitle')} · {t('common.optional')}</span>
                      <button type="button" onClick={addKnowledge} className="inline-flex items-center gap-1.5 rounded-lg border border-ice/15 px-2.5 py-1.5 text-xs font-medium text-text transition-colors hover:border-ice/30">
                        <Plus size={14} /> {t('platform.editor.knowledgeAdd')}
                      </button>
                    </div>
                    {draft.knowledge.length > 0 && (
                      <ul className="space-y-2">
                        {draft.knowledge.map((k) => (
                          <li key={k.id} className="flex items-center gap-3 rounded-xl border border-ice/[0.07] bg-ice/[0.02] px-3 py-2.5">
                            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ice/[0.06] text-muted"><FileText size={15} /></span>
                            <span className="min-w-0 flex-1 truncate text-sm text-text">{k.name}</span>
                            <span className="rounded-full bg-teal/15 px-2 py-0.5 text-[10px] font-normal text-teal">{t('platform.editor.indexed')}</span>
                            <button type="button" onClick={() => set({ knowledge: draft.knowledge.filter((x) => x.id !== k.id) })} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06] hover:text-danger">
                              <Trash2 size={15} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Section>
              )}

              {cur === 'channels' && (
                <Section title={t('platform.onboarding.s3Title')} subtitle={t('platform.onboarding.s3Subtitle')}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(Object.keys(channelMeta) as ChannelType[]).map((c) => {
                      const meta = channelMeta[c]
                      const on = draft.channels.includes(c)
                      return (
                        <button
                          key={c}
                          type="button"
                          disabled={meta.soon}
                          onClick={() => !meta.soon && toggleChannel(c)}
                          className={cn('flex items-center gap-3 rounded-xl border p-4 text-left transition', on ? 'border-violet/50 bg-violet/10' : 'border-ice/10 hover:border-ice/25', meta.soon && 'cursor-not-allowed opacity-50')}
                        >
                          <span className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: `${meta.color}22`, color: meta.color }}>
                            <meta.Icon size={18} />
                          </span>
                          <span className="flex-1 text-sm font-normal text-text">{channelLabel(c, t)}</span>
                          {meta.soon ? <span className="text-[10px] text-muted">{t('platform.agentTypes.soon')}</span> : on && <Check size={18} className="text-violet" />}
                        </button>
                      )
                    })}
                  </div>
                  {draft.channels.includes('telegram') && (
                    <div className="mt-4 border-t border-ice/10 pt-4">
                      <Field label={t('platform.integrations.fields.tgToken')}>
                        <input value={tgToken} onChange={(e) => setTgToken(e.target.value)} placeholder="123456789:AAH..." className={inputCls} autoComplete="off" />
                      </Field>
                      <p className="mt-1.5 text-[11px] text-muted">{t('platform.onboarding.tgTokenHint')}</p>
                    </div>
                  )}
                </Section>
              )}

              {cur === 'test' && (
                <Section title={t('platform.onboarding.s4Title')} subtitle={t('platform.onboarding.s4Subtitle')}>
                  <TestChat agent={draft} />
                  <p className="text-center text-xs text-muted">{t('platform.onboarding.playgroundHint')}</p>
                </Section>
              )}
            </div>

            {/* nav */}
            <div className="mt-7 flex items-center justify-between">
              <Button variant="ghost" onClick={() => (step === 1 ? setMode('start') : setStep(step - 1))}>
                <ArrowLeft size={16} /> {t('platform.onboarding.back')}
              </Button>
              {step < lastStep ? (
                <Button onClick={() => setStep(step + 1)} disabled={!canNext}>
                  {t('platform.onboarding.next')} <ArrowRight size={16} />
                </Button>
              ) : (
                <Button onClick={finish} disabled={saving || !canNext}>
                  <Rocket size={16} /> {saving ? '…' : t('platform.onboarding.finish')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// compact model selector (grouped by company) for the creation wizard
function ModelChips({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="space-y-3">
      {PROVIDERS.map((p) => (
        <div key={p.id}>
          <p className="mb-1.5 text-[11px] font-medium text-muted">{p.name}</p>
          <div className="flex flex-wrap gap-2">
            {p.models.map((m) => {
              const on = value === m.id
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChange(m.id)}
                  className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs transition', on ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}
                >
                  {on && <Check size={13} className="text-violet" />}
                  {m.label}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="card rounded-2xl p-6">
      <h2 className="text-lg font-normal text-text">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      <div className="mt-5 space-y-5">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-normal text-muted">{label}</span>
      {children}
    </label>
  )
}
