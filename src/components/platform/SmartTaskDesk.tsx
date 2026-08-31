import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
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
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { classifyTaskArtifact, type SmartArtifactKind } from '../../lib/smartArtifactIntent'
import { MarketingCampaignStudio } from './MarketingCampaignStudio'
import { FinanceCashFlowDashboard } from '../finance/FinanceCashFlowDashboard'
import { ResearchNotebookHub } from '../research/ResearchNotebookHub'

type ChatTurn = {
  id: number
  role: 'user' | 'assistant'
  text?: string
  copyKey?: string
  artifact?: SmartArtifactKind
}

const ARTIFACT_META = {
  marketing: { icon: Film, route: '/app/content', titleKey: 'smartTaskDesk.marketingTitle', tint: 'text-violet bg-violet/10' },
  finance: { icon: Landmark, route: '/app/finance', titleKey: 'smartTaskDesk.financeTitle', tint: 'text-teal bg-teal/10' },
  research: { icon: NotebookTabs, route: '/app/research', titleKey: 'smartTaskDesk.researchTitle', tint: 'text-accent-cyan bg-accent-cyan/10' },
} as const

export function SmartTaskDesk() {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [activeArtifactId, setActiveArtifactId] = useState<number | null>(null)
  const turnId = useRef(0)

  const suggestions = useMemo(() => [
    { kind: 'marketing' as const, label: t('smartTaskDesk.suggestionMarketing') },
    { kind: 'finance' as const, label: t('smartTaskDesk.suggestionFinance') },
    { kind: 'research' as const, label: t('smartTaskDesk.suggestionResearch') },
  ], [t])

  const runTask = (text: string, forcedKind?: SmartArtifactKind) => {
    const value = text.trim()
    if (!value) return
    const artifact = forcedKind ?? classifyTaskArtifact(value)
    const stamp = turnId.current += 2
    const nextTurns: ChatTurn[] = [
      { id: stamp, role: 'user', text: value },
      artifact
        ? { id: stamp + 1, role: 'assistant', copyKey: `smartTaskDesk.${artifact}Ready`, artifact }
        : { id: stamp + 1, role: 'assistant', copyKey: 'smartTaskDesk.generalReady' },
    ]
    setTurns((current) => [...current.slice(-6), ...nextTurns])
    setActiveArtifactId(artifact ? stamp + 1 : null)
    setDraft('')
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    runTask(draft)
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      runTask(draft)
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
                  expanded={activeArtifactId === turn.id}
                  onToggle={() => setActiveArtifactId((current) => current === turn.id ? null : turn.id)}
                />
              )}
              {!turn.artifact && turn.role === 'assistant' && (
                <Link to="/app/teams" className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-ice/[0.08] px-3 py-2 text-xs font-semibold text-muted transition hover:border-accent-cyan/25 hover:text-text">
                  <Users size={14} />{t('smartTaskDesk.openTeams')}
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-ice/[0.07] bg-bg/20 p-3 sm:p-5">
        {!turns.length && <div className="mb-3 flex flex-wrap gap-2">
          {suggestions.map((suggestion) => <button key={suggestion.kind} type="button" onClick={() => runTask(suggestion.label, suggestion.kind)} className="rounded-xl border border-ice/[0.08] bg-card/[0.025] px-3 py-2 text-left text-xs text-muted transition hover:-translate-y-0.5 hover:border-accent-cyan/25 hover:text-text">{suggestion.label}</button>)}
        </div>}
        <form onSubmit={submit} className="relative rounded-2xl border border-ice/[0.1] bg-card/[0.04] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] focus-within:border-accent-cyan/30 focus-within:ring-2 focus-within:ring-accent-cyan/[0.06]">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            rows={2}
            placeholder={t('smartTaskDesk.placeholder')}
            className="min-h-16 w-full resize-none bg-transparent px-2 py-2 pr-12 text-sm leading-6 text-text outline-none placeholder:text-fog"
          />
          <button type="submit" disabled={!draft.trim()} aria-label={t('smartTaskDesk.send')} className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-xl bg-accent-cyan text-bg transition hover:brightness-105 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-35"><ArrowUp size={17} /></button>
        </form>
        <p className="mt-2 flex items-center gap-1.5 px-1 text-[10px] text-fog"><MessageSquareText size={12} />{t('smartTaskDesk.routingHint')}</p>
      </div>
    </section>
  )
}

function ArtifactCard({ kind, expanded, onToggle }: { kind: SmartArtifactKind; expanded: boolean; onToggle: () => void }) {
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
    </div>}
  </section>
}
