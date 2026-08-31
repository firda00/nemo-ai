import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowUp,
  Bot,
  ChevronDown,
  ExternalLink,
  Film,
  Landmark,
  MessageSquareText,
  NotebookTabs,
  Sparkles,
  Users,
  UserRound,
  Workflow,
  Loader2,
  Code2,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { classifyTaskArtifact, type SmartArtifactKind } from '../../lib/smartArtifactIntent'
import { MarketingCampaignStudio } from './MarketingCampaignStudio'
import { FinanceCashFlowDashboard } from '../finance/FinanceCashFlowDashboard'
import { ResearchNotebookHub } from '../research/ResearchNotebookHub'
import { AutonomousRunner } from './AutonomousRunner'
import { classifyChatEntityIntent, createEntityFromChat, type ChatCreatedEntity } from '../../lib/chatEntityFactory'
import { useAgentStore } from '../../store/useAgentStore'
import { LiveCodeSandboxArtifact } from './LiveCodeSandboxArtifact'

type ChatTurn = {
  id: number
  role: 'user' | 'assistant'
  text?: string
  copyKey?: string
  artifact?: SmartArtifactKind
  artifactPrompt?: string
  entity?: ChatCreatedEntity
  teamRunGoal?: string
  error?: boolean
}

type DiscoveryState = {
  step: 'goal' | 'channels' | 'format'
  initialRequest: string
  requestedKind: 'team' | 'agent' | null
  goal?: string
  channels?: string
}

const DISCOVERY_COPY = {
  ru: {
    goal: 'Начнём с цели. Какой конкретный результат должен давать агент или команда?',
    channels: 'С какими каналами, файлами или сервисами нужно работать? Например: Telegram, Google Drive, CRM, CSV или сайт.',
    format: 'Какой формат вам нужен: один узкий агент или команда специалистов?',
    progress: 'Настройка команды · вопрос {step} из 3',
  },
  uz: {
    goal: 'Maqsaddan boshlaymiz. Agent yoki jamoa qanday aniq natija berishi kerak?',
    channels: 'Qaysi kanallar, fayllar yoki servislar bilan ishlash kerak? Masalan: Telegram, Google Drive, CRM, CSV yoki sayt.',
    format: 'Qaysi format kerak: bitta maxsus agentmi yoki mutaxassislar jamoasimi?',
    progress: 'Jamoani sozlash · 3 savoldan {step}-savol',
  },
  en: {
    goal: 'Let’s start with the goal. What concrete outcome should the agent or team deliver?',
    channels: 'Which channels, files, or services should it use? For example: Telegram, Google Drive, CRM, CSV, or a website.',
    format: 'Which format do you need: one focused agent or a team of specialists?',
    progress: 'Team setup · question {step} of 3',
  },
} as const

const ARTIFACT_META = {
  marketing: { icon: Film, route: '/app/content', titleKey: 'smartTaskDesk.marketingTitle', tint: 'text-violet bg-violet/10' },
  finance: { icon: Landmark, route: '/app/finance', titleKey: 'smartTaskDesk.financeTitle', tint: 'text-teal bg-teal/10' },
  research: { icon: NotebookTabs, route: '/app/research', titleKey: 'smartTaskDesk.researchTitle', tint: 'text-accent-cyan bg-accent-cyan/10' },
  code: { icon: Code2, route: '/app/teams', titleKey: 'smartTaskDesk.codeTitle', tint: 'text-teal bg-teal/10' },
} as const

export function SmartTaskDesk() {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const addAgent = useAgentStore((state) => state.addAgent)
  const deleteAgent = useAgentStore((state) => state.deleteAgent)
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [activeArtifactId, setActiveArtifactId] = useState<number | null>(null)
  const [activeEntity, setActiveEntity] = useState<ChatCreatedEntity | null>(null)
  const [creating, setCreating] = useState(false)
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null)
  const turnId = useRef(0)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const discoveryStartedFromUrl = useRef(false)
  const discoveryCopy = DISCOVERY_COPY[lang]

  const askDiscoveryQuestion = (copy: string) => {
    const id = ++turnId.current
    setTurns((current) => [...current.slice(-10), { id, role: 'assistant', text: copy }])
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }

  const startDiscovery = (requestedKind: 'team' | 'agent' | null, initialRequest = '') => {
    setActiveEntity(null)
    setDiscovery({ step: 'goal', initialRequest, requestedKind })
    askDiscoveryQuestion(discoveryCopy.goal)
  }

  useEffect(() => {
    const create = searchParams.get('create')
    if (create !== 'team' && create !== 'agent') {
      discoveryStartedFromUrl.current = false
      return
    }
    if (discoveryStartedFromUrl.current) return
    discoveryStartedFromUrl.current = true
    startDiscovery(create, '')
    const next = new URLSearchParams(searchParams)
    next.delete('create')
    setSearchParams(next, { replace: true })
    // This effect intentionally reacts only to the one-shot URL command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams])

  const suggestions = useMemo(() => [
    { kind: 'marketing' as const, label: t('smartTaskDesk.suggestionMarketing') },
    { kind: 'finance' as const, label: t('smartTaskDesk.suggestionFinance') },
    { kind: 'research' as const, label: t('smartTaskDesk.suggestionResearch') },
  ], [t])

  const runTask = async (text: string, forcedKind?: SmartArtifactKind) => {
    const value = text.trim()
    if (!value || creating) return
    const entityIntent = classifyChatEntityIntent(value)
    const artifact = forcedKind ?? classifyTaskArtifact(value)
    const stamp = turnId.current += 2
    setTurns((current) => [...current.slice(-8), { id: stamp, role: 'user', text: value }])
    setDraft('')
    if (discovery) {
      if (discovery.step === 'goal') {
        setDiscovery({ ...discovery, step: 'channels', goal: value })
        setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', text: discoveryCopy.channels }])
        window.setTimeout(() => composerRef.current?.focus(), 0)
        return
      }
      if (discovery.step === 'channels') {
        setDiscovery({ ...discovery, step: 'format', channels: value })
        setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', text: discoveryCopy.format }])
        window.setTimeout(() => composerRef.current?.focus(), 0)
        return
      }
      const soloAnswer = /(?:один|соло|агент|solo|single|bitta|agent)/i.test(value)
      const teamAnswer = /(?:команд|team|jamoa|специалист)/i.test(value)
      const kind = soloAnswer ? 'agent' : teamAnswer ? 'team' : discovery.requestedKind ?? 'team'
      const creationPrompt = `${kind === 'team' ? 'Создай команду' : 'Создай агента'}. Цель: ${discovery.goal}. Каналы и источники: ${discovery.channels}. Формат: ${value}. Исходный запрос: ${discovery.initialRequest}`
      setDiscovery(null)
      setCreating(true)
      try {
        const entity = await createEntityFromChat(creationPrompt, addAgent, deleteAgent)
        setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', copyKey: `smartTaskDesk.${entity.kind}Created`, entity }])
      } catch (error) {
        setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', text: error instanceof Error ? error.message : t('smartTaskDesk.creationFailed'), error: true }])
      } finally {
        setCreating(false)
      }
      return
    }
    if (entityIntent) {
      setDiscovery({ step: 'goal', initialRequest: value, requestedKind: entityIntent })
      setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', text: discoveryCopy.goal }])
      window.setTimeout(() => composerRef.current?.focus(), 0)
      return
    }
    const response: ChatTurn = activeEntity
      ? { id: stamp + 1, role: 'assistant', copyKey: 'smartTaskDesk.teamRunReady', entity: activeEntity, teamRunGoal: value }
      : artifact
        ? { id: stamp + 1, role: 'assistant', copyKey: `smartTaskDesk.${artifact}Ready`, artifact, artifactPrompt: value }
        : { id: stamp + 1, role: 'assistant', copyKey: 'smartTaskDesk.generalReady' }
    setTurns((current) => [...current, response])
    setActiveArtifactId(artifact ? stamp + 1 : null)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void runTask(draft)
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void runTask(draft)
    }
  }

  return (
    <section className="overflow-hidden rounded-[28px] border border-ice/[0.09] bg-panel/70 shadow-[0_24px_80px_-48px_rgba(6,182,212,0.55)] backdrop-blur-xl" aria-labelledby="smart-task-desk-title">
      <header className="border-b border-ice/[0.07] px-4 py-5 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-flow-gradient text-white shadow-lg shadow-violet/15">
            <Sparkles size={19} />
            <span className="absolute inset-0 animate-pulse bg-white/[0.05]" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.17em] text-accent-cyan">{t('smartTaskDesk.eyebrow')}</p>
            <h1 id="smart-task-desk-title" className="mt-1 text-2xl font-extrabold tracking-[-0.035em] text-text sm:text-3xl">{t('smartTaskDesk.title')}</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{t('smartTaskDesk.subtitle')}</p>
          </div>
        </div>
      </header>

      <div className="min-h-[300px] space-y-5 px-3 py-5 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-accent-cyan/15 bg-accent-cyan/[0.06] text-accent-cyan"><Bot size={15} /></span>
          <div className="max-w-3xl rounded-2xl rounded-tl-md border border-ice/[0.07] bg-card/[0.035] px-4 py-3 text-sm leading-6 text-muted">
            {t('smartTaskDesk.welcome')}
          </div>
        </div>

        {activeEntity && <div className="ml-11 flex flex-wrap items-center gap-2 rounded-xl border border-teal/20 bg-teal/[0.06] px-3 py-2 text-xs text-muted">
          <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal opacity-60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-teal" /></span>
          <strong className="text-text">{activeEntity.name}</strong>
          <span>{t('smartTaskDesk.activeContext')}</span>
          <button type="button" onClick={() => setActiveEntity(null)} className="ml-auto font-semibold text-teal hover:text-text">{t('smartTaskDesk.leaveContext')}</button>
        </div>}

        {turns.map((turn) => (
          <div key={turn.id} className={cn('flex items-start gap-3 animate-fadeIn', turn.role === 'user' && 'justify-end')}>
            {turn.role === 'assistant' && <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-accent-cyan/15 bg-accent-cyan/[0.06] text-accent-cyan"><Bot size={15} /></span>}
            <div className={cn('min-w-0', turn.artifact ? 'w-[calc(100%-44px)]' : 'max-w-3xl')}>
              <div className={cn(
                'rounded-2xl px-4 py-3 text-sm leading-6',
                turn.role === 'user' ? 'rounded-tr-md bg-accent-indigo text-white' : 'rounded-tl-md border border-ice/[0.07] bg-card/[0.035] text-muted',
              )}>
                {turn.text ?? (turn.copyKey ? t(turn.copyKey) : '')}
              </div>
              {turn.artifact && (
                <ArtifactCard
                  kind={turn.artifact}
                  prompt={turn.artifactPrompt ?? ''}
                  expanded={activeArtifactId === turn.id}
                  onToggle={() => setActiveArtifactId((current) => current === turn.id ? null : turn.id)}
                />
              )}
              {turn.entity && !turn.teamRunGoal && <TeamArtifact entity={turn.entity} onOpen={() => navigate(turn.entity!.kind === 'team' ? `/app/teams/${turn.entity!.id}` : `/app/agents/${turn.entity!.id}`)} onWorkHere={() => setActiveEntity(turn.entity ?? null)} />}
              {turn.entity && turn.teamRunGoal && <TeamRunArtifact entity={turn.entity} goal={turn.teamRunGoal} />}
              {!turn.artifact && !turn.entity && turn.role === 'assistant' && !turn.error && (
                <Link to="/app/teams" className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-ice/[0.08] px-3 py-2 text-xs font-semibold text-muted transition hover:border-accent-cyan/25 hover:text-text">
                  <Users size={14} />{t('smartTaskDesk.openTeams')}
                </Link>
              )}
            </div>
          </div>
        ))}
        {creating && <div className="flex items-center gap-3 animate-fadeIn"><span className="flex h-8 w-8 items-center justify-center rounded-xl border border-violet/20 bg-violet/10 text-violet"><Loader2 size={15} className="animate-spin" /></span><div className="rounded-2xl rounded-tl-md border border-ice/[0.07] bg-card/[0.035] px-4 py-3 text-sm text-muted"><span className="mr-2 inline-flex gap-1 align-middle"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-cyan" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet [animation-delay:150ms]" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal [animation-delay:300ms]" /></span>{t('smartTaskDesk.assembling')}</div></div>}
      </div>

      <div className="border-t border-ice/[0.07] bg-bg/20 p-3 sm:p-5">
        {discovery && <div className="mb-3 flex items-center gap-2 rounded-xl border border-violet/20 bg-violet/[0.06] px-3 py-2 text-[11px] font-semibold text-violet"><Sparkles size={13} className="animate-pulse" />{discoveryCopy.progress.replace('{step}', discovery.step === 'goal' ? '1' : discovery.step === 'channels' ? '2' : '3')}</div>}
        {!turns.length && <div className="mb-3 flex flex-wrap gap-2">
          {suggestions.map((suggestion) => <button key={suggestion.kind} type="button" onClick={() => void runTask(suggestion.label, suggestion.kind)} className="rounded-xl border border-ice/[0.08] bg-card/[0.025] px-3 py-2 text-left text-xs text-muted transition hover:-translate-y-0.5 hover:border-accent-cyan/25 hover:text-text">{suggestion.label}</button>)}
        </div>}
        <form onSubmit={submit} className="relative rounded-2xl border border-ice/[0.1] bg-card/[0.04] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] focus-within:border-accent-cyan/30 focus-within:ring-2 focus-within:ring-accent-cyan/[0.06]">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            rows={2}
            placeholder={t('smartTaskDesk.placeholder')}
            className="min-h-16 w-full resize-none bg-transparent px-2 py-2 pr-12 text-sm leading-6 text-text outline-none placeholder:text-fog"
          />
          <button type="submit" disabled={!draft.trim() || creating} aria-label={t('smartTaskDesk.send')} className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-xl bg-accent-cyan text-bg transition hover:brightness-105 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-35"><ArrowUp size={17} /></button>
        </form>
        <p className="mt-2 flex items-center gap-1.5 px-1 text-[10px] text-fog"><MessageSquareText size={12} />{t('smartTaskDesk.routingHint')}</p>
      </div>
    </section>
  )
}

function TeamArtifact({ entity, onOpen, onWorkHere }: { entity: ChatCreatedEntity; onOpen(): void; onWorkHere(): void }) {
  const { t } = useI18n()
  const Icon = entity.kind === 'team' ? Users : UserRound
  return <section className="mt-3 overflow-hidden rounded-2xl border border-accent-cyan/20 bg-gradient-to-br from-accent-cyan/[0.07] via-bg/50 to-violet/[0.07] shadow-[0_18px_60px_-42px_rgba(34,211,238,0.7)]">
    <div className="flex items-center gap-3 border-b border-ice/[0.07] p-4"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-flow-gradient text-white shadow-lg shadow-violet/20"><Icon size={19} /></span><div className="min-w-0 flex-1"><p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-accent-cyan">{t(entity.kind === 'team' ? 'smartTaskDesk.teamArtifact' : 'smartTaskDesk.agentArtifact')}</p><h2 className="truncate text-base font-bold text-text">{entity.name}</h2></div><span className="rounded-full border border-teal/20 bg-teal/10 px-2.5 py-1 text-[10px] font-semibold text-teal">{t('smartTaskDesk.ready')}</span></div>
    <div className="p-4"><div className="grid gap-2 sm:grid-cols-3">{entity.members.map((member, index) => <div key={`${member.name}-${index}`} className="relative overflow-hidden rounded-xl border border-ice/[0.08] bg-black/10 p-3"><span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-teal shadow-[0_0_12px_rgba(45,212,191,0.9)]" /><p className="truncate text-xs font-semibold text-text">{member.name}</p><p className="mt-1 truncate text-[10px] text-muted">{member.role}</p></div>)}</div>
      {entity.members.length > 1 && <div className="my-4 flex items-center gap-2 text-[10px] text-fog"><Workflow size={13} className="text-violet" /><span className="h-px flex-1 overflow-hidden bg-gradient-to-r from-violet via-accent-cyan to-teal"><span className="block h-px w-1/3 animate-[pulse_1.4s_ease-in-out_infinite] bg-white" /></span>{t('smartTaskDesk.a2aReady')}</div>}
      <div className="flex flex-col gap-2 sm:flex-row"><button type="button" onClick={onOpen} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent-cyan px-4 py-2.5 text-xs font-bold text-bg transition hover:brightness-105"><ExternalLink size={14} />{t(entity.kind === 'team' ? 'smartTaskDesk.openLobby' : 'smartTaskDesk.openAgent')}</button><button type="button" onClick={onWorkHere} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-ice/[0.1] bg-white/[0.03] px-4 py-2.5 text-xs font-bold text-text transition hover:border-violet/30 hover:bg-violet/[0.06]"><MessageSquareText size={14} />{t('smartTaskDesk.workHere')}</button></div>
    </div>
  </section>
}

function TeamRunArtifact({ entity, goal }: { entity: ChatCreatedEntity; goal: string }) {
  const { t } = useI18n()
  return <section className="mt-3 overflow-hidden rounded-2xl border border-violet/20 bg-bg/45"><div className="flex items-center gap-3 border-b border-ice/[0.07] px-4 py-3"><span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-violet/10 text-violet"><Workflow size={16} /><span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-ping rounded-full bg-teal" /></span><div><p className="text-xs font-bold text-text">{entity.name}</p><p className="text-[10px] text-muted">{t('smartTaskDesk.teamRunHandoff')}</p></div></div><div className="p-3 sm:p-4"><AutonomousRunner defaultGoal={goal} departmentId={entity.departmentId} contextKey={`chat:${entity.id}`} presetSpecs={entity.members.map((member) => ({ name: member.name, role: member.role, skills: member.skills, prompt: member.prompt }))} /></div></section>
}

function ArtifactCard({ kind, prompt, expanded, onToggle }: { kind: SmartArtifactKind; prompt: string; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const meta = ARTIFACT_META[kind]
  const Icon = meta.icon

  return <section className="mt-3 overflow-hidden rounded-2xl border border-ice/[0.09] bg-bg/35">
    <div className="flex flex-wrap items-center gap-3 border-b border-ice/[0.07] px-3 py-3 sm:px-4">
      <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl', meta.tint)}><Icon size={16} /></span>
      <div className="min-w-0 flex-1"><p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-fog">{t('smartTaskDesk.interactiveArtifact')}</p><h2 className="truncate text-sm font-bold text-text">{t(meta.titleKey)}</h2></div>
      <Link to={meta.route} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[11px] font-semibold text-muted transition hover:bg-white/[0.04] hover:text-text"><ExternalLink size={13} />{t('smartTaskDesk.openFull')}</Link>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="inline-flex items-center gap-1.5 rounded-lg border border-ice/[0.08] px-2.5 py-2 text-[11px] font-semibold text-muted transition hover:bg-white/[0.04] hover:text-text"><ChevronDown size={13} className={cn('transition-transform', expanded && 'rotate-180')} />{expanded ? t('smartTaskDesk.collapse') : t('smartTaskDesk.expand')}</button>
    </div>
    {expanded && <div className="max-h-[760px] overflow-auto p-3 sm:p-5 animate-fadeIn">
      {kind === 'marketing' && <MarketingCampaignStudio />}
      {kind === 'finance' && <FinanceCashFlowDashboard />}
      {kind === 'research' && <ResearchNotebookHub />}
      {kind === 'code' && <LiveCodeSandboxArtifact prompt={prompt} />}
    </div>}
  </section>
}
