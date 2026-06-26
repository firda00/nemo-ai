import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { MessagesSquare, UserPlus, Zap, Clock, Plus, Coins, ArrowUpRight } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAuth } from '../../context/AuthContext'
import { useAgentStore } from '../../store/useAgentStore'
import { mockDialogues, analytics } from '../../data/platform'
import { channelMeta, channelLabel, agentStatusStyle, dialogueStatusStyle } from '../../lib/platformMeta'
import { fetchLiveSummary, type LiveSummary } from '../../lib/liveData'
import { isSupabaseEnabled } from '../../lib/supabase'
import { AgentAvatar } from '../../components/ui/AgentAvatar'
import { Button } from '../../components/ui/Button'
import { Skeleton } from '../../components/ui/Skeleton'
import { cn } from '../../lib/cn'
import type { LucideIcon } from 'lucide-react'

function Metric({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: string }) {
  return (
    <div className="card rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', tone)}>
          <Icon size={18} />
        </span>
      </div>
      <p className="mt-4 text-2xl font-normal text-text">{value}</p>
      <p className="mt-0.5 text-xs text-muted">{label}</p>
    </div>
  )
}

export default function DashboardPage() {
  const { t } = useI18n()
  const { user } = useAuth()
  const agents = useAgentStore((s) => s.agents)
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<LiveSummary | null>(null)

  useEffect(() => {
    if (isSupabaseEnabled) {
      fetchLiveSummary().then((s) => {
        setSummary(s)
        setLoading(false)
      })
      return
    }
    const id = setTimeout(() => setLoading(false), 600)
    return () => clearTimeout(id)
  }, [])

  const recent = (isSupabaseEnabled ? summary?.dialogues ?? [] : mockDialogues).slice(0, 4)
  const mDialogues = isSupabaseEnabled ? String(summary?.total ?? 0) : '55'
  const mLeads = isSupabaseEnabled ? String(summary?.leads ?? 0) : '12'
  const mAuto = `${isSupabaseEnabled ? summary?.resolvedPct ?? 0 : analytics.metrics.resolvedPct}%`
  const mResp = isSupabaseEnabled ? '—' : `${analytics.metrics.avgResponseSec}${t('platform.analytics.sec')}`

  return (
    <div className="container-page max-w-6xl py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-normal tracking-tight text-text">
            {t('common.brand')}, {user?.name} 👋
          </h1>
          <p className="mt-1 text-sm text-muted">{t('platform.dashboard.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button to="/onboarding" size="sm">
            <Plus size={15} /> {t('platform.dashboard.quickCreate')}
          </Button>
          <Button to="/app/billing" size="sm" variant="ghost">
            <Coins size={15} /> {t('platform.dashboard.quickTopup')}
          </Button>
        </div>
      </div>

      {/* metrics */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[116px] rounded-2xl" />)
        ) : (
          <>
            <Metric icon={MessagesSquare} label={t('platform.dashboard.mDialogues')} value={mDialogues} tone="bg-violet/15 text-violet" />
            <Metric icon={UserPlus} label={t('platform.dashboard.mLeads')} value={mLeads} tone="bg-blue/15 text-blue" />
            <Metric icon={Zap} label={t('platform.dashboard.mAuto')} value={mAuto} tone="bg-teal/15 text-teal" />
            <Metric icon={Clock} label={t('platform.dashboard.mResp')} value={mResp} tone="bg-amber/15 text-amber" />
          </>
        )}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-3">
        {/* recent dialogues */}
        <section className="card rounded-2xl lg:col-span-2">
          <div className="flex items-center justify-between border-b border-ice/[0.07] px-5 py-3.5">
            <h2 className="font-normal text-text">{t('platform.dashboard.recent')}</h2>
            <Link to="/app/dialogues" className="text-xs font-normal text-violet hover:underline">
              {t('platform.dashboard.viewAll')}
            </Link>
          </div>
          {loading ? (
            <div className="space-y-3 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : (
            <ul className="divide-y divide-ice/[0.05]">
              {recent.map((d) => {
                const meta = channelMeta[d.channel]
                return (
                  <li key={d.id}>
                    <Link to={`/app/dialogues?d=${d.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-ice/[0.03]">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: `${meta.color}22`, color: meta.color }}>
                        <meta.Icon size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-normal text-text">{d.customerName}</p>
                        <p className="truncate text-xs text-muted">{d.messages[d.messages.length - 1]?.content}</p>
                      </div>
                      <span className={cn('hidden shrink-0 rounded-full px-2 py-0.5 text-[10px] font-normal sm:inline', dialogueStatusStyle[d.status])}>
                        {t(`platform.dialogues.status${d.status === 'needs_operator' ? 'NeedsOp' : d.status.charAt(0).toUpperCase() + d.status.slice(1)}`)}
                      </span>
                      <span className="text-[11px] text-muted">{d.updatedAt}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* agent status */}
        <section className="card rounded-2xl">
          <div className="border-b border-ice/[0.07] px-5 py-3.5">
            <h2 className="font-normal text-text">{t('platform.dashboard.agentStatus')}</h2>
          </div>
          <ul className="space-y-1 p-3">
            {agents.map((a) => (
              <li key={a.id}>
                <Link to={`/app/agents/${a.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-ice/[0.04]">
                  <AgentAvatar color={a.avatarColor} glyph="search" size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-normal text-text">{a.name}</p>
                    <p className="truncate text-[11px] text-muted">
                      {a.channels.map((c) => channelLabel(c, t)).join(', ') || '—'}
                    </p>
                  </div>
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-normal', agentStatusStyle[a.status])}>
                    {t(`platform.agentStatus.${a.status}`)}
                  </span>
                </Link>
              </li>
            ))}
            <li className="px-2 pt-1">
              <Link to="/onboarding" className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm font-medium text-violet hover:bg-ice/[0.04]">
                <Plus size={15} /> {t('platform.dashboard.quickCreate')} <ArrowUpRight size={14} />
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </div>
  )
}
