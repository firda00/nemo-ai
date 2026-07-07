import { useEffect, useState, useCallback } from 'react'
import { Activity, Users, Wrench, CheckCircle2, XCircle, Clock, ChevronDown, Bot, Plug, MessageSquare } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

function Tile({ icon: Icon, n, l, tone }: { icon: typeof Users; n: number | string; l: string; tone: string }) {
  return (
    <div className="card rounded-2xl p-4">
      <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl', tone)}><Icon size={17} /></span>
      <p className="mt-3 text-2xl font-semibold text-text">{n}</p>
      <p className="text-xs text-muted">{l}</p>
    </div>
  )
}

const live = isSupabaseEnabled

interface Run { id: string; task: string; status: string; kind: string; tokens: number; steps: { query?: string; findings?: string }[]; created_at: string }
interface ToolRun { id: string; tool: string; ok: boolean; result: string | null; created_at: string }
interface Channel { type: string; status: string }

const KIND_LABEL: Record<string, string> = {
  research: 'observabilityPage.kindResearch', team_run: 'observabilityPage.kindTeam', analysis: 'observabilityPage.kindAnalysis', payment_control: 'observabilityPage.kindPaymentControl', meeting_to_tasks: 'observabilityPage.kindMeetingToTasks', competitor_analysis: 'observabilityPage.kindAutoTeam',
}
const runStatus = (s: string) => (s === 'done' ? { c: 'text-teal bg-teal/10', k: 'observabilityPage.statusDone' } : s === 'error' ? { c: 'text-danger bg-danger/10', k: 'observabilityPage.statusError' } : { c: 'text-violet bg-violet/10', k: 'observabilityPage.statusRunning' })

export default function ObservabilityPage() {
  const { t } = useI18n()
  const [runs, setRuns] = useState<Run[]>([])
  const [tools, setTools] = useState<ToolRun[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [providers, setProviders] = useState<string[]>([])
  const [dialogues, setDialogues] = useState(0)
  const [health, setHealth] = useState<{ status: string; summary: string; created_at: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openRun, setOpenRun] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!live || !supabase) { setError(t('observabilityPage.signInLive')); setLoading(false); return }
    try {
      const [r, tr, ch, dlg, prov, ops] = await Promise.all([
        supabase.from('research_runs').select('id, task, status, kind, tokens, steps, created_at').order('created_at', { ascending: false }).limit(20),
        supabase.from('tool_runs').select('id, tool, ok, result, created_at').order('created_at', { ascending: false }).limit(30),
        supabase.from('channels').select('type, status'),
        supabase.from('dialogues').select('id', { count: 'exact', head: true }),
        supabase.functions.invoke('connect-provider', { body: { action: 'status' } }),
        supabase.from('ops_checks').select('status, summary, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ])
      // supabase-js resolves with {data,error} and does NOT reject on query-level
      // failures (RLS denial, missing table). Without this, a blocked read renders
      // as an empty state instead of an error. (prov is auxiliary — don't hard-fail on it.)
      if (r.error || tr.error || ch.error || dlg.error) throw new Error('read failed')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRuns((r.data as any[])?.map((x) => ({ ...x, steps: Array.isArray(x.steps) ? x.steps : [] })) ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setTools((tr.data as any[]) ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setChannels((ch.data as any[]) ?? [])
      setDialogues(dlg.count ?? 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setProviders(((prov.data as any)?.connected as string[]) ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setHealth((ops.data as any) ?? null)
    } catch { setError(t('observabilityPage.loadError')) }
    setLoading(false)
  }, [t])
  useEffect(() => { let a = true; (async () => { if (a) await load() })(); return () => { a = false } }, [load])

  const fmt = (iso: string) => { try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) } catch { return iso } }
  const toolOk = tools.filter((t) => t.ok).length
  const connCount = providers.length + channels.filter((c) => c.status === 'connected').length

  return (
    <div className="container-page max-w-5xl py-8">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/15 text-violet"><Activity size={20} /></span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">{t('observabilityPage.title')}</h1>
          <p className="text-sm text-muted">{t('observabilityPage.subtitle')}</p>
        </div>
      </div>

      {error ? (
        <div className="card mt-6 rounded-2xl p-6 text-sm text-muted">{error}</div>
      ) : loading ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-white/[0.03]" />)}</div>
      ) : (
        <>
          {health && (
            <div className={cn('mt-6 flex items-center gap-3 rounded-2xl border px-4 py-3', health.status === 'ok' ? 'border-teal/25 bg-teal/[0.06]' : health.status === 'warn' ? 'border-amber/25 bg-amber/[0.06]' : 'border-danger/25 bg-danger/[0.06]')}>
              <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', health.status === 'ok' ? 'bg-teal' : health.status === 'warn' ? 'bg-amber' : 'bg-danger')} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-text">{t('observabilityPage.healthTitle')}: {health.status === 'ok' ? t('observabilityPage.healthOk') : health.status === 'warn' ? t('observabilityPage.healthWarn') : t('observabilityPage.healthDown')}</p>
                <p className="truncate text-[11px] text-muted">{health.summary} · {fmt(health.created_at)}</p>
              </div>
              <span className="shrink-0 text-[10px] text-fog">{t('observabilityPage.healthAuto')}</span>
            </div>
          )}
          <div className="mt-6 grid gap-3 sm:grid-cols-4">
            <Tile icon={Plug} n={connCount} l={t('observabilityPage.tileConnections')} tone="bg-teal/15 text-teal" />
            <Tile icon={Users} n={runs.length} l={t('observabilityPage.tileRuns')} tone="bg-violet/15 text-violet" />
            <Tile icon={Wrench} n={`${toolOk}/${tools.length}`} l={t('observabilityPage.tileToolCalls')} tone="bg-cyan/15 text-cyan" />
            <Tile icon={MessageSquare} n={dialogues} l={t('observabilityPage.tileDialogues')} tone="bg-amber/15 text-amber" />
          </div>

          {/* multi-agent runs */}
          <section className="mt-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text"><Users size={15} className="text-violet" /> {t('observabilityPage.multiAgentTitle')}</h2>
            {runs.length === 0 ? (
              <div className="card rounded-2xl p-6 text-sm text-muted">{t('observabilityPage.runsEmpty')}</div>
            ) : (
              <div className="space-y-2">
                {runs.map((r) => {
                  const st = runStatus(r.status)
                  return (
                    <div key={r.id} className="card rounded-2xl">
                      <button onClick={() => setOpenRun(openRun === r.id ? null : r.id)} className="flex w-full items-center gap-2.5 px-4 py-3 text-left">
                        <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', st.c)}>{t(st.k)}</span>
                        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted">{KIND_LABEL[r.kind] ? t(KIND_LABEL[r.kind]) : r.kind}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-text">{r.task}</span>
                        <span className="shrink-0 text-[11px] text-fog">{t('observabilityPage.agentsSuffix', { count: r.steps.length })}</span>
                        <span className="hidden shrink-0 text-[11px] text-fog sm:inline">{fmt(r.created_at)}</span>
                        <ChevronDown size={14} className={cn('shrink-0 text-muted transition-transform', openRun === r.id && 'rotate-180')} />
                      </button>
                      {openRun === r.id && (
                        <div className="border-t border-ice/[0.07] px-4 py-3">
                          <p className="mb-2 text-[11px] text-fog">{t('observabilityPage.teamTrace', { tokens: r.tokens.toLocaleString('ru-RU') })}</p>
                          <div className="space-y-1.5">
                            {r.steps.map((s, i) => (
                              <div key={i} className="flex items-start gap-2 text-[12px]">
                                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet/12 text-[10px] text-violet"><Bot size={11} /></span>
                                <span className="text-muted"><b className="text-text">{s.query ?? t('observabilityPage.step', { n: i + 1 })}</b>{s.findings ? ` — ${String(s.findings).slice(0, 140)}…` : ''}</span>
                              </div>
                            ))}
                            {r.steps.length === 0 && <p className="text-[12px] text-fog">{t('observabilityPage.noTrace')}</p>}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* tool / integration call log */}
          <section className="mt-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text"><Wrench size={15} className="text-cyan" /> {t('observabilityPage.toolCallsTitle')}</h2>
            {tools.length === 0 ? (
              <div className="card rounded-2xl p-6 text-sm text-muted">{t('observabilityPage.toolsEmpty')}</div>
            ) : (
              <div className="card overflow-hidden rounded-2xl">
                {tools.map((t, i) => (
                  <div key={t.id} className={cn('flex items-center gap-3 px-4 py-2.5', i > 0 && 'border-t border-ice/[0.06]')}>
                    {t.ok ? <CheckCircle2 size={14} className="shrink-0 text-teal" /> : <XCircle size={14} className="shrink-0 text-danger" />}
                    <span className="shrink-0 rounded-md bg-violet/10 px-2 py-0.5 font-mono text-[11px] text-violet">{t.tool}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{t.result ?? '—'}</span>
                    <span className="shrink-0 text-[11px] text-fog"><Clock size={11} className="mr-1 inline" />{fmt(t.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* integration health */}
          <section className="mt-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text"><Plug size={15} className="text-teal" /> {t('observabilityPage.integrationsTitle')}</h2>
            <div className="flex flex-wrap gap-2">
              {channels.map((c, i) => (
                <span key={`ch${i}`} className={cn('inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs', c.status === 'connected' ? 'border-teal/25 bg-teal/[0.06] text-text' : 'border-ice/10 text-muted')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', c.status === 'connected' ? 'bg-teal' : 'bg-fog')} /> {c.type}
                </span>
              ))}
              {providers.map((p) => (
                <span key={p} className="inline-flex items-center gap-1.5 rounded-xl border border-teal/25 bg-teal/[0.06] px-3 py-1.5 text-xs text-text">
                  <span className="h-1.5 w-1.5 rounded-full bg-teal" /> {p}
                </span>
              ))}
              {channels.length === 0 && providers.length === 0 && (
                <span className="text-sm text-muted">{t('observabilityPage.nothingConnected')}</span>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
