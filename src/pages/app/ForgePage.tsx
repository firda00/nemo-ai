import {
  AlertCircle, Check, CheckCircle2, ChevronRight, Circle, Cpu, FileText, Gauge,
  ExternalLink, Image, Loader2, RefreshCw, Search, Send, ShieldCheck, Sparkles, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { cn } from '../../lib/cn'
import { useForgeExecution } from '../../hooks/useForgeExecution'
import type { ExecutionStep, ForgeStepType } from '../../types/forge-contracts'

const STEP_ICONS: Record<ForgeStepType, LucideIcon> = {
  research: Search,
  documents: FileText,
  media: Image,
  quality_check: ShieldCheck,
  approval: CheckCircle2,
  publish: Send,
}

const PROFILE_LABELS = {
  PROFILE_A_WASI: 'Profile A · Logic',
  PROFILE_B_DOCS: 'Profile B · Docs',
  PROFILE_C_BROWSER: 'Profile C · Media',
  PROFILE_D_GPU: 'Profile D · GPU',
} as const

const EXAMPLE_PROMPTS = [
  'Исследуй трёх конкурентов, подготовь контент-план и видео, затем отправь на согласование.',
  'Собери коммерческое предложение в PDF и проверь все цифры перед отправкой клиенту.',
]

export default function ForgePage() {
  const forge = useForgeExecution()

  return (
    <div className="container-page max-w-[1440px] py-6 sm:py-8">
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-accent-cyan">
                <Cpu size={17} />
                <span className="mono-label text-accent-cyan">Nemo Compute Studio</span>
              </div>
              <h1 className="mt-2 text-2xl font-black text-text sm:text-3xl">От запроса до проверяемого результата</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
                Forge собирает детерминированный DAG, назначает безопасные compute-профили и ставит подтверждение человека перед публикацией или записью в CRM.
              </p>
            </div>
            <span className={cn(
              'inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold',
              forge.live ? 'border-teal/25 bg-teal/10 text-teal' : 'border-amber/25 bg-amber/10 text-amber',
            )}>
              <span className={cn('h-2 w-2 rounded-full', forge.live ? 'bg-teal' : 'bg-amber')} />
              {forge.live ? 'Live API' : 'Локальный предпросмотр'}
            </span>
          </div>

          <div className="card mt-6 rounded-3xl p-4 sm:p-5">
            <label htmlFor="forge-prompt" className="mono-label">Задача для команды</label>
            <textarea
              id="forge-prompt"
              value={forge.prompt}
              onChange={(event) => forge.setPrompt(event.target.value)}
              rows={4}
              maxLength={16_384}
              placeholder="Например: изучи конкурентов, подготовь контент-план, создай три видео и отправь результат на согласование"
              className="mt-3 w-full resize-y rounded-2xl border border-ice/10 bg-panel/70 px-4 py-3 text-sm leading-6 text-text outline-none transition placeholder:text-fog focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/15"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={forge.compileContentGrowthTemplate}
                className="inline-flex items-center gap-2 rounded-xl border border-accent-cyan/30 bg-accent-cyan/10 px-3 py-2 text-left text-xs font-semibold text-accent-cyan transition hover:bg-accent-cyan/15"
              >
                <Sparkles size={14} />
                Пилот: Content Growth (Ustadi)
              </button>
              {EXAMPLE_PROMPTS.map((example) => (
                <button key={example} type="button" onClick={() => forge.setPrompt(example)} className="rounded-xl border border-ice/10 px-3 py-1.5 text-left text-[11px] text-muted transition hover:border-accent-cyan/30 hover:text-text">
                  {example}
                </button>
              ))}
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px_auto] sm:items-end">
              <div>
                <label htmlFor="forge-routing" className="mono-label">Маршрутизация</label>
                <select id="forge-routing" value={forge.routingMode} onChange={(event) => forge.setRoutingMode(event.target.value as typeof forge.routingMode)} className="mt-2 h-10 w-full rounded-xl border border-ice/10 bg-panel px-3 text-sm text-text outline-none focus:border-accent-cyan/50">
                  <option value="auto">Авто · по задаче</option>
                  <option value="local_first">Сначала локально</option>
                  <option value="gpu_enabled">GPU разрешён</option>
                </select>
              </div>
              <div>
                <label htmlFor="forge-budget" className="mono-label">Budget cap, USD</label>
                <input id="forge-budget" type="number" min="0" max="1000000" step="0.5" value={forge.budgetCapUsd} onChange={(event) => forge.setBudgetCapUsd(Math.max(0, Number(event.target.value) || 0))} className="mt-2 h-10 w-full rounded-xl border border-ice/10 bg-panel px-3 text-sm text-text outline-none focus:border-accent-cyan/50" />
              </div>
              <Button onClick={forge.compile} disabled={forge.prompt.trim().length < 3} className="h-10 whitespace-nowrap" leftIcon={<Sparkles size={16} />}>
                Скомпилировать
              </Button>
            </div>
            {forge.compileError && <div role="alert" className="mt-4 flex items-start gap-2 rounded-2xl border border-danger/25 bg-danger/10 p-3 text-sm text-danger"><AlertCircle size={16} className="mt-0.5 shrink-0" />{forge.compileError}</div>}
          </div>

          <section className="mt-6" aria-labelledby="forge-timeline-title">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="mono-label">Live execution timeline</p>
                <h2 id="forge-timeline-title" className="mt-1 text-xl font-bold text-text">План выполнения</h2>
              </div>
              {forge.plan && <div className="flex items-center gap-2 text-xs text-muted"><Gauge size={14} /><b className="text-text">${forge.plan.estimatedCostUsd.toFixed(2)}</b> из ${forge.plan.totalBudgetCapUsd.toFixed(2)}</div>}
            </div>

            {forge.plan ? (
              <div className="mt-4 overflow-hidden rounded-3xl border border-ice/10 bg-panel/45">
                <div className="border-b border-ice/10 px-4 py-3 sm:px-5">
                  <p className="truncate text-sm font-semibold text-text">{forge.plan.title}</p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ice/10"><div className="h-full rounded-full bg-flow-gradient" style={{ width: `${Math.max(8, ((forge.plan.currentStageIndex + 1) / forge.plan.steps.length) * 100)}%` }} /></div>
                </div>
                <ol className="divide-y divide-ice/10">
                  {forge.plan.steps.map((step, index) => <TimelineStep key={step.stepId} step={step} index={index} />)}
                </ol>
                <div className="flex items-start gap-2 border-t border-accent-cyan/15 bg-accent-cyan/[0.05] px-4 py-3 text-xs leading-5 text-muted sm:px-5">
                  <ShieldCheck size={15} className="mt-0.5 shrink-0 text-accent-cyan" />
                  Это проверяемый предпросмотр DAG. Боевой запуск появится только после tenant-scoped Forge API; закрытые runtime-таблицы не доступны браузеру напрямую.
                </div>
              </div>
            ) : (
              <div className="card mt-4 grid min-h-56 place-items-center rounded-3xl p-6 text-center">
                <div><Circle className="mx-auto text-fog" size={28} /><p className="mt-3 text-sm font-semibold text-text">План ещё не собран</p><p className="mt-1 max-w-sm text-xs leading-5 text-muted">Опишите бизнес-задачу. Компилятор добавит grounding и Human-in-the-Loop там, где возможны внешние действия.</p></div>
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <section className="card rounded-3xl p-4" aria-labelledby="forge-compute-title">
            <div className="flex items-center justify-between gap-3">
              <div><p className="mono-label">Compute center</p><h2 id="forge-compute-title" className="mt-1 text-base font-bold text-text">Воркеры и коннекторы</h2></div>
              <button type="button" onClick={() => void forge.refreshOperations()} disabled={forge.loadingOperations} aria-label="Обновить статусы" className="rounded-xl p-2 text-muted hover:bg-white/5 hover:text-text disabled:opacity-50"><RefreshCw size={15} className={forge.loadingOperations ? 'animate-spin' : ''} /></button>
            </div>
            <div className="mt-4 space-y-2">
              {forge.connectors.map((connector) => (
                <div key={connector.id} className="flex items-center gap-3 rounded-2xl border border-ice/10 bg-panel/45 p-3">
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', connector.state === 'ready' ? 'bg-teal' : connector.state === 'unverified' ? 'bg-amber' : 'bg-fog/60')} />
                  <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-text">{connector.label}</p><p className="truncate text-[11px] text-muted">{connector.detail}</p></div>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{connector.state === 'ready' ? 'ready' : connector.state === 'unverified' ? 'check' : 'off'}</span>
                </div>
              ))}
            </div>
            {forge.operationsError && <p className="mt-3 text-xs leading-5 text-danger">{forge.operationsError}</p>}
          </section>

          <section className="card rounded-3xl p-4" aria-labelledby="forge-approvals-title">
            <div className="flex items-center justify-between gap-3">
              <div><p className="mono-label">Human-in-the-Loop</p><h2 id="forge-approvals-title" className="mt-1 text-base font-bold text-text">Ожидают решения</h2></div>
              <span className="rounded-pill border border-amber/25 bg-amber/10 px-2.5 py-1 text-xs font-bold text-amber">{forge.approvals.length}</span>
            </div>
            {forge.loadingOperations ? <div className="mt-4 flex items-center gap-2 text-xs text-muted"><Loader2 size={14} className="animate-spin" />Загрузка</div> : forge.approvals.length ? (
              <div className="mt-4 space-y-3">
                {forge.approvals.slice(0, 3).map((approval) => (
                  <article key={approval.id} className="rounded-2xl border border-ice/10 bg-panel/45 p-3">
                    <p className="text-xs font-medium leading-5 text-text">{approval.summary}</p>
                    <p className="mt-1 text-[10px] text-muted">{new Date(approval.createdAt).toLocaleString('ru-RU')}</p>
                    {approval.artifacts.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {approval.artifacts.map((artifact) => (
                          <div key={`${approval.id}:${artifact.sha256}`} className="overflow-hidden rounded-xl border border-ice/10 bg-bg/40">
                            {artifact.mimeType === 'video/mp4' ? (
                              <video
                                controls
                                preload="metadata"
                                playsInline
                                src={artifact.url}
                                className="aspect-video w-full bg-black object-contain"
                                aria-label={`Предпросмотр ${artifact.name}`}
                              />
                            ) : (
                              <iframe
                                src={artifact.url}
                                title={`Предпросмотр ${artifact.name}`}
                                sandbox=""
                                referrerPolicy="no-referrer"
                                className="h-40 w-full bg-white"
                              />
                            )}
                            <a
                              href={artifact.url}
                              target="_blank"
                              rel="noreferrer"
                              referrerPolicy="no-referrer"
                              className="flex items-center justify-between gap-2 px-2.5 py-2 text-[10px] text-muted hover:text-text"
                            >
                              <span className="truncate">{artifact.name}</span>
                              <ExternalLink size={12} className="shrink-0" />
                            </a>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button type="button" disabled={forge.approvalBusy === approval.id} onClick={() => void forge.decideApproval(approval.id, 'approved')} className="inline-flex items-center justify-center gap-1 rounded-xl bg-teal/10 px-2 py-2 text-xs font-semibold text-teal disabled:opacity-50"><Check size={13} />Одобрить</button>
                      <button type="button" disabled={forge.approvalBusy === approval.id} onClick={() => void forge.decideApproval(approval.id, 'rejected')} className="inline-flex items-center justify-center gap-1 rounded-xl bg-danger/10 px-2 py-2 text-xs font-semibold text-danger disabled:opacity-50"><X size={13} />Отклонить</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : <div className="mt-4 rounded-2xl border border-dashed border-ice/10 p-4 text-xs leading-5 text-muted">Активных запросов нет. Публикация и CRM-мутации остаются заблокированы до явного решения оператора.</div>}
          </section>
        </aside>
      </section>
    </div>
  )
}

function TimelineStep({ step, index }: { step: ExecutionStep; index: number }) {
  const Icon = STEP_ICONS[step.type]
  const waiting = step.status === 'waiting_approval'
  return (
    <li className="grid gap-3 px-4 py-4 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:items-center sm:px-5">
      <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl border', waiting ? 'border-amber/30 bg-amber/10 text-amber' : 'border-ice/10 bg-panel text-accent-cyan')}><Icon size={16} /></span>
      <div className="min-w-0">
        <div className="flex items-center gap-2"><span className="text-[10px] font-semibold text-fog">{String(index + 1).padStart(2, '0')}</span><p className="truncate text-sm font-semibold text-text">{step.title}</p>{index > 0 && <ChevronRight size={13} className="hidden text-fog sm:block" />}</div>
        <p className="mt-1 truncate text-xs text-muted">{step.assignedSkillId}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end"><span className="rounded-lg border border-ice/10 px-2 py-1 text-[10px] font-medium text-muted">{PROFILE_LABELS[step.computeProfile]}</span><span className={cn('rounded-lg px-2 py-1 text-[10px] font-semibold', waiting ? 'bg-amber/10 text-amber' : 'bg-white/5 text-muted')}>{waiting ? 'approval' : step.status}</span></div>
    </li>
  )
}
