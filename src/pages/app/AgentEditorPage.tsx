import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Save,
  Settings,
  MessageSquareText,
  BookOpen,
  Cpu,
  ClipboardList,
  Plug,
  FlaskConical,
  Telescope,
  Plus,
  Trash2,
  HelpCircle,
  SlidersHorizontal,
  ChevronDown,
  Users,
  Mic,
  Check,
  FileText,
  User,
  Sparkles,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { AGENT_SKILLS, MAX_AGENT_SKILLS } from '../../data/agentSkills'
import { useAgentStore } from '../../store/useAgentStore'
import { useToast } from '../../components/ui/Toast'
import { MODELS, COUNTRIES, NICHES, VOICES } from '../../data/platform'
import { Tabs, type TabDef } from '../../components/ui/Tabs'
import { Button } from '../../components/ui/Button'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { TestChat } from '../../components/platform/TestChat'
import { TimezoneField, LanguageField } from '../../components/platform/TimezoneField'
import { ModelPicker } from '../../components/platform/ModelPicker'
import { ChannelsManager } from '../../components/platform/ChannelsManager'
import { KnowledgeManager } from '../../components/platform/KnowledgeManager'
import { AgentGrowth } from '../../components/platform/AgentGrowth'
import { ResearchRunner } from '../../components/platform/ResearchRunner'
import { OrchestratorRunner } from '../../components/platform/OrchestratorRunner'
import { DepartmentPanel } from '../../components/platform/DepartmentPanel'
import { FileRunner } from '../../components/platform/FileRunner'
import { AgentAvatar } from '../../components/ui/AgentAvatar'
import { SkillFileImporter } from '../../components/platform/SkillFileImporter'
import { cn } from '../../lib/cn'
import type { PlatformAgent } from '../../types/platform'

export default function AgentEditorPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { t, lang } = useI18n()
  const toast = useToast()
  const agent = useAgentStore((s) => s.agents.find((a) => a.id === id))
  const hydrated = useAgentStore((s) => s.hydrated)
  const updateAgent = useAgentStore((s) => s.updateAgent)

  const [draft, setDraft] = useState<PlatformAgent | undefined>(agent)
  const [tab, setTab] = useState('general')
  const [leaveTo, setLeaveTo] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)

  // The agent may arrive after an async hydrate (e.g. on a hard reload straight
  // to this URL) — seed the draft once it's available instead of redirecting.
  useEffect(() => {
    if (agent && !draft) window.setTimeout(() => setDraft(agent), 0)
  }, [agent, draft])

  // Compare only the fields this editor edits; channels/knowledge are managed
  // live elsewhere and must not flag phantom "unsaved changes".
  const editable = (a: PlatformAgent) =>
    JSON.stringify({
      name: a.name,
      prompt: a.prompt,
      model: a.model,
      temperature: a.temperature,
      timezone: a.timezone,
      schedule: a.schedule,
      workStart: a.workStart ?? '',
      workEnd: a.workEnd ?? '',
      language: a.language,
      country: a.country ?? '',
      purpose: a.purpose ?? '',
      niche: a.niche ?? '',
      voiceEnabled: a.voiceEnabled ?? false,
      voiceMode: a.voiceMode ?? 'both',
      voiceId: a.voiceId ?? '',
      sttModel: a.sttModel ?? 'auto',
      personaMode: a.personaMode ?? 'business',
      ownerName: a.ownerName ?? '',
      skills: a.skills ?? [],
      leadForm: a.leadForm,
      avatarColor: a.avatarColor,
    })
  const dirty = useMemo(() => (agent && draft ? editable(agent) !== editable(draft) : false), [agent, draft])

  const loader = <div className="flex min-h-[60vh] items-center justify-center text-2xl text-muted">…</div>
  // Redirect ONLY when the store is hydrated and the agent truly doesn't exist.
  // While loading — or in the one frame after the agent appears but before the
  // draft effect seeds it — show the loader instead of bouncing to the list.
  if (!agent) {
    if (!hydrated) return loader
    return <Navigate to="/app/agents" replace />
  }
  if (!draft) return loader

  const set = (patch: Partial<PlatformAgent>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const setPrompt = (patch: Partial<PlatformAgent['prompt']>) =>
    setDraft((d) => (d ? { ...d, prompt: { ...d.prompt, ...patch } } : d))

  const save = async () => {
    if (!draft.name.trim()) { toast('Agent name is required.', 'error'); return }
    if (draft.leadForm.enabled && !draft.leadForm.trigger.trim()) { toast('Lead trigger is required when the lead form is enabled.', 'error'); return }
    if (draft.leadForm.enabled && draft.leadForm.fields.some((field) => !field.label.trim())) { toast('Every lead field needs a label.', 'error'); return }
    const { error } = await updateAgent(draft.id, draft)
    if (error) toast(error, 'error')
    else toast(t('platform.editor.saved'))
  }

  const goBack = () => {
    if (dirty) setLeaveTo('/app/agents')
    else navigate('/app/agents')
  }

  // Runner agents (research / workflow) execute a task instead of chatting on
  // channels: their editor swaps channels/lead-forms/test for a Run tab.
  const isRunner = draft.type === 'research' || draft.type === 'workflow'
  const tabs: TabDef[] = isRunner
    ? [
        { key: 'general', label: t('platform.editor.tabs.general'), icon: Settings },
        { key: 'prompt', label: t('platform.editor.tabs.prompt'), icon: MessageSquareText },
        { key: 'knowledge', label: t('platform.editor.tabs.knowledge'), icon: BookOpen },
        { key: 'model', label: t('platform.editor.tabs.model'), icon: Cpu },
        ...(draft.type === 'workflow' ? [{ key: 'department', label: t('platform.department.tab'), icon: Users }] : []),
        { key: 'run', label: t('platform.agentTypes.runTab'), icon: Telescope },
      ]
    : [
        { key: 'general', label: t('platform.editor.tabs.general'), icon: Settings },
        { key: 'prompt', label: t('platform.editor.tabs.prompt'), icon: MessageSquareText },
        { key: 'knowledge', label: t('platform.editor.tabs.knowledge'), icon: BookOpen },
        { key: 'model', label: t('platform.editor.tabs.model'), icon: Cpu },
        ...(draft.type === 'coder' || draft.type === 'content' ? [{ key: 'files', label: t('platform.files.tab'), icon: FileText }] : []),
        { key: 'leadForms', label: t('platform.editor.tabs.leadForms'), icon: ClipboardList },
        { key: 'channels', label: t('platform.editor.tabs.channels'), icon: Plug },
        { key: 'test', label: t('platform.editor.tabs.test'), icon: FlaskConical },
      ]

  return (
    <div className="container-page max-w-6xl py-8">
      {/* header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button onClick={goBack} aria-label={t('platform.editor.back')} className="rounded-lg border border-ice/10 p-2 text-muted hover:bg-ice/[0.05]">
            <ArrowLeft size={18} />
          </button>
          <AgentAvatar color={draft.avatarColor} glyph="search" size="md" />
          <div>
            <h1 className="text-lg font-normal tracking-tight text-text">{draft.name || t('platform.agents.create')}</h1>
            <p className="text-xs text-muted">{MODELS.find((m) => m.id === draft.model)?.label}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {dirty && <span className="text-xs font-medium text-amber">{t('platform.editor.unsaved')}</span>}
          <Button size="sm" onClick={save} disabled={!dirty}>
            <Save size={15} /> {t('platform.editor.save')}
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[220px_minmax(0,1fr)_340px] lg:grid-cols-[220px_1fr]">
        <div>
          <Tabs tabs={tabs} active={tab} onChange={setTab} orientation="vertical" className="lg:sticky lg:top-20" />
        </div>

        <div className="min-w-0">
          {tab === 'general' && (
            <Card>
              <Field label={t('platform.onboarding.name')}>
                <input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} className={inputCls} placeholder={t('platform.onboarding.namePh')} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <TimezoneField value={draft.timezone} onChange={(v) => set({ timezone: v })} />
                <LanguageField value={draft.language} onChange={(v) => set({ language: v as PlatformAgent['language'] })} />
              </div>
              <Field label={t('platform.onboarding.schedule')}>
                <div className="flex gap-2">
                  {(['24/7', 'work-hours'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => set({ schedule: s })}
                      className={cn('rounded-xl border px-4 py-2 text-sm font-medium transition', draft.schedule === s ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}
                    >
                      {s === '24/7' ? t('platform.onboarding.schedule247') : t('platform.onboarding.scheduleWork')}
                    </button>
                  ))}
                </div>
                {draft.schedule === 'work-hours' && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input type="time" value={draft.workStart ?? '09:00'} onChange={(e) => set({ workStart: e.target.value })} className={cn(inputCls, 'w-auto')} />
                    <span className="text-muted">—</span>
                    <input type="time" value={draft.workEnd ?? '18:00'} onChange={(e) => set({ workEnd: e.target.value })} className={cn(inputCls, 'w-auto')} />
                    <span className="text-[11px] text-muted">{t('platform.onboarding.workHoursHint')}</span>
                  </div>
                )}
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

              {/* voice (TTS/STT) — config only for now */}
              <div className="border-t border-ice/10 pt-4">
                <label className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-sm font-normal text-text"><Mic size={15} className="text-violet" /> {t('platform.editor.voiceTitle')}</span>
                  <button
                    onClick={() => set({ voiceEnabled: !draft.voiceEnabled })}
                    className={cn('relative h-6 w-11 rounded-full transition-colors', draft.voiceEnabled ? 'bg-teal' : 'bg-ice/15')}
                    role="switch"
                    aria-checked={draft.voiceEnabled ?? false}
                  >
                    <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-ice transition-all', draft.voiceEnabled ? 'left-[22px]' : 'left-0.5')} />
                  </button>
                </label>
                {draft.voiceEnabled && (
                  <div className="mt-3 space-y-4">
                    <Field label={t('platform.editor.voiceMode')}>
                      <div className="flex flex-wrap gap-2">
                        {(['tts', 'stt', 'both'] as const).map((m) => (
                          <button
                            key={m}
                            onClick={() => set({ voiceMode: m })}
                            className={cn('rounded-xl border px-3 py-2 text-xs font-medium transition', draft.voiceMode === m ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}
                          >
                            {m === 'tts' ? t('platform.editor.voiceTts') : m === 'stt' ? t('platform.editor.voiceStt') : t('platform.editor.voiceBoth')}
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label={t('platform.editor.voiceSelect')}>
                      <div className="grid gap-2 sm:grid-cols-3">
                        {VOICES.map((v) => (
                          <button
                            key={v.id}
                            onClick={() => set({ voiceId: v.id })}
                            className={cn('flex items-center justify-between rounded-xl border px-3 py-2 text-sm transition', draft.voiceId === v.id ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}
                          >
                            {v.label}
                            {draft.voiceId === v.id && <Check size={14} className="text-violet" />}
                          </button>
                        ))}
                      </div>
                    </Field>
                    {(draft.voiceMode === 'stt' || draft.voiceMode === 'both') && (
                      <Field label={t('platform.editor.sttModel')}>
                        <div className="grid gap-2 sm:grid-cols-3">
                          {([
                            ['auto', t('platform.editor.sttAuto')],
                            ['ovozify-whisper-small-uz', 'Ovozify Whisper Small UZ'],
                            ['gemini-openrouter', 'Gemini STT'],
                          ] as const).map(([model, label]) => (
                            <button
                              key={model}
                              type="button"
                              onClick={() => set({ sttModel: model })}
                              className={cn('flex items-center justify-between rounded-xl border px-3 py-2 text-left text-xs transition', (draft.sttModel ?? 'auto') === model ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')}
                            >
                              {label}
                              {(draft.sttModel ?? 'auto') === model && <Check size={14} className="shrink-0 text-violet" />}
                            </button>
                          ))}
                        </div>
                        <p className="mt-2 text-[11px] text-muted">{t('platform.editor.sttModelHint')}</p>
                      </Field>
                    )}
                    <p className="flex items-center gap-1.5 text-[11px] text-amber"><HelpCircle size={13} /> {t('platform.editor.voiceSoon')}</p>
                  </div>
                )}
              </div>

              {/* Personal-assistant mode: answer in Telegram AS one individual, not the company */}
              <div className="border-t border-ice/10 pt-4">
                <label className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-sm font-normal text-text"><User size={15} className="text-violet" /> {t('agentEdit.personalTitle')}</span>
                  <button
                    onClick={() => set({ personaMode: draft.personaMode === 'personal' ? 'business' : 'personal' })}
                    className={cn('relative h-6 w-11 rounded-full transition-colors', draft.personaMode === 'personal' ? 'bg-teal' : 'bg-ice/15')}
                    role="switch"
                    aria-checked={draft.personaMode === 'personal'}
                  >
                    <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-ice transition-all', draft.personaMode === 'personal' ? 'left-[22px]' : 'left-0.5')} />
                  </button>
                </label>
                <p className="mt-1 text-[11px] text-muted">{t('agentEdit.personalHint')}</p>
                {draft.personaMode === 'personal' && (
                  <div className="mt-3">
                    <Field label={t('agentEdit.ownerName')}>
                      <input value={draft.ownerName ?? ''} onChange={(e) => set({ ownerName: e.target.value })} className={inputCls} placeholder={t('agentEdit.ownerNamePh')} />
                    </Field>
                  </div>
                )}
              </div>

              {/* Selectable skills — capability bundles layered on top of the agent type */}
              <div className="border-t border-ice/10 pt-4">
                <p className="flex items-center gap-1.5 text-sm font-normal text-text"><Sparkles size={15} className="text-violet" /> {t('agentEdit.skillsTitle')}</p>
                <p className="mb-3 mt-1 text-[11px] text-muted">{t('agentEdit.skillsHint')}</p>
                <div className="mb-2 flex items-center justify-between text-[10px] text-fog">
                  <span>{t('agentEdit.skillsSafety')}</span>
                  <span>{(draft.skills ?? []).length}/{MAX_AGENT_SKILLS}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {AGENT_SKILLS.map((skill) => {
                    const sk = skill.id
                    const on = (draft.skills ?? []).includes(sk)
                    const limitReached = !on && (draft.skills ?? []).length >= MAX_AGENT_SKILLS
                    return (
                      <button
                        key={sk}
                        onClick={() => set({ skills: on ? (draft.skills ?? []).filter((x) => x !== sk) : [...(draft.skills ?? []), sk] })}
                        disabled={limitReached}
                        className={cn('rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40', on ? 'border-violet/60 bg-violet/10' : 'border-ice/10 hover:border-ice/25')}
                      >
                        <span className="flex items-center justify-between text-sm font-medium text-text">
                          <span className="flex items-center gap-1.5"><skill.icon size={14} style={{ color: skill.color }} /> {t(`agentEdit.skill_${sk}`)}</span>
                          {on && <Check size={14} className="text-violet" />}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted">{t(`agentEdit.skill_${sk}Desc`)}</span>
                      </button>
                    )
                  })}
                </div>
                <SkillFileImporter agentId={draft.id} rules={draft.prompt.rules} onChange={(rules) => setPrompt({ rules })} />
              </div>
            </Card>
          )}

          {tab === 'prompt' && (
            <Card>
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
              <p className="flex items-center gap-2 text-xs text-muted">
                <HelpCircle size={14} /> {t('platform.onboarding.hint')}
              </p>
              <AgentGrowth agentId={draft.id} onApplied={(p) => setPrompt(p)} />
            </Card>
          )}

          {tab === 'knowledge' && (
            <Card>
              <KnowledgeManager agentId={draft.id} />
            </Card>
          )}

          {tab === 'model' && (
            <Card>
              <ModelPicker
                model={draft.model}
                temperature={draft.temperature}
                onModel={(id) => set({ model: id })}
                onTemperature={(temp) => set({ temperature: temp })}
              />
            </Card>
          )}

          {tab === 'leadForms' && (
            <Card>
              <label className="flex items-center justify-between">
                <span className="text-sm font-normal text-text">{t('platform.editor.leadEnable')}</span>
                <button
                  onClick={() => set({ leadForm: { ...draft.leadForm, enabled: !draft.leadForm.enabled } })}
                  className={cn('relative h-6 w-11 rounded-full transition-colors', draft.leadForm.enabled ? 'bg-teal' : 'bg-ice/15')}
                  role="switch"
                  aria-checked={draft.leadForm.enabled}
                >
                  <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-ice transition-all', draft.leadForm.enabled ? 'left-[22px]' : 'left-0.5')} />
                </button>
              </label>

              <div className={cn('space-y-4', !draft.leadForm.enabled && 'pointer-events-none opacity-50')}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('platform.editor.leadTrigger')}>
                    <input value={draft.leadForm.trigger} onChange={(e) => set({ leadForm: { ...draft.leadForm, trigger: e.target.value } })} className={inputCls} />
                  </Field>
                  <Field label={t('platform.editor.leadDest')}>
                    <select value={draft.leadForm.destination} onChange={(e) => set({ leadForm: { ...draft.leadForm, destination: e.target.value as 'crm' | 'table' } })} className={inputCls}>
                      <option value="table" className="bg-panel">{t('platform.editor.destTable')}</option>
                      <option value="crm" className="bg-panel">{t('platform.editor.destCrm')}</option>
                    </select>
                  </Field>
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-normal text-text">{t('platform.editor.leadFields')}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        set({ leadForm: { ...draft.leadForm, fields: [...draft.leadForm.fields, { id: `f${Date.now()}`, label: 'Yangi maydon', type: 'text', required: false }] } })
                      }
                    >
                      <Plus size={14} /> {t('platform.editor.leadFields')}
                    </Button>
                  </div>
                  <ul className="space-y-2">
                    {draft.leadForm.fields.map((f) => (
                      <li key={f.id} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                        <input
                          value={f.label}
                          onChange={(e) => set({ leadForm: { ...draft.leadForm, fields: draft.leadForm.fields.map((x) => (x.id === f.id ? { ...x, label: e.target.value } : x)) } })}
                          className={cn(inputCls, 'flex-1')}
                        />
                        <select
                          value={f.type}
                          onChange={(e) => set({ leadForm: { ...draft.leadForm, fields: draft.leadForm.fields.map((x) => (x.id === f.id ? { ...x, type: e.target.value as 'text' | 'phone' | 'select' } : x)) } })}
                          className={cn(inputCls, 'w-28')}
                        >
                          <option value="text" className="bg-panel">text</option>
                          <option value="phone" className="bg-panel">phone</option>
                          <option value="select" className="bg-panel">select</option>
                        </select>
                        <label className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
                          <input type="checkbox" checked={f.required} onChange={(e) => set({ leadForm: { ...draft.leadForm, fields: draft.leadForm.fields.map((x) => (x.id === f.id ? { ...x, required: e.target.checked } : x)) } })} className="accent-violet" />
                          Required
                        </label>
                        <button onClick={() => set({ leadForm: { ...draft.leadForm, fields: draft.leadForm.fields.filter((x) => x.id !== f.id) } })} className="rounded-lg p-2 text-muted hover:bg-ice/[0.06] hover:text-danger">
                          <Trash2 size={15} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
          )}

          {tab === 'channels' && (
            <Card>
              <ChannelsManager agentId={draft.id} />
            </Card>
          )}

          {tab === 'test' && <TestChat agent={draft} />}

          {tab === 'department' && <DepartmentPanel agent={draft} />}

          {tab === 'files' && <FileRunner agent={draft} />}

          {tab === 'run' && (
            <Card>
              <p className="text-xs text-muted">{t('platform.agentTypes.runHint')}</p>
              {draft.type === 'workflow' ? (
                <OrchestratorRunner
                  defaultGoal={[draft.prompt.tasks, draft.prompt.role, draft.name].find((x) => x && x.trim()) || ''}
                  niche={draft.niche}
                  purpose={draft.purpose}
                  lang={draft.language !== 'auto' ? draft.language : undefined}
                />
              ) : (
                <ResearchRunner defaultTask={[draft.prompt.tasks, draft.prompt.role, draft.name].find((x) => x && x.trim()) || ''} />
              )}
            </Card>
          )}
        </div>

        <aside className="space-y-5 xl:sticky xl:top-20 xl:self-start">
          <div className="card rounded-2xl p-5">
            <div className="flex items-center gap-3">
              <AgentAvatar color={draft.avatarColor} glyph="search" size="lg" />
              <div className="min-w-0">
                <p className="truncate font-semibold text-text">{draft.name || t('platform.editor.asideEmployee')}</p>
                <p className="text-xs text-muted">{draft.type === 'workflow' ? t('platform.editor.asideTeamLead') : t('platform.editor.asideSpecialist')}</p>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2 text-xs">
              <Status label={t('platform.editor.stStatus')} value={draft.status} tone="text-teal" />
              <Status label={t('platform.editor.stTasks')} value={String(draft.dialoguesToday || 0)} />
              <Status label={t('platform.editor.stModel')} value={MODELS.find((m) => m.id === draft.model)?.label ?? 'Free model'} />
              <Status label={t('platform.editor.stLastTest')} value={t('platform.editor.neverTested')} />
            </div>
            <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
              <p className="text-xs font-semibold text-text">{t('platform.editor.canDo')}</p>
              <p className="mt-1 line-clamp-4 text-xs leading-relaxed text-muted">{draft.prompt.tasks || draft.purpose || t('platform.editor.canDoFallback')}</p>
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {(draft.channels.length ? draft.channels : ['test chat']).map((c) => <span key={c} className="rounded-pill border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-muted">{c}</span>)}
            </div>
            <Button onClick={save} disabled={!dirty} fullWidth className="mt-5">
              <Save size={15} /> {dirty ? t('platform.editor.saveChanges') : t('platform.editor.saved')}
            </Button>
          </div>

          {tab !== 'test' && (
            <div className="card rounded-2xl p-5">
              <p className="mb-3 text-sm font-semibold text-text">{t('platform.editor.livePreview')}</p>
              <TestChat agent={draft} />
            </div>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={!!leaveTo}
        title={t('platform.editor.unsaved')}
        message={t('platform.editor.leaveMsg')}
        confirmLabel={t('platform.editor.back')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setLeaveTo(null)}
        onConfirm={() => {
          const to = leaveTo
          setLeaveTo(null)
          if (to) navigate(to)
        }}
      />
    </div>
  )
}

const inputCls =
  'glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none transition-colors placeholder:text-muted/70 focus:border-violet/50 focus:shadow-glow'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-normal text-muted">{label}</span>
      {children}
    </label>
  )
}

function Card({ children }: { children: ReactNode }) {
  return <div className="card space-y-5 rounded-2xl p-6">{children}</div>
}

function Status({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.035] p-2"><p className="text-[10px] uppercase tracking-wide text-muted">{label}</p><p className={cn('mt-1 truncate font-semibold text-text', tone)}>{value}</p></div>
}
