import { useEffect, useState } from 'react'
import { MessagesSquare, Clock, CheckCircle2, UserPlus, Star, Users, MousePointerClick, MessageCircle, Bug, Mail } from 'lucide-react'
import { useI18n } from '../../i18n'
import { analytics } from '../../data/platform'
import { channelLabel } from '../../lib/platformMeta'
import { fetchLiveSummary, type LiveSummary } from '../../lib/liveData'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { AreaChart, BarList } from '../../components/ui/Chart'
import { cn } from '../../lib/cn'
import type { LucideIcon } from 'lucide-react'
import type { ChannelType } from '../../types/platform'
import { Skeleton } from '../../components/ui/Skeleton'

function Metric({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: string }) {
  return (
    <div className="card rounded-2xl p-5">
      <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', tone)}>
        <Icon size={18} />
      </span>
      <p className="mt-4 text-2xl font-normal text-text">{value}</p>
      <p className="mt-0.5 text-xs text-muted">{label}</p>
    </div>
  )
}

export default function AnalyticsPage() {
  const { t } = useI18n()
  const [range, setRange] = useState<7 | 14 | 30>(14)
  const m = analytics.metrics
  const live = isSupabaseEnabled
  const [summary, setSummary] = useState<LiveSummary | null>(null)
  const [loadingSummary, setLoadingSummary] = useState(live)
  const [product, setProduct] = useState({ events: 0, feedback: 0, errors: 0, emailDrafts: 0 })
  useEffect(() => {
    if (live) fetchLiveSummary().then(setSummary).finally(() => setLoadingSummary(false))
  }, [live])
  useEffect(() => {
    if (!live || !supabase) return
    const since = new Date(Date.now() - range * 86400000).toISOString()
    Promise.all([
      supabase.from('product_events').select('*', { count: 'exact', head: true }).gte('created_at', since),
      supabase.from('customer_feedback').select('*', { count: 'exact', head: true }).gte('created_at', since),
      supabase.from('client_errors').select('*', { count: 'exact', head: true }).gte('created_at', since),
      supabase.from('product_events').select('*', { count: 'exact', head: true }).eq('name', 'email_draft_created').gte('created_at', since),
    ]).then(([events, feedback, errors, drafts]) => setProduct({ events: events.count ?? 0, feedback: feedback.count ?? 0, errors: errors.count ?? 0, emailDrafts: drafts.count ?? 0 }))
  }, [live, range])

  const ranges: { v: 7 | 14 | 30; label: string }[] = [
    { v: 7, label: t('platform.analytics.r7') },
    { v: 14, label: t('platform.analytics.r14') },
    { v: 30, label: t('platform.analytics.r30') },
  ]

  const vDialogues = live ? String(summary?.total ?? 0) : String(m.dialogues)
  const vResp = live
    ? (summary?.avgResponseSec != null ? `${summary.avgResponseSec}${t('platform.analytics.sec')}` : '—')
    : `${m.avgResponseSec}${t('platform.analytics.sec')}`
  const vResolved = `${live ? summary?.resolvedPct ?? 0 : m.resolvedPct}%`
  const vLead = `${live ? summary?.leadConvPct ?? 0 : m.leadConvPct}%`
  // 5th tile: real leads count in live mode, satisfaction in the demo
  const fifthIcon = live ? Users : Star
  const fifthLabel = live ? t('platform.analytics.fleads') : t('platform.analytics.mSat')
  // Never show seeded demo leads while a live summary is still loading or failed.
  const fifthValue = live ? String(summary?.leads ?? 0) : `${m.satisfaction}/5`

  const daily = live
    ? (summary?.daily ?? []).slice(-range)
    : range === 7
      ? analytics.daily.slice(-7)
      : range === 30
        ? [...analytics.daily, ...analytics.daily.slice(0, 16)]
        : analytics.daily
  const channelSource = live ? summary?.byChannel ?? [] : analytics.channels
  const channelItems = channelSource.map((c) => ({ label: channelLabel(c.channel as ChannelType, t), value: c.value }))
  const funnel = live
    ? [
        { label: 'dialogues', value: summary?.total ?? 0 },
        { label: 'leads', value: summary?.leads ?? 0 },
        { label: 'orders', value: summary?.resolved ?? 0 },
      ]
    : analytics.funnel
  const funnelMax = funnel[0]?.value || 1

  return (
    <div className="container-page max-w-6xl py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-normal tracking-tight text-text">{t('platform.nav.analytics')}</h1>
          <p className="mt-1 text-sm text-muted">{t('platform.analytics.subtitle')}</p>
        </div>
        <div className="inline-flex gap-1 rounded-xl bg-ice/[0.05] p-1">
          {ranges.map((r) => (
            <button key={r.v} onClick={() => setRange(r.v)} className={cn('rounded-lg px-3 py-1.5 text-xs font-normal transition-all', range === r.v ? 'bg-ice/[0.1] text-text' : 'text-muted hover:text-text')}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loadingSummary ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5" aria-label={t('common.loading')}>
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32 rounded-2xl" />)}
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Metric icon={MessagesSquare} label={t('platform.analytics.mDialogues')} value={vDialogues} tone="bg-violet/15 text-violet" />
          <Metric icon={Clock} label={t('platform.analytics.mResp')} value={vResp} tone="bg-blue/15 text-blue" />
          <Metric icon={CheckCircle2} label={t('platform.analytics.mResolved')} value={vResolved} tone="bg-teal/15 text-teal" />
          <Metric icon={UserPlus} label={t('platform.analytics.mLead')} value={vLead} tone="bg-cyan/15 text-cyan" />
          <Metric icon={fifthIcon} label={fifthLabel} value={fifthValue} tone="bg-amber/15 text-amber" />
        </div>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-3">
        <section className="card rounded-2xl p-5 lg:col-span-2">
          <h2 className="font-normal text-text">{t('platform.analytics.volume')}</h2>
          <div className="mt-5">
            <AreaChart data={daily} height={170} />
          </div>
        </section>
        <section className="card rounded-2xl p-5">
          <h2 className="mb-4 font-normal text-text">{t('platform.analytics.byChannel')}</h2>
          <BarList items={channelItems} />
        </section>
      </div>

      <section className="card mt-5 rounded-2xl p-5">
        <h2 className="mb-4 font-normal text-text">{t('platform.analytics.funnel')}</h2>
        <div className="space-y-2.5">
          {funnel.map((f, i) => (
            <div key={f.label} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-xs text-muted">{t(`platform.analytics.f${f.label}`)}</span>
              <div className="h-8 flex-1 overflow-hidden rounded-lg bg-ice/[0.04]">
                <div className={cn('flex h-full items-center justify-end rounded-lg pr-3 text-xs font-normal text-ice', ['bg-violet', 'bg-blue', 'bg-cyan', 'bg-teal'][i % 4])} style={{ width: `${(f.value / funnelMax) * 100}%` }}>
                  {f.value}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {live && <section className="mt-5">
        <div className="mb-3"><h2 className="font-normal text-text">Как люди используют Nemo</h2><p className="mt-1 text-xs text-muted">События продукта, отзывы и ошибки за выбранный период. Тексты писем и пароли сюда не попадают.</p></div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric icon={MousePointerClick} label="Действия в продукте" value={String(product.events)} tone="bg-violet/15 text-violet" />
          <Metric icon={MessageCircle} label="Получено отзывов" value={String(product.feedback)} tone="bg-teal/15 text-teal" />
          <Metric icon={Bug} label="Ошибки интерфейса" value={String(product.errors)} tone={product.errors ? 'bg-rose-400/15 text-rose-300' : 'bg-teal/15 text-teal'} />
          <Metric icon={Mail} label="Email-черновики" value={String(product.emailDrafts)} tone="bg-blue/15 text-blue" />
        </div>
      </section>}
    </div>
  )
}
