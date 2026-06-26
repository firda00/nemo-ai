import { useState } from 'react'
import { ArrowUp, Loader2, ExternalLink, ChevronDown, Users, RotateCcw, Check } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Markdown } from '../ui/Markdown'
import { cn } from '../../lib/cn'

const live = isSupabaseEnabled

const ROLE_COLOR: Record<string, string> = {
  researcher: '#22D3EE',
  analyst: '#5B7CF6',
  writer: '#8B7CF8',
  reviewer: '#13C5B4',
}

interface Step {
  role: string
  task: string
  output: string
  sources: string[]
  status: 'pending' | 'running' | 'done'
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}

/**
 * Multi-agent runner. The manager plans (action 'plan'), then each sub-agent runs
 * as its OWN short call (action 'step') so nothing times out and the team fills in
 * LIVE, then the manager synthesizes (action 'synth'). Calls `orchestrate`.
 */
export function OrchestratorRunner({
  defaultGoal = '',
  niche,
  purpose,
  lang,
}: {
  defaultGoal?: string
  niche?: string
  purpose?: string
  lang?: string
}) {
  const { t } = useI18n()
  const [goal, setGoal] = useState(defaultGoal)
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'plan' | 'team' | 'synth'>('idle')
  const [steps, setSteps] = useState<Step[]>([])
  const [result, setResult] = useState<{ result: string; sources: string[] } | null>(null)
  const [error, setError] = useState('')
  const [openStep, setOpenStep] = useState<number | null>(null)

  const roleLabel = (r: string) => t(`platform.orchestrator.roles.${r}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (b: Record<string, unknown>): Promise<any> => {
    if (!live || !supabase) return null
    const { data, error: err } = await supabase.functions.invoke('orchestrate', { body: b })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err || !(data as any)?.ok) return null
    return data
  }

  const run = async () => {
    const g = goal.trim()
    if (g.length < 4 || running) return
    setError('')
    setResult(null)
    setSteps([])
    setRunning(true)
    try {
      if (!live || !supabase) {
        await new Promise((r) => setTimeout(r, 1200))
        setResult({ result: `# ${g}\n\n${t('platform.research.demoNote')}`, sources: [] })
        return
      }
      // 1) manager plans (tailored to the agent's niche/purpose/language)
      setPhase('plan')
      const plan = await call({ action: 'plan', goal: g, niche, purpose, lang })
      if (!plan) {
        setError(t('platform.research.error'))
        return
      }
      const planned: Step[] = (plan.steps ?? []).map((s: { role: string; task: string }) => ({ role: s.role, task: s.task, output: '', sources: [], status: 'pending' as const }))
      setSteps(planned)

      // 2) sub-agents run one by one (live)
      setPhase('team')
      const done: Step[] = []
      const allSources = new Set<string>()
      for (let i = 0; i < planned.length; i++) {
        setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'running' } : s)))
        const context = done.map((d) => `[${d.role}] ${d.output}`).join('\n\n').slice(0, 4000)
        const r = await call({ action: 'step', goal: g, role: planned[i].role, task: planned[i].task, context })
        const output = r?.output ?? ''
        const srcs: string[] = r?.sources ?? []
        srcs.forEach((x) => allSources.add(x))
        const filled: Step = { ...planned[i], output, sources: srcs, status: 'done' }
        done.push(filled)
        setSteps((prev) => prev.map((s, idx) => (idx === i ? filled : s)))
      }

      // 3) manager synthesizes
      setPhase('synth')
      const synth = await call({
        action: 'synth',
        goal: g,
        steps: done.map((d) => ({ role: d.role, task: d.task, output: d.output, sources: d.sources })),
        sources: [...allSources],
      })
      if (!synth) {
        setError(t('platform.research.error'))
        return
      }
      setResult({ result: synth.result, sources: [...allSources] })
    } finally {
      setRunning(false)
      setPhase('idle')
    }
  }

  const reset = () => {
    setResult(null)
    setSteps([])
    setGoal('')
  }

  return (
    <div>
      {/* goal input */}
      <div className="glass flex items-end gap-2 rounded-2xl p-2 focus-within:border-violet/50 focus-within:shadow-glow">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run()
          }}
          rows={2}
          disabled={running}
          placeholder={t('platform.orchestrator.placeholder')}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text outline-none placeholder:text-muted/70"
        />
        <button onClick={run} disabled={running || goal.trim().length < 4} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition disabled:opacity-40">
          {running ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
        </button>
      </div>
      {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{error}</p>}

      {/* manager status while planning */}
      {running && phase === 'plan' && (
        <div className="card mt-5 flex items-center gap-3 rounded-2xl p-5">
          <Loader2 size={18} className="animate-spin text-violet" />
          <p className="text-sm font-medium text-text">{t('platform.orchestrator.phasePlan')}</p>
        </div>
      )}

      {/* the team — fills in live */}
      {steps.length > 0 && (
        <div className="card mt-5 rounded-2xl p-5">
          <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text">
            <Users size={15} className="text-violet" /> {t('platform.orchestrator.team')} · {steps.length}
            {running && phase === 'synth' && <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted"><Loader2 size={12} className="animate-spin" /> {t('platform.orchestrator.phaseSynth')}</span>}
          </p>
          <div className="space-y-2">
            {steps.map((s, i) => {
              const color = ROLE_COLOR[s.role] ?? '#8B7CF8'
              return (
                <div key={i} className="rounded-xl border border-ice/[0.07]">
                  <button onClick={() => s.status === 'done' && setOpenStep(openStep === i ? null : i)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: `${color}22`, color }}>{roleLabel(s.role)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{s.task}</span>
                    {s.status === 'running' ? (
                      <Loader2 size={14} className="shrink-0 animate-spin text-violet" />
                    ) : s.status === 'done' ? (
                      <>
                        <Check size={14} className="shrink-0 text-teal" />
                        <ChevronDown size={15} className={cn('shrink-0 text-muted transition-transform', openStep === i && 'rotate-180')} />
                      </>
                    ) : (
                      <span className="shrink-0 text-[11px] text-muted">…</span>
                    )}
                  </button>
                  {openStep === i && s.status === 'done' && (
                    <div className="border-t border-ice/[0.07] px-3.5 py-3">
                      <Markdown content={s.output || '—'} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* final deliverable */}
      {result && !running && (
        <div className="mt-5 space-y-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-medium text-text">{t('platform.orchestrator.result')}</h2>
            <button onClick={reset} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-text">
              <RotateCcw size={13} /> {t('platform.research.newResearch')}
            </button>
          </div>
          <div className="card rounded-2xl p-6">
            <Markdown content={result.result} />
          </div>
          {result.sources.length > 0 && (
            <div className="card rounded-2xl p-5">
              <p className="mb-3 text-sm font-medium text-text">{t('platform.research.sources')} · {result.sources.length}</p>
              <ol className="space-y-1.5">
                {result.sources.map((u, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="mt-0.5 text-[11px] text-muted">{i + 1}.</span>
                    <a href={u} target="_blank" rel="noreferrer" className="group inline-flex min-w-0 items-center gap-1 text-cyan hover:underline">
                      <span className="truncate">{hostOf(u)}</span>
                      <ExternalLink size={12} className="shrink-0 opacity-60 group-hover:opacity-100" />
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
