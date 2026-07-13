import { useEffect, useState } from 'react'
import { BarChart3, Loader2, PlayCircle, ClipboardList, MessagesSquare, Send, Bell, Users, Bot, Zap, RefreshCw } from 'lucide-react'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

/**
 * Activity — the "who does what" overview across every section: team runs, tasks,
 * client dialogues, scheduled posts, alerts, team roster and token load. Read-only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export default function ActivityPage() {
  const { t } = useI18n()
  const [data, setData] = useState<any | null>(null)
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [error, setError] = useState(false)
  const [runPage, setRunPage] = useState(0)
  const runPageSize = 5

  const load = async () => {
    if (!supabase) return
    setLoading(true)
    setError(false)
    try {
      const { data: d, error: invokeError } = await supabase.functions.invoke('activity', { body: {} })
      if (invokeError || !(d as any)?.ok) throw invokeError ?? new Error('invalid activity response')
      setData(d)
    } catch { setError(true) }
    setLoading(false)
  }
  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    let active = true
    supabase.functions.invoke('activity', { body: {} }).then(({ data: result, error: invokeError }) => {
      if (invokeError || !(result as any)?.ok) throw invokeError ?? new Error('invalid activity response')
      if (active) setData(result)
    }).catch(() => { if (active) setError(true) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const s = data?.summary
  const fmt = (iso: string) => { try { return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) } catch { return iso } }
  const kfmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))
  const pagedRuns = data?.runs?.slice(runPage * runPageSize, (runPage + 1) * runPageSize) ?? []

  return (
    <div className="container-page max-w-6xl py-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet"><BarChart3 size={20} /></span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-text">{t('activityPage.title')}</h1>
            <p className="truncate text-sm text-muted">{t('activityPage.subtitle')}</p>
          </div>
        </div>
        <button onClick={load} className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-ice/12 px-3 py-2 text-xs font-medium text-muted hover:text-text"><RefreshCw size={14} /> <span className="hidden sm:inline">{t('activityPage.refresh')}</span></button>
      </div>

      {loading ? (
        <div className="card mt-5 flex items-center gap-2 rounded-3xl p-6 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> {t('common.loading')}</div>
      ) : error || !data ? (
        <div className="card mt-5 flex items-center justify-between gap-3 rounded-3xl border-danger/25 p-6 text-sm text-danger">
          <span>{error ? t('common.error') : t('activityPage.signInHint')}</span>
          {error && <button onClick={load} className="rounded-lg border border-danger/30 px-3 py-1.5 text-xs hover:bg-danger/10">{t('common.retry')}</button>}
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Kpi icon={PlayCircle} label={t('activityPage.kpiRuns')} value={s.runs} />
            <Kpi icon={ClipboardList} label={t('activityPage.kpiOpenTasks')} value={s.openTasks} />
            <Kpi icon={MessagesSquare} label={t('activityPage.kpiDialogues')} value={s.dialogues} />
            <Kpi icon={Send} label={t('activityPage.kpiQueuedPosts')} value={s.scheduledPosts} />
            <Kpi icon={Bell} label={t('activityPage.kpiNewAlerts')} value={s.unreadAlerts} />
            <Kpi icon={Users} label={t('activityPage.kpiAgents')} value={s.agents + s.subAgents} />
            <Kpi icon={Zap} label={t('activityPage.kpiTokens7d')} value={kfmt(s.tokens7d)} />
          </div>

          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            {/* team runs */}
            <Section icon={PlayCircle} title={t('activityPage.sectionRuns')}>
              {data.runs.length ? pagedRuns.map((r: any, i: number) => (
                <Row key={i} title={r.task} sub={`${fmt(r.created_at)}${r.tokens ? ` ${t('activityPage.tokensSuffix', { count: kfmt(r.tokens) })}` : ''}`} badge={r.kind || 'run'} status={r.status} />
              )) : <Empty text={t('activityPage.emptyRuns')} />}
              {data.runs.length > runPageSize && (
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button aria-label="Previous activity page" onClick={() => setRunPage((p) => Math.max(0, p - 1))} disabled={runPage === 0} className="rounded-lg border border-ice/10 px-2.5 py-1 text-xs text-muted disabled:opacity-40">←</button>
                  <span className="text-[11px] text-muted">{runPage + 1}/{Math.ceil(data.runs.length / runPageSize)}</span>
                  <button aria-label="Next activity page" onClick={() => setRunPage((p) => Math.min(Math.ceil(data.runs.length / runPageSize) - 1, p + 1))} disabled={(runPage + 1) * runPageSize >= data.runs.length} className="rounded-lg border border-ice/10 px-2.5 py-1 text-xs text-muted disabled:opacity-40">→</button>
                </div>
              )}
            </Section>

            {/* tasks */}
            <Section icon={ClipboardList} title={t('activityPage.sectionTasks')} right={<Counts counts={data.tasks.counts} />}>
              {data.tasks.open.length ? data.tasks.open.map((task: any, i: number) => (
                <Row key={i} title={task.title} sub={`${task.assignee_tg || task.assignee_name || t('activityPage.team')}${task.due_at ? ` ${t('activityPage.dueSuffix', { date: fmt(task.due_at) })}` : ''}`} status={task.status} />
              )) : <Empty text={t('activityPage.emptyTasks')} />}
            </Section>

            {/* dialogues */}
            <Section icon={MessagesSquare} title={t('activityPage.sectionDialogues')}>
              {data.dialogues.length ? data.dialogues.map((d: any, i: number) => (
                <Row key={i} title={d.customer_name || t('activityPage.client')} sub={`${d.agent} · ${fmt(d.created_at)}`} status={d.status} />
              )) : <Empty text={t('activityPage.emptyDialogues')} />}
            </Section>

            {/* autopost */}
            <Section icon={Send} title={t('activityPage.sectionAutopost')} right={<Counts counts={data.posts.counts} />}>
              {data.posts.upcoming.length ? data.posts.upcoming.map((p: any, i: number) => (
                <Row key={i} title={p.content} sub={`${p.target_chat} · ${fmt(p.scheduled_at)}`} status="scheduled" />
              )) : <Empty text={t('activityPage.emptyPosts')} />}
            </Section>
          </div>

          {/* team roster */}
          <Section icon={Users} title={t('activityPage.sectionTeam')} className="mt-5">
            <div className="flex flex-wrap gap-2">
              {[...data.team.agents.map((a: any) => ({ name: a.name, role: a.type, status: a.status })), ...data.team.subs.map((sb: any) => ({ name: sb.name, role: sb.role, status: sb.status }))].map((m: any, i: number) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-pill border border-ice/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] text-text">
                  <Bot size={11} className="text-violet" /> {m.name} <span className="text-fog">· {m.role}</span>
                  <span className={cn('h-1.5 w-1.5 rounded-full', (m.status ?? 'active') === 'active' ? 'bg-teal' : 'bg-amber')} />
                </span>
              ))}
              {!data.team.agents.length && !data.team.subs.length && <Empty text={t('activityPage.emptyTeam')} />}
            </div>
          </Section>

          {data.alerts.length > 0 && (
            <Section icon={Bell} title={t('activityPage.sectionAlerts')} className="mt-5">
              {data.alerts.map((a: any, i: number) => (
                <Row key={i} title={a.title} sub={fmt(a.created_at)} badge={a.kind} status={a.read ? 'read' : 'new'} />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  )
}

function Kpi({ icon: Icon, label, value }: { icon: any; label: string; value: number | string }) {
  return (
    <div className="card rounded-2xl p-4">
      <Icon size={16} className="text-violet" />
      <p className="mt-2 text-2xl font-extrabold tabular-nums text-text">{value}</p>
      <p className="text-[11px] leading-tight text-muted">{label}</p>
    </div>
  )
}
function Section({ icon: Icon, title, right, children, className }: { icon: any; title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('card rounded-3xl p-5', className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold text-text"><Icon size={15} className="text-violet" /> {title}</h2>
        {right}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  )
}
function Row({ title, sub, badge, status }: { title: string; sub?: string; badge?: string; status?: string }) {
  const st = statusColor(status)
  return (
    <div className="flex items-start gap-2 rounded-xl border border-ice/[0.06] px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-text">{title}</p>
        {sub && <p className="mt-0.5 truncate text-[11px] text-muted">{sub}</p>}
      </div>
      {badge && <span className="shrink-0 rounded-md bg-violet/10 px-1.5 py-0.5 text-[10px] text-violet">{badge}</span>}
      {status && <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px]', st)}>{status}</span>}
    </div>
  )
}
function Counts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([k]) => k !== '—')
  if (!entries.length) return null
  return <span className="flex gap-1.5 text-[10px]">{entries.map(([k, v]) => <span key={k} className={cn('rounded-full px-1.5 py-0.5', statusColor(k))}>{k}: {v}</span>)}</span>
}
function Empty({ text }: { text: string }) { return <p className="rounded-xl border border-dashed border-ice/10 px-3 py-3 text-center text-[12px] text-fog">{text}</p> }
function statusColor(s?: string): string {
  switch (s) {
    case 'done': case 'posted': case 'resolved': case 'read': return 'bg-teal/10 text-teal'
    case 'failed': case 'overdue': case 'canceled': return 'bg-danger/10 text-danger'
    case 'new': case 'scheduled': case 'todo': case 'open': return 'bg-amber/10 text-amber'
    default: return 'bg-white/[0.05] text-muted'
  }
}
