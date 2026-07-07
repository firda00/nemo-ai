import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, Check, RotateCcw, AlertTriangle, ClipboardList, BellRing } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { Markdown } from '../ui/Markdown'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

export type OpsKind = 'payment_control' | 'meeting_to_tasks' | 'retention_scan'

interface Reminder { student?: string; course?: string; amount?: string; due?: string; risk?: string; message?: string }
interface Escalation { admin?: string; student?: string; risk?: string; action?: string; note?: string }
interface Task { title?: string; owner?: string; deadline?: string | null; priority?: string; status?: string }
interface Student { name?: string; contact?: string; status?: string; reason?: string; message?: string | null }
interface OpsResult {
  ok?: boolean
  run_id?: string
  reminders?: Reminder[]
  escalations?: Escalation[]
  decisions?: string[]
  tasks?: Task[]
  students?: Student[]
  flagged?: Student[]
  summary?: string
}

const STEP_LABELS: Record<OpsKind, string[]> = {
  payment_control: ['Payment Reminder Agent', 'Admin Control Agent', 'Report Agent'],
  meeting_to_tasks: ['Meeting Analyst Agent', 'Task Manager Agent', 'Report Agent'],
  retention_scan: ['Retention Specialist', 'Report Agent'],
}

const RUN_LABEL: Record<OpsKind, string> = {
  payment_control: 'Run Payment Control',
  meeting_to_tasks: 'Run Meeting to Tasks',
  retention_scan: 'Run Retention Scan',
}

const retStatusCls = (s?: string) =>
  s === 'churned' ? 'bg-danger/15 text-danger border-danger/25'
    : s === 'at_risk' ? 'bg-amber/15 text-amber border-amber/25'
      : 'bg-teal/15 text-teal border-teal/25'
const retStatusKey = (s?: string) => (s === 'churned' ? 'stChurned' : s === 'at_risk' ? 'stRisk' : 'stActive')

const riskCls = (r?: string) =>
  r === 'high' ? 'bg-danger/15 text-danger border-danger/25'
    : r === 'medium' ? 'bg-amber/15 text-amber border-amber/25'
      : 'bg-teal/15 text-teal border-teal/25'

const statusCls = (s?: string) =>
  s === 'overdue' ? 'bg-danger/15 text-danger'
    : s === 'done' ? 'bg-teal/15 text-teal'
      : s === 'in_progress' ? 'bg-cyan/15 text-cyan'
        : 'bg-white/[0.06] text-muted'

export function OpsWorkflowRunner({
  kind,
  departmentId,
  sampleInput,
  lang,
  onDone,
}: {
  kind: OpsKind
  departmentId?: string
  sampleInput: string
  lang?: string
  onDone?: () => void
}) {
  const { t } = useI18n()
  const [input, setInput] = useState(sampleInput)
  const [running, setRunning] = useState(false)
  const [active, setActive] = useState(-1) // cosmetic stepper index
  const [result, setResult] = useState<OpsResult | null>(null)
  const [error, setError] = useState('')
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const labels = STEP_LABELS[kind]

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const run = async () => {
    const text = input.trim()
    if (text.length < 4 || running) return
    setError('')
    setResult(null)
    setRunning(true)
    setActive(0)
    // cosmetic progress while the single server call runs all 3 specialists
    timers.current.forEach(clearTimeout)
    timers.current = [
      setTimeout(() => setActive(1), 3500),
      setTimeout(() => setActive(2), 7000),
    ]

    try {
      if (!isSupabaseEnabled || !supabase) {
        setError('Live backend is required to run this workflow (sign in + tokens).')
        return
      }
      const { data, error: err } = await supabase.functions.invoke('ops-workflow', {
        body: { action: kind, department_id: departmentId, input: text, lang },
      })
      const payload = data as OpsResult | null
      if (err || !payload?.ok) {
        setError('Workflow failed — check sign-in, token balance and OpenRouter credits.')
        return
      }
      setActive(labels.length)
      setResult(payload)
      onDone?.()
    } catch {
      setError('Workflow failed — check sign-in, token balance and OpenRouter credits.')
    } finally {
      timers.current.forEach(clearTimeout)
      setRunning(false)
    }
  }

  const reset = () => {
    setResult(null)
    setActive(-1)
    setInput(sampleInput)
  }

  return (
    <div className="space-y-4">
      {/* input */}
      <div className="glass rounded-2xl p-2 focus-within:border-violet/50">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={kind === 'meeting_to_tasks' ? 4 : 3}
          disabled={running}
          placeholder={kind === 'payment_control' ? 'Student payment rows…' : kind === 'retention_scan' ? t('opsWorkflowRunner.retentionInputPh') : 'Meeting transcript…'}
          className="w-full resize-y bg-transparent px-2 py-2 text-sm text-text outline-none placeholder:text-muted/70"
        />
        <div className="flex justify-end px-1 pb-1">
          <button onClick={run} disabled={running || input.trim().length < 4} className="inline-flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-white transition disabled:opacity-40">
            {running ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={15} />}
            {kind === 'retention_scan' ? t('opsWorkflowRunner.runRetentionScan') : RUN_LABEL[kind]}
          </button>
        </div>
      </div>

      {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{error}</p>}

      {/* specialist stepper */}
      {(running || result) && (
        <div className="card rounded-2xl p-4">
          <div className="flex flex-wrap items-center gap-2">
            {labels.map((label, i) => {
              const done = active > i || !!result
              const isRunning = running && active === i
              return (
                <span key={label} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]', done ? 'border-teal/25 bg-teal/10 text-teal' : isRunning ? 'border-violet/30 bg-violet/10 text-violet' : 'border-ice/10 text-muted')}>
                  {done ? <Check size={12} /> : isRunning ? <Loader2 size={12} className="animate-spin" /> : <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />}
                  {label}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* results */}
      {result && !running && (
        <div className="space-y-4">
          {kind === 'payment_control' && (
            <>
              {!!result.reminders?.length && (
                <div className="card rounded-2xl p-4">
                  <p className="mb-3 text-sm font-medium text-text">Reminders · {result.reminders.length}</p>
                  <div className="space-y-2">
                    {result.reminders.map((r, i) => (
                      <div key={i} className="rounded-xl border border-ice/[0.07] p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-text">{r.student ?? '—'}</span>
                          {r.course && <span className="text-xs text-muted">· {r.course}</span>}
                          {r.amount && <span className="text-xs text-cyan">· {r.amount}</span>}
                          <span className={cn('ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium', riskCls(r.risk))}>{r.risk ?? 'medium'}</span>
                        </div>
                        {r.message && <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{r.message}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!!result.escalations?.length && (
                <div className="card rounded-2xl p-4">
                  <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text"><BellRing size={15} className="text-amber" /> Admin escalations · {result.escalations.length}</p>
                  <div className="space-y-2">
                    {result.escalations.map((e, i) => (
                      <div key={i} className="flex items-start gap-2.5 rounded-xl border border-amber/15 bg-amber/[0.04] p-3">
                        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber" />
                        <div className="min-w-0">
                          <p className="text-sm text-text"><span className="font-medium">{e.admin ?? 'Admin'}</span> → {e.student ?? ''} <span className={cn('ml-1 rounded-full border px-1.5 py-0.5 text-[10px]', riskCls(e.risk))}>{e.risk ?? 'medium'}</span></p>
                          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{e.action ?? e.note}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {kind === 'retention_scan' && !!(result.students?.length || result.flagged?.length) && (
            <div className="card rounded-2xl p-4">
              {(() => {
                const list = (result.flagged?.length ? result.flagged : result.students) ?? []
                const churn = list.filter((s) => s.status === 'churned').length
                const risk = list.filter((s) => s.status === 'at_risk').length
                return (
                  <>
                    <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text">
                      <AlertTriangle size={15} className="text-danger" /> {t('opsWorkflowRunner.needAttention')} · {list.length}
                      <span className="ml-auto text-xs text-muted">{t('opsWorkflowRunner.churnRiskSummary', { churn, risk })}</span>
                    </p>
                    <div className="space-y-2">
                      {list.map((s, i) => (
                        <div key={i} className="rounded-xl border border-ice/[0.07] p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-text">{s.name ?? '—'}</span>
                            {s.contact && <span className="text-xs text-cyan">{s.contact}</span>}
                            <span className={cn('ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium', retStatusCls(s.status))}>{t(`opsWorkflowRunner.${retStatusKey(s.status)}`)}</span>
                          </div>
                          {s.reason && <p className="mt-1 text-[12px] text-muted">{s.reason}</p>}
                          {s.message && (
                            <div className="mt-2 rounded-lg border border-violet/15 bg-violet/[0.04] p-2.5">
                              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-violet">{t('opsWorkflowRunner.readyMessage')}</p>
                              <p className="text-[13px] leading-relaxed text-text">{s.message}</p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )
              })()}
            </div>
          )}

          {kind === 'meeting_to_tasks' && (
            <>
              {!!result.decisions?.length && (
                <div className="card rounded-2xl p-4">
                  <p className="mb-2 text-sm font-medium text-text">Decisions</p>
                  <ul className="ml-4 list-disc space-y-1 text-[13px] leading-relaxed text-muted">
                    {result.decisions.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                </div>
              )}
              {!!result.tasks?.length && (
                <div className="card rounded-2xl p-4">
                  <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text"><ClipboardList size={15} className="text-cyan" /> Tasks · {result.tasks.length}</p>
                  <div className="space-y-2">
                    {result.tasks.map((tk, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-ice/[0.07] p-3">
                        <span className="min-w-0 flex-1 text-sm text-text">{tk.title}</span>
                        {tk.owner && <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-muted">{tk.owner}</span>}
                        {tk.deadline && <span className="text-[11px] text-muted">{tk.deadline}</span>}
                        <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', riskCls(tk.priority))}>{tk.priority ?? 'medium'}</span>
                        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', statusCls(tk.status))}>{tk.status ?? 'todo'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {result.summary && (
            <div className="card rounded-2xl p-5">
              <p className="mb-2 text-sm font-medium text-text">Manager summary</p>
              <Markdown content={result.summary} />
            </div>
          )}

          <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-lg border border-ice/12 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-text">
            <RotateCcw size={13} /> Run again
          </button>
        </div>
      )}
    </div>
  )
}
