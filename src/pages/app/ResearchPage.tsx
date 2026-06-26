import { useEffect, useRef, useState } from 'react'
import {
  Telescope,
  Sparkles,
  Loader2,
  ArrowUp,
  ExternalLink,
  ChevronDown,
  Clock,
  RotateCcw,
  ListChecks,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Markdown } from '../../components/ui/Markdown'
import { cn } from '../../lib/cn'

const live = isSupabaseEnabled

interface Step {
  query: string
  findings: string
  sources: string[]
}
interface Result {
  id?: string
  task: string
  report: string
  sources: string[]
  steps: Step[]
  tokens?: number
}
interface HistRow {
  id: string
  task: string
  created_at: string
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}

const EXAMPLES: Record<string, string[]> = {
  uz: [
    'O‘zbekistonda elektromobillar bozori 2025: sotuvlar, narxlar, asosiy o‘yinchilar',
    'Toshkentda IT ta’lim bozori: raqobatchilar, narx oralig‘i, talab',
    'Eng yaxshi CRM tizimlari kichik biznes uchun 2025',
  ],
  ru: [
    'Рынок электромобилей в Узбекистане 2025: продажи, цены, ключевые игроки',
    'Рынок IT-образования в Ташкенте: конкуренты, цены, спрос',
    'Лучшие CRM-системы для малого бизнеса в 2025',
  ],
  en: [
    'EV market in Uzbekistan 2025: sales, prices, key players',
    'IT education market in Tashkent: competitors, pricing, demand',
    'Best CRM systems for small business in 2025',
  ],
}

const PHASES = ['phasePlan', 'phaseSearch', 'phaseAnalyze', 'phaseWrite'] as const

export default function ResearchPage() {
  const { t, lang } = useI18n()
  const [task, setTask] = useState('')
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState(0)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<HistRow[]>([])
  const [openStep, setOpenStep] = useState<number | null>(null)
  const phaseTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadHistory = () => {
    if (!live || !supabase) return
    supabase
      .from('research_runs')
      .select('id, task, created_at')
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => setHistory((data ?? []) as HistRow[]))
  }
  useEffect(loadHistory, [])

  useEffect(() => {
    if (running) {
      setPhase(0)
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
        loadHistory()
      } else {
        await new Promise((r) => setTimeout(r, 1800))
        setResult({
          task: goal,
          report: `# ${goal}\n\n## ${t('platform.research.demoNote')}\n\n- Пример пункта 1\n- Пример пункта 2\n\n**Источник:** [example.com](https://example.com)`,
          sources: ['https://example.com'],
          steps: [{ query: goal, findings: 'demo', sources: ['https://example.com'] }],
        })
      }
    } finally {
      setRunning(false)
    }
  }

  const viewRun = async (id: string) => {
    if (!live || !supabase) return
    const { data } = await supabase.from('research_runs').select('id, task, report, sources, steps, tokens').eq('id', id).single()
    if (data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any
      setResult({ id: d.id, task: d.task, report: d.report, sources: d.sources ?? [], steps: d.steps ?? [], tokens: d.tokens })
      setError('')
    }
  }

  const reset = () => {
    setResult(null)
    setTask('')
    setError('')
  }

  return (
    <div className="container-page max-w-6xl py-8">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand text-white shadow-btn">
          <Telescope size={22} />
        </span>
        <div>
          <h1 className="text-2xl font-normal tracking-tight text-text">{t('platform.nav.research')}</h1>
          <p className="text-sm text-muted">{t('platform.research.subtitle')}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0">
          {/* input */}
          <div className="card rounded-2xl p-5">
            <div className="glass flex items-end gap-2 rounded-2xl p-2 focus-within:border-violet/50 focus-within:shadow-glow">
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run()
                }}
                rows={3}
                disabled={running}
                placeholder={t('platform.research.placeholder')}
                className="max-h-48 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text outline-none placeholder:text-muted/70"
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
            {!result && !running && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">{t('platform.research.examplesTitle')}</span>
                {(EXAMPLES[lang] ?? EXAMPLES.ru).map((ex) => (
                  <button
                    key={ex}
                    onClick={() => setTask(ex)}
                    className="rounded-full border border-ice/10 px-2.5 py-1 text-[11px] text-muted transition hover:border-violet/40 hover:text-text"
                  >
                    {ex.length > 42 ? ex.slice(0, 42) + '…' : ex}
                  </button>
                ))}
              </div>
            )}
            {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{error}</p>}
          </div>

          {/* agent working */}
          {running && (
            <div className="card mt-6 rounded-2xl p-6">
              <div className="flex items-center gap-3">
                <Loader2 size={18} className="animate-spin text-violet" />
                <p className="text-sm font-medium text-text">{t('platform.research.running')}</p>
              </div>
              <ul className="mt-4 space-y-2.5">
                {PHASES.map((p, i) => (
                  <li key={p} className="flex items-center gap-3 text-sm">
                    <span
                      className={cn(
                        'flex h-5 w-5 items-center justify-center rounded-full text-[10px]',
                        i < phase ? 'bg-teal text-bg' : i === phase ? 'bg-violet text-white' : 'bg-ice/10 text-muted',
                      )}
                    >
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
            <div className="mt-6 space-y-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-medium text-text">{result.task}</h2>
                <button onClick={reset} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-text">
                  <RotateCcw size={13} /> {t('platform.research.newResearch')}
                </button>
              </div>

              {/* report */}
              <div className="card rounded-2xl p-6">
                <Markdown content={result.report} />
              </div>

              {/* steps */}
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
                            {s.sources.length > 0 && (
                              <p className="mt-2 text-[11px] text-muted">{s.sources.length} {t('platform.research.sources').toLowerCase()}</p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* sources */}
              {result.sources.length > 0 && (
                <div className="card rounded-2xl p-5">
                  <p className="mb-3 text-sm font-medium text-text">
                    {t('platform.research.sources')} · {result.sources.length}
                  </p>
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
                  <Sparkles size={13} /> {result.tokens.toLocaleString('ru-RU')} {t('platform.research.tokensUsed')}
                </p>
              )}
            </div>
          )}

          {!result && !running && (
            <div className="mt-6 rounded-2xl border border-dashed border-ice/10 py-12 text-center">
              <Telescope size={28} className="mx-auto text-muted/60" />
              <p className="mx-auto mt-3 max-w-sm text-sm text-muted">{t('platform.research.empty')}</p>
            </div>
          )}
        </div>

        {/* history */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="card rounded-2xl p-4">
            <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text">
              <Clock size={15} className="text-muted" /> {t('platform.research.history')}
            </p>
            {history.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted">{t('platform.research.emptyHist')}</p>
            ) : (
              <ul className="space-y-1">
                {history.map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => viewRun(h.id)}
                      className={cn(
                        'w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-ice/[0.05]',
                        result?.id === h.id ? 'bg-ice/[0.06] text-text' : 'text-muted',
                      )}
                    >
                      <span className="line-clamp-2">{h.task}</span>
                      <span className="mt-0.5 block text-[10px] text-muted/70">{h.created_at?.slice(0, 10)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
