import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { X, ArrowLeft, ArrowRight, Check, Rocket, HelpCircle, FileText, Trash2, Sparkles, Cpu, SlidersHorizontal, ChevronDown, Upload, Loader2, Volume2, KeyRound, Lock } from 'lucide-react'
import { useI18n } from '../i18n'
import { useAgentStore, blankAgent } from '../store/useAgentStore'
import { useToast } from '../components/ui/Toast'
import { supabase, isSupabaseEnabled } from '../lib/supabase'
import { templates, PROVIDERS, kindPresets, COUNTRIES, NICHES, VOICES } from '../data/platform'
import { AGENT_PRICE_USD } from '../data/billing'
import { channelMeta, channelLabel, agentTypeMeta, AGENT_KINDS } from '../lib/platformMeta'
import { extractText, KNOWLEDGE_ACCEPT } from '../lib/extractText'
import { Logo } from '../components/ui/Logo'
import { Button } from '../components/ui/Button'
import { LanguageToggle } from '../components/ui/LanguageToggle'
import { Stepper } from '../components/ui/Stepper'
import { TestChat } from '../components/platform/TestChat'
import { TimezoneField, LanguageField } from '../components/platform/TimezoneField'
import { cn } from '../lib/cn'
import { recommendFirstTeam, type FirstTeamRecommendation, type OnboardingBusinessProfile } from '../lib/firstTeamRecommendation'
import { saveDynamicTeam } from '../lib/dynamicTeams'
import type { ChannelType, PlatformAgent, KnowledgeDoc, AgentKind, AgentPrompt } from '../types/platform'

const inputCls = 'glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-cobalt/50 focus:shadow-glow'

const defaultLeadFields = [
  { id: 'lead_name', label: 'Имя', type: 'text' as const, required: true },
  { id: 'lead_phone', label: 'Телефон', type: 'phone' as const, required: true },
  { id: 'lead_location', label: 'Где живёте / город', type: 'text' as const, required: false },
  { id: 'lead_reason', label: 'Причина обращения', type: 'text' as const, required: true },
  { id: 'lead_interactions', label: 'Сколько раз уже обращались', type: 'text' as const, required: false },
  { id: 'lead_interest', label: 'Интересующий продукт / курс / услуга', type: 'text' as const, required: true },
]

const channelSetup: Partial<Record<ChannelType, { key: string; label: string; placeholder: string; hint?: string }[]>> = {
  telegram: [{ key: 'bot_token', label: 'Telegram bot token', placeholder: '123456789:AAH...', hint: 'Можно пропустить и подключить токен позже в настройках агента.' }],
  instagram: [
    { key: 'account', label: 'Instagram account / page', placeholder: '@brand или Page ID' },
    { key: 'page_token', label: 'Meta Page Access Token', placeholder: 'EAAG...', hint: 'Если токена пока нет, оставьте пустым и подключите позже.' },
  ],
  whatsapp: [
    { key: 'phone_number_id', label: 'WhatsApp phone number ID', placeholder: '102938475610293' },
    { key: 'token', label: 'WhatsApp / Meta token', placeholder: 'EAAG...' },
  ],
  widget: [
    { key: 'site', label: 'Website URL', placeholder: 'https://example.com' },
    { key: 'brand_color', label: 'Widget accent color', placeholder: '#8B7CF8' },
  ],
}

const formatFileSize = (size: number) => {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const byoProviders = [
  {
    id: 'openrouter-free',
    name: 'Free models',
    desc: 'No API key now. Good for demo and pre-investment testing.',
    models: PROVIDERS.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.name }))),
  },
  {
    id: 'openai',
    name: 'OpenAI',
    desc: 'Customer-owned key. We store it encrypted and never show it back.',
    models: [
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', provider: 'OpenAI' },
      { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini', provider: 'OpenAI' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    desc: 'Customer-owned Claude key. Encrypted vault storage.',
    models: [
      { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku', provider: 'Anthropic' },
      { id: 'anthropic/claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', provider: 'Anthropic' },
    ],
  },
  {
    id: 'google',
    name: 'Google AI',
    desc: 'Customer-owned Gemini key. Encrypted vault storage.',
    models: [
      { id: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash', provider: 'Google' },
      { id: 'google/gemini-1.5-pro', label: 'Gemini 1.5 Pro', provider: 'Google' },
    ],
  },
]

const TEAM_BLUEPRINTS = [
  {
    title: 'AI Sales Team',
    desc: 'Квалифицирует лидов, отвечает на вопросы, закрывает заявки и передаёт горячих клиентов оператору/CRM.',
    prompt: 'У меня малый бизнес. Нужна AI-команда продаж: главный агент, квалификатор лидов, консультант по продукту, агент возражений и CRM handoff. Команда должна отвечать в мессенджерах, собирать телефон, бюджет и потребность, затем передавать горячих лидов оператору.',
  },
  {
    title: 'AI Support Team',
    desc: 'Закрывает частые вопросы, ищет ответы в базе знаний и передаёт сложные случаи человеку.',
    prompt: 'Нужна AI-команда поддержки: главный агент, FAQ-специалист, агент базы знаний, агент диагностики проблемы и агент эскалации оператору. Команда должна отвечать клиентам 24/7 и снижать нагрузку на поддержку.',
  },
  {
    title: 'AI Content Team',
    desc: 'Генерирует идеи, сценарии, посты, календарь публикаций и анализирует результат.',
    prompt: 'Нужна AI-команда для контента: главный контент-агент, идеолог, сценарист, копирайтер, публикатор и аналитик. Команда должна создавать контент-план, Reels-сценарии, посты и рекомендации по улучшению.',
  },
]

export default function OnboardingPage() {
  const { t, lang, dict } = useI18n()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const toast = useToast()
  const addAgent = useAgentStore((s) => s.addAgent)
  const ensureAccountId = useAgentStore((s) => s.ensureAccountId)

  const [mode, setMode] = useState<'start' | 'wizard'>('start')
  const [step, setStep] = useState(1)
  const [draft, setDraft] = useState<PlatformAgent>(blankAgent())
  const [saving, setSaving] = useState(false)
  const [aiDesc, setAiDesc] = useState(() => {
    const team = params.get('team')
    return team ? `Create ${team} for a small business. Include a master agent, specialist sub-agents, channels, company brain, quality checks and CRM handoff.` : ''
  })
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [tgToken, setTgToken] = useState('')
  const [channelSettings, setChannelSettings] = useState<Partial<Record<ChannelType, Record<string, string>>>>({})
  const [uploadingKnowledge, setUploadingKnowledge] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [recommendation, setRecommendation] = useState<FirstTeamRecommendation | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase || params.get('team')) return
    const client = supabase
    let cancelled = false
    void ensureAccountId().then(async (accountId) => {
      if (!accountId || accountId === 'demo') return
      const { data } = await client
        .from('business_profiles')
        .select('name, operating_markets, owner_role, primary_goal, task_types, data_sources, default_action_policy')
        .eq('account_id', accountId)
        .maybeSingle()
      if (cancelled || !data) return
      const next = recommendFirstTeam(data as OnboardingBusinessProfile)
      setRecommendation(next)
      setAiDesc((current) => current.trim() ? current : next.description)
      setDraft((current) => ({
        ...current,
        name: current.name || next.title,
        purpose: current.purpose || next.purpose,
        niche: current.niche || next.niche,
        country: current.country || next.country,
        channels: current.channels.length ? current.channels : next.channels,
        actionPolicy: next.actionPolicy,
      }))
    })
    return () => { cancelled = true }
  }, [ensureAccountId, params])

  const set = (patch: Partial<PlatformAgent>) => setDraft((d) => ({ ...d, ...patch }))
  const setPrompt = (patch: Partial<PlatformAgent['prompt']>) => setDraft((d) => ({ ...d, prompt: { ...d.prompt, ...patch } }))

  // dynamic wizard steps — technical agents can skip customer channels; AI teams still need deploy channels.
  const isRunner = draft.type === 'research' || draft.type === 'coder'
  const stepKeys: ('agent' | 'prompt' | 'channels' | 'test')[] = isRunner ? ['agent', 'prompt'] : ['agent', 'prompt', 'channels', 'test']
  const stepLabels = isRunner ? dict.platform.onboarding.steps.slice(0, 2) : dict.platform.onboarding.steps
  const cur = stepKeys[step - 1]
  const lastStep = stepKeys.length

  const addKnowledgeFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setUploadingKnowledge(true)
    try {
      const next: KnowledgeDoc[] = []
      for (const file of Array.from(files)) {
        try {
          await extractText(file)
          next.push({ id: `k${Date.now()}_${file.name}`, name: file.name, source: 'file', status: 'indexed', size: formatFileSize(file.size) })
        } catch {
          next.push({ id: `k${Date.now()}_${file.name}`, name: file.name, source: 'file', status: 'error', size: formatFileSize(file.size) })
        }
      }
      set({ knowledge: [...draft.knowledge, ...next] })
    } finally {
      setUploadingKnowledge(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const expandLeadForm = (enabled = true) =>
    set(({
      leadForm: {
        ...draft.leadForm,
        enabled,
        fields: defaultLeadFields,
        trigger: 'когда клиент проявил интерес, спросил цену, курс, товар, услугу или попросил консультацию',
      },
    }))

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
          leadForm: k === 'qualifier' ? { ...d.leadForm, enabled: true, fields: defaultLeadFields } : d.leadForm,
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
          name: a.name || recommendation?.title || d.name,
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
          channels: keepType ? d.channels : recommendation ? recommendation.channels : Array.isArray(a.channels) ? a.channels : d.channels,
          actionPolicy: recommendation?.actionPolicy ?? d.actionPolicy,
          country: recommendation?.country ?? d.country,
          purpose: recommendation?.purpose ?? d.purpose,
          niche: recommendation?.niche ?? d.niche,
        }))
      } else {
        const text = aiDesc.trim()
        const lower = text.toLowerCase()
        const isContent = /content|контент|post|reels|script/.test(lower)
        const isSupport = /support|поддерж|faq|help/.test(lower)
        const isSales = /sales|sale|lead|crm|продаж|лид/.test(lower)
        const name = recommendation?.title ?? (isContent ? 'AI Content Team' : isSupport ? 'AI Support Team' : isSales ? 'AI Sales Team' : 'Custom AI Team')
        const specialists = isContent
          ? 'Sub-agents: strategist, scriptwriter, copywriter, publishing agent, analyst.'
          : isSupport
            ? 'Sub-agents: FAQ specialist, knowledge agent, troubleshooting agent, escalation agent.'
            : 'Sub-agents: lead qualifier, product expert, objection handler, CRM handoff agent.'
        setDraft((d) => ({
          ...d,
          name,
          type: 'workflow',
          role: 'Master AI team leader',
          purpose: recommendation?.purpose ?? text,
          niche: recommendation?.niche ?? (isContent ? 'Content / Marketing' : isSupport ? 'Customer Support' : 'Sales / SMB'),
          country: recommendation?.country ?? d.country,
          actionPolicy: recommendation?.actionPolicy ?? d.actionPolicy,
          prompt: {
            role: 'You are the master agent for an AI team. Understand the business goal, route work to specialist sub-agents, synthesize results and escalate to a human when needed.',
            tasks: `${text}\n\n${specialists}\nUse Company Brain, keep an Agent Trace, capture measurable outcomes and calculate Nemo Score.`,
            tone: 'Professional, concise, business-focused, trustworthy.',
            rules: 'Do not act as a single chatbot. Always decompose complex goals, delegate to sub-agents, verify quality and explain the result clearly.',
          },
          leadForm: { ...d.leadForm, enabled: isSales || isSupport, fields: isSales || isSupport ? defaultLeadFields : d.leadForm.fields },
          channels: recommendation ? recommendation.channels : ['telegram', 'widget'],
        }))
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

  const updateChannelSetting = (channel: ChannelType, key: string, value: string) => {
    setChannelSettings((prev) => ({
      ...prev,
      [channel]: { ...(prev[channel] ?? {}), [key]: value },
    }))
    if (channel === 'telegram' && key === 'bot_token') setTgToken(value)
  }

  const previewVoice = (voiceId: string) => {
    if (!('speechSynthesis' in window)) {
      toast('Voice preview is not supported in this browser')
      return
    }
    window.speechSynthesis.cancel()
    const sample = new SpeechSynthesisUtterance('Hello, I am your Nemo AI assistant. I can answer customers and qualify leads.')
    sample.lang = draft.language === 'ru' ? 'ru-RU' : draft.language === 'uz' ? 'uz-UZ' : 'en-US'
    sample.pitch = voiceId === 'nova' || voiceId === 'aria' ? 1.15 : voiceId === 'ember' ? 0.85 : 1
    sample.rate = voiceId === 'sage' ? 0.9 : 1
    window.speechSynthesis.speak(sample)
  }

  const finish = async () => {
    setSaving(true)
    let res: { id?: string; error?: string }
    if (draft.type === 'workflow' && isSupabaseEnabled && supabase) {
      const goal = (draft.purpose || aiDesc || draft.prompt.tasks).trim()
      const { data, error } = await supabase.functions.invoke('orchestrate', {
        body: { action: 'staff', goal, niche: draft.niche, purpose: draft.purpose, lang },
      })
      const specialists = (data as { subagents?: { role: string; name: string; skills?: string[]; prompt: AgentPrompt }[] } | null)?.subagents ?? []
      if (error || specialists.length < 2) {
        setSaving(false)
        toast('Не удалось спроектировать полный состав команды. Попробуйте ещё раз.')
        return
      }
      const team = await saveDynamicTeam(addAgent, {
        name: draft.name,
        goal,
        specialists,
        niche: draft.niche,
        riskTier: draft.riskTier,
        actionPolicy: draft.actionPolicy,
        country: draft.country,
        lead: { role: draft.role, prompt: draft.prompt, model: draft.model },
        leadForm: draft.leadForm,
      })
      res = { id: team.agentId, error: team.error }
    } else {
      res = await addAgent({ ...draft, status: 'draft', lastActivity: 'hozir' })
    }
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
    navigate(draft.type === 'workflow' ? `/app/teams/${res.id}` : `/app/agents/${res.id}`)
  }

  const canNext = cur === 'agent' ? draft.name.trim().length > 0 : true

  return (
    <div className="relative min-h-screen overflow-hidden bg-void">
      <div className="dot-field pointer-events-none absolute inset-0 opacity-50" />
      <div className="aurora pointer-events-none absolute inset-x-0 top-0 h-80 opacity-40" />

      <header className="sticky top-0 z-50 flex items-center justify-between border-b border-ice/10 bg-void/80 px-5 py-4 backdrop-blur-xl">
        <Logo />
        <div className="flex items-center gap-3">
          <LanguageToggle showLabel />
          <button onClick={() => navigate('/app')} className="rounded-lg p-2 text-muted hover:bg-ice/[0.05]" aria-label={t('common.close')}>
            <X size={20} />
          </button>
        </div>
      </header>

      <div className="container-page relative max-w-3xl py-6">
        {mode === 'start' ? (
          <div className="animate-fadeInUp">
            <h1 className="text-2xl font-normal tracking-tight text-text sm:text-3xl">{t('onboardingPage.startTitle')}</h1>
            <p className="mt-2 text-muted">{t('onboardingPage.startSubtitle')}</p>
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-pill border border-ice/10 bg-ice/[0.03] px-3 py-1 text-xs text-muted">
              {t('platform.billing.perAgent')}: <span className="text-text">${AGENT_PRICE_USD}/{t('platform.billing.mo')}</span> · {t('platform.onboarding.priceTokens')}
            </p>

            {recommendation && (
              <div className="mt-7 rounded-2xl border border-cyan/30 bg-cyan/[0.06] p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-cyan">Рекомендация по вашему onboarding</p>
                <h2 className="mt-2 text-lg font-medium text-text">{recommendation.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">Цель и состав команды уже подготовлены. Политика: {recommendation.actionPolicy === 'read_only' ? 'Read-only' : 'Draft + owner approval'}. Каналы: {recommendation.channels.length ? recommendation.channels.join(', ') : 'подключить позже'}.</p>
                <button type="button" onClick={() => setAiDesc(recommendation.description)} className="mt-3 text-sm font-medium text-cyan hover:text-text">Вернуть рекомендованный blueprint</button>
              </div>
            )}

            <div className="mt-7 grid gap-3 sm:grid-cols-3">
              {TEAM_BLUEPRINTS.map((item) => (
                <button
                  key={item.title}
                  type="button"
                  onClick={() => setAiDesc(item.prompt)}
                  className="card rounded-2xl p-4 text-left transition hover:border-violet/40 hover:bg-white/[0.06]"
                >
                  <p className="font-medium text-text">{item.title}</p>
                  <p className="mt-2 text-xs leading-relaxed text-muted">{item.desc}</p>
                </button>
              ))}
            </div>

            {/* AI builds the team — the built-in agent writes the first blueprint */}
            <div className="mt-7 gradient-ring rounded-2xl p-px">
              <div className="rounded-[15px] bg-void/80 p-5 sm:p-6">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-glow">
                    <Sparkles size={18} />
                  </span>
                  <div className="min-w-0">
                    <h2 className="font-normal text-text">{t('onboardingPage.architectTitle')}</h2>
                    <p className="text-xs leading-snug text-muted">{t('onboardingPage.architectExample')}</p>
                  </div>
                </div>
                <textarea
                  value={aiDesc}
                  onChange={(e) => setAiDesc(e.target.value)}
                  rows={7}
                  placeholder={t('onboardingPage.aiDescPh')}
                  className={`${inputCls} mt-4 min-h-44 resize-y leading-relaxed`}
                />
                {aiError && <p className="mt-2 text-xs text-danger">{aiError}</p>}
                <div className="mt-3">
                  <Button onClick={() => composeWithAI()} disabled={aiBusy || aiDesc.trim().length < 8}>
                    <Sparkles size={16} /> {aiBusy ? t('onboardingPage.designing') : t('onboardingPage.buildTeam')}
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
                        <datalist id="nemo-countries">{COUNTRIES[lang].map((c) => <option key={c} value={c} />)}</datalist>
                        <datalist id="nemo-niches">{NICHES[lang].map((c) => <option key={c} value={c} />)}</datalist>
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
                      rows={6}
                      placeholder={t('platform.onboarding.describePh')}
                      className={`${inputCls} mt-3 min-h-36 resize-y leading-relaxed`}
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

                  <Field label="Action policy">
                    <select value={draft.actionPolicy ?? 'approval_required'} onChange={(e) => set({ actionPolicy: e.target.value === 'read_only' ? 'read_only' : 'approval_required' })} className={inputCls}>
                      <option value="read_only">Read-only: analyze without external changes</option>
                      <option value="approval_required">Draft + owner approval: queue external changes</option>
                    </select>
                    <p className="mt-2 text-[11px] text-muted">Automatic execution is unavailable. You can review this recommendation before creating the team.</p>
                  </Field>

                  <div className="space-y-2 border-t border-ice/10 pt-4">
                    <input ref={fileRef} type="file" accept={KNOWLEDGE_ACCEPT} multiple className="hidden" onChange={(e) => addKnowledgeFiles(e.target.files)} />
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-normal text-muted">{t('platform.editor.knowledgeTitle')} · {t('common.optional')}</span>
                      <button type="button" onClick={() => fileRef.current?.click()} disabled={uploadingKnowledge} className="inline-flex items-center gap-1.5 rounded-lg border border-ice/15 px-2.5 py-1.5 text-xs font-medium text-text transition-colors hover:border-ice/30 disabled:cursor-not-allowed disabled:opacity-60">
                        {uploadingKnowledge ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {uploadingKnowledge ? t('platform.knowledge.indexing') : t('platform.knowledge.uploadFile')}
                      </button>
                    </div>
                    <p className="text-[11px] leading-snug text-muted">{t('onboardingPage.knowledgeUploadHint')}</p>
                    {draft.knowledge.length > 0 && (
                      <ul className="space-y-2">
                        {draft.knowledge.map((k) => (
                          <li key={k.id} className="flex items-center gap-3 rounded-xl border border-ice/[0.07] bg-ice/[0.02] px-3 py-2.5">
                            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ice/[0.06] text-muted"><FileText size={15} /></span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-text">{k.name}</span>
                              <span className="text-[11px] text-muted">{k.size}</span>
                            </span>
                            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-normal', k.status === 'error' ? 'bg-danger/15 text-danger' : 'bg-teal/15 text-teal')}>
                              {k.status === 'error' ? 'Needs retry' : t('platform.editor.indexed')}
                            </span>
                            <button type="button" onClick={() => set({ knowledge: draft.knowledge.filter((x) => x.id !== k.id) })} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06] hover:text-danger">
                              <Trash2 size={15} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="space-y-3 border-t border-ice/10 pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-normal text-muted">Voice agent · optional / paid add-on</p>
                        <p className="mt-1 text-[11px] text-muted">{t('onboardingPage.voicePreviewHint')}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => set({ voiceEnabled: !draft.voiceEnabled })}
                        className={cn('rounded-xl border px-3 py-2 text-xs font-medium transition', draft.voiceEnabled ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}
                      >
                        {draft.voiceEnabled ? 'Voice enabled' : 'Enable voice'}
                      </button>
                    </div>
                    {draft.voiceEnabled && (
                      <div className="grid gap-2 sm:grid-cols-3">
                        {VOICES.map((voice) => {
                          const on = draft.voiceId === voice.id
                          return (
                            <div key={voice.id} className={cn('rounded-xl border p-3 transition', on ? 'border-violet/60 bg-violet/10' : 'border-ice/10')}>
                              <button type="button" onClick={() => set({ voiceId: voice.id })} className="flex w-full items-center justify-between text-left text-sm font-normal text-text">
                                {voice.label}
                                {on && <Check size={14} className="text-violet" />}
                              </button>
                              <button type="button" onClick={() => previewVoice(voice.id)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-ice/12 px-2 py-1 text-[11px] text-muted hover:text-text">
                                <Volume2 size={13} /> Preview
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 border-t border-ice/10 pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-normal text-muted">Lead form · sales/support handoff</p>
                        <p className="mt-1 text-[11px] text-muted">{t('onboardingPage.leadFormHint')}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => expandLeadForm(!draft.leadForm.enabled)}
                        className={cn('rounded-xl border px-3 py-2 text-xs font-medium transition', draft.leadForm.enabled ? 'border-teal/50 bg-teal/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}
                      >
                        {draft.leadForm.enabled ? 'Lead form enabled' : 'Enable lead form'}
                      </button>
                    </div>
                    {draft.leadForm.enabled && (
                      <div className="space-y-3 rounded-xl border border-ice/10 bg-ice/[0.02] p-3">
                        <Field label="When to collect lead data">
                          <input value={draft.leadForm.trigger} onChange={(e) => set({ leadForm: { ...draft.leadForm, trigger: e.target.value } })} className={inputCls} />
                        </Field>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {draft.leadForm.fields.map((field) => (
                            <div key={field.id} className="rounded-lg border border-ice/10 px-3 py-2">
                              <p className="text-sm text-text">{field.label}</p>
                              <p className="mt-0.5 text-[11px] text-muted">{field.required ? 'Required' : 'Optional'} · {field.type}</p>
                            </div>
                          ))}
                        </div>
                      </div>
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
                    <p className="mt-3 rounded-xl border border-cyan/20 bg-cyan/[0.05] p-3 text-xs leading-relaxed text-muted">{t('platform.onboarding.tgTokenHint')}</p>
                  )}
                  {draft.channels.length > 0 && (
                    <div className="mt-4 space-y-4 border-t border-ice/10 pt-4">
                      {draft.channels.map((channel) => {
                        const fields = channelSetup[channel] ?? []
                        const meta = channelMeta[channel]
                        return (
                          <div key={channel} className="rounded-2xl border border-ice/10 bg-ice/[0.02] p-4">
                            <div className="flex items-center gap-2">
                              <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: `${meta.color}22`, color: meta.color }}>
                                <meta.Icon size={15} />
                              </span>
                              <div>
                                <p className="text-sm font-normal text-text">{channelLabel(channel, t)} setup</p>
                                <p className="text-[11px] text-muted">Optional now. You can finish connection later in agent settings.</p>
                              </div>
                            </div>
                            {channel === 'widget' && (
                              <div className="mt-3 rounded-xl border border-ice/10 bg-black/20 p-3">
                                <p className="text-[11px] text-muted">Website widget snippet after creation:</p>
                                <code className="mt-1 block break-all text-[11px] text-cyan">&lt;script src=&quot;https://cdn.nemo.ai/widget.js&quot; data-agent=&quot;{draft.id}&quot; async&gt;&lt;/script&gt;</code>
                              </div>
                            )}
                            {fields.length > 0 && (
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                {fields.map((field) => (
                                  <Field key={field.key} label={field.label}>
                                    <input
                                      value={channelSettings[channel]?.[field.key] ?? ''}
                                      onChange={(e) => updateChannelSetting(channel, field.key, e.target.value)}
                                      placeholder={field.placeholder}
                                      className={inputCls}
                                      autoComplete="off"
                                    />
                                    {field.hint && <p className="mt-1 text-[11px] leading-snug text-muted">{field.hint}</p>}
                                  </Field>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
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
  const { t } = useI18n()
  const [providerId, setProviderId] = useState(() => byoProviders.find((p) => p.models.some((m) => m.id === value))?.id ?? 'openrouter-free')
  const [apiKey, setApiKey] = useState('')
  const provider = byoProviders.find((p) => p.id === providerId) ?? byoProviders[0]
  const needsKey = provider.id !== 'openrouter-free'

  const pickProvider = (id: string) => {
    const next = byoProviders.find((p) => p.id === id) ?? byoProviders[0]
    setProviderId(next.id)
    onChange(next.models[0]?.id ?? value)
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-4">
        {byoProviders.map((p) => {
          const on = providerId === p.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => pickProvider(p.id)}
              className={cn('rounded-xl border p-3 text-left transition', on ? 'border-violet/60 bg-violet/10' : 'border-ice/10 hover:border-ice/25')}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                {p.id === 'openrouter-free' ? <Cpu size={14} /> : <KeyRound size={14} />}
                {p.name}
                {on && <Check size={13} className="ml-auto text-violet" />}
              </span>
              <span className="mt-1 block text-[10px] leading-snug text-muted">{p.id === 'openrouter-free' ? 'Free' : 'BYO key'}</span>
            </button>
          )
        })}
      </div>

      <div className="rounded-2xl border border-ice/10 bg-ice/[0.02] p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-text">{provider.name}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{provider.desc}</p>
          </div>
          {needsKey && <span className="rounded-pill border border-teal/20 bg-teal/10 px-2.5 py-1 text-[10px] font-medium text-teal">Encrypted</span>}
        </div>

        {needsKey && (
          <div className="mb-4 space-y-2">
            <label className="block space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-normal text-muted"><Lock size={13} /> API key for this agent</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={provider.id === 'openai' ? 'sk-...' : provider.id === 'anthropic' ? 'sk-ant-...' : 'AIza...'}
                className={inputCls}
                autoComplete="off"
              />
            </label>
            <p className="text-[11px] leading-snug text-muted">
              {t('onboardingPage.byoKeyNote')}
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {provider.models.map((m) => {
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
