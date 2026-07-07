import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, ExternalLink, ChevronDown, ListChecks, RotateCcw, Sparkles } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Markdown } from '../ui/Markdown'
import { cn } from '../../lib/cn'

const live = isSupabaseEnabled
const PHASES = ['phasePlan', 'phaseSearch', 'phaseAnalyze', 'phaseWrite'] as const

export interface Step {
  query: string
  findings: string
  sources: string[]
}
export interface ResearchResult {
  id?: string
  task: string
  report: string
  sources: string[]
  steps: Step[]
  tokens?: number
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}

/**
 * Self-contained research run surface: task input → agent works (plan/search/
 * analyze/write) → sourced report. Used by the standalone Research page AND by a
 * research-type agent's editor. `defaultTask` pre-fills the box; `initialResult`
 * shows a past run (remount with a key to switch).
 */
export function ResearchRunner({
  defaultTask = '',
  initialResult = null,
  onSaved,
}: {
  defaultTask?: string
  initialResult?: ResearchResult | null
  onSaved?: () => void
}) {
  const { t } = useI18n()
  const [task, setTask] = useState(defaultTask)
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState(0)
  const [result, setResult] = useState<ResearchResult | null>(initialResult)
  const [error, setError] = useState('')
  const [openStep, setOpenStep] = useState<number | null>(null)
  const phaseTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (running) {
      phaseTimer.current = setInterval(() => setPhase((p) => Math.min(p + 1, PHASES.length - 1)), 5500)
    } else if (phaseTimer.current) {
      clearInterval(phaseTimer.current)
      phaseTimer.current = null
    }
    return () => {
      if (phaseTimer.current) clearInterval(phaseTimer.current)
    }
  }, [running])

  const run = async () => {
    const goal = task.trim()
    if (goal.length < 4 || running) return
    setError('')
    setResult(null)
    setPhase(0)
    setRunning(true)
    try {
      if (live && supabase) {
        const { data, error: err } = await supabase.functions.invoke('research-agent', { body: { task: goal } })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = data as any
        if (err || !d?.ok) {
          setError(t('platform.research.error'))
          return
        }
        setResult({ id: d.id, task: goal, report: d.report, sources: d.sources ?? [], steps: d.steps ?? [], tokens: d.tokens })
        onSaved?.()
      } else {
        await new Promise((r) => setTimeout(r, 1500))
        setResult({ task: goal, report: `# ${goal}\n\n${t('platform.research.demoNote')}`, sources: [], steps: [] })
      }
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      {/* input */}
      <div className="glass flex items-end gap-2 rounded-2xl p-2 focus-within:border-violet/50 focus-within:shadow-glow">
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run()
          }}
          rows={2}
          disabled={running}
          placeholder={t('platform.research.placeholder')}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text outline-none placeholder:text-muted/70"
        />
        <button
          onClick={run}
          disabled={running || task.trim().length < 4}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition disabled:opacity-40"
          aria-label={t('platform.research.run')}
        >
          {running ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
        </button>
      </div>
      {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{error}</p>}

      {/* agent working */}
      {running && (
        <div className="card mt-5 rounded-2xl p-5">
          <div className="flex items-center gap-3">
            <Loader2 size={18} className="animate-spin text-violet" />
            <p className="text-sm font-medium text-text">{t('platform.research.running')}</p>
          </div>
          <ul className="mt-4 space-y-2.5">
            {PHASES.map((p, i) => (
              <li key={p} className="flex items-center gap-3 text-sm">
                <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10px]', i < phase ? 'bg-teal text-bg' : i === phase ? 'bg-violet text-white' : 'bg-ice/10 text-muted')}>
                  {i < phase ? '✓' : i + 1}
                </span>
                <span className={cn(i <= phase ? 'text-text' : 'text-muted')}>{t(`platform.research.${p}`)}</span>
                {i === phase && <Loader2 size={13} className="animate-spin text-violet" />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* result */}
      {result && !running && (
        <div className="mt-5 space-y-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-medium text-text">{result.task}</h2>
            <button onClick={() => { setResult(null); setTask('') }} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-text">
              <RotateCcw size={13} /> {t('platform.research.newResearch')}
            </button>
          </div>

          <div className="card rounded-2xl p-6">
            <Markdown content={result.report} />
          </div>

          {result.steps.length > 0 && (
            <div className="card rounded-2xl p-5">
              <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text">
                <ListChecks size={15} className="text-violet" /> {t('platform.research.steps')}
              </p>
              <div className="space-y-2">
                {result.steps.map((s, i) => (
                  <div key={i} className="rounded-xl border border-ice/[0.07]">
                    <button onClick={() => setOpenStep(openStep === i ? null : i)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet/15 text-[10px] text-violet">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{s.query}</span>
                      <ChevronDown size={15} className={cn('shrink-0 text-muted transition-transform', openStep === i && 'rotate-180')} />
                    </button>
                    {openStep === i && (
                      <div className="border-t border-ice/[0.07] px-3.5 py-3">
                        <Markdown content={s.findings || '—'} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

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

          {typeof result.tokens === 'number' && result.tokens > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Sparkles size={13} /> {result.tokens.toLocaleString()} {t('platform.research.tokensUsed')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
