import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Activity, Bot, CheckSquare, CircleDollarSign, MessageSquare, PlayCircle, Plus, Users, WalletCards, Zap } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { useI18n } from '../../i18n'
import { useBackendStatus } from '../../hooks/useBackendStatus'
import { QuickStart } from '../../components/platform/QuickStart'
import { RecentActivity } from '../../components/platform/RecentActivity'
import { BusinessBriefLauncher } from '../../components/platform/BusinessBriefLauncher'
import { SmartTaskDesk } from '../../components/platform/SmartTaskDesk'

function readLocalStorage(key: string): string {
  try {
    return typeof window === 'undefined' ? '' : window.localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

export default function DashboardPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const isAdmin = useAgentStore((s) => s.isAdmin)
  const backend = useBackendStatus(isAdmin)
  const agents = useAgentStore((s) => s.agents)
  const teams = agents.filter((a) => a.type === 'workflow')
  const standaloneAgents = agents.filter((a) => a.type !== 'workflow')
  const savedTeamId = readLocalStorage('nemo-current-team-id')
  const savedTeamName = readLocalStorage('nemo-team-name')

  // real dashboard metrics (was localStorage/hard-coded demo numbers)
  const [stats, setStats] = useState({ runs: 0, leads: 0, dialogues: 0, approvals: 0 })
  useEffect(() => {
    if (!isSupabaseEnabled || !supabase) return
    let alive = true
    ;(async () => {
      try {
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
        const [r, l, d, a] = await Promise.all([
          supabase!.from('research_runs').select('id', { count: 'exact', head: true }),
          supabase!.from('leads').select('id', { count: 'exact', head: true }).gte('created_at', startOfDay.toISOString()),
          supabase!.from('dialogues').select('id', { count: 'exact', head: true }),
          supabase!.functions.invoke('approval-queue', { body: { action: 'list' } }),
        ])
        const approvalPayload = a.data as { requests?: { status: string }[] } | null
        if (alive) setStats({ runs: r.count ?? 0, leads: l.count ?? 0, dialogues: d.count ?? 0, approvals: approvalPayload?.requests?.filter((item) => item.status === 'pending').length ?? 0 })
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [])

  const createCourseConsultant = () => {
    localStorage.setItem('nemo-selected-agent-template', JSON.stringify({
      name: 'Sales Consultant',
      type: 'qualifier',
      role: 'AI Sales Consultant',
      tasks: 'Recommend products or services based on customer goals, budget, and language preference. Collect contact details and next actions.',
      tone: 'Professional, friendly, and solution-oriented.',
    }))
    navigate('/app/create-agent')
  }

  const createOperationsTeam = () => {
    localStorage.setItem('nemo-selected-template', JSON.stringify({
      teamName: 'Operations Team',
      teamType: 'education-admin',
      goal: 'Routine admin and operations automation: payment reminders, admin escalation, meeting-to-tasks, weekly follow-up and manager reports.',
      template: 'Operations Team',
      selectedAt: new Date().toISOString(),
    }))
    navigate('/app/create-team')
  }

  const runDemo = (type: 'payment-control' | 'meeting-to-tasks') => {
    localStorage.setItem('nemo-demo-workflow-request', type)
    navigate('/app/run-workflow')
  }

  return (
    <div className="container-page max-w-7xl !px-3 py-6 sm:!px-8 sm:py-8">
      <SmartTaskDesk />

      <details className="group mt-5">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl border border-ice/[0.07] bg-card/[0.02] px-4 py-3 text-sm font-semibold text-muted transition hover:border-ice/[0.13] hover:text-text marker:content-none">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet/10 text-violet"><Activity size={15} /></span>
          <span className="min-w-0 flex-1"><span className="block">{t('smartTaskDesk.workspaceOverview')}</span><span className="mt-0.5 block text-[11px] font-normal text-fog">{t('smartTaskDesk.workspaceOverviewHint')}</span></span>
          <span className="text-xs transition-transform group-open:rotate-180">⌄</span>
        </summary>
        <div className="pt-7 animate-fadeIn">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="mono-label">{t('mvp.dashboard.eyebrow')}</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-text">{t('mvp.dashboard.title')}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t('mvp.dashboard.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button to="/app/create-team"><Plus size={16} /> {t('mvp.dashboard.createTeam')}</Button>
          <Button to="/app/run-workflow" variant="outline"><PlayCircle size={16} /> {t('mvp.dashboard.runDemo')}</Button>
        </div>
      </div>

      <QuickStart />

      <BusinessBriefLauncher />

      <section className="mt-8" aria-labelledby="owner-metrics-title">
        <div className="flex items-end justify-between gap-3">
          <div><p className="mono-label">{t('dashboardOwner.eyebrow')}</p><h2 id="owner-metrics-title" className="mt-1 text-xl font-bold text-text">{t('dashboardOwner.title')}</h2></div>
          <Link to="/app/approvals" className="text-xs font-semibold text-cyan hover:text-text">{t('dashboardOwner.openApprovals')}</Link>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric icon={CircleDollarSign} label={t('dashboardOwner.savings')} value="-" hint={t('dashboardOwner.savingsHint')} />
          <Metric icon={Users} label={t('dashboardOwner.newLeads')} value={String(stats.leads)} />
          <Metric icon={WalletCards} label={t('dashboardOwner.contentSpend')} value="-" hint={t('dashboardOwner.contentSpendHint')} />
          <Metric icon={CheckSquare} label={t('dashboardOwner.awaitingApproval')} value={String(stats.approvals)} />
        </div>
      </section>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={Users} label={t('mvp.dashboard.activeTeams')} value={String(Math.max(teams.length, savedTeamId ? 1 : 0))} />
        <Metric icon={Bot} label={t('mvp.dashboard.activeAgents')} value={String(standaloneAgents.length)} />
        <Metric icon={PlayCircle} label={t('mvp.dashboard.workflowsRun')} value={String(stats.runs)} />
        <Metric icon={MessageSquare} label={t('mvp.dashboard.dialogues')} value={String(stats.dialogues)} />
      </div>

      {isAdmin && <section className="card mt-6 rounded-3xl p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="mono-label">Backend status</p>
            <h2 className="mt-2 text-xl font-bold text-text">Runtime readiness</h2>
            <p className="mt-1 text-xs text-muted">{backend.reason}</p>
          </div>
          <span className={`rounded-pill border px-3 py-1 text-xs font-medium ${backend.liveWorkflowReady ? 'border-teal/20 bg-teal/10 text-teal' : 'border-amber/25 bg-amber/10 text-amber'}`}>
            {backend.liveWorkflowReady ? 'Live backend' : backend.mode === 'not_configured' ? 'Not configured' : 'Local simulation'}
          </span>
        </div>
        <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-6">
          <Status label="Auth" ok={backend.authReady} good="connected" bad="missing" />
          <Status label="Account" ok={backend.accountReady} good="ready" bad="missing" />
          <Status label="Supabase" ok={backend.supabaseReady} good="connected" bad="demo" />
          <Status label="LLM provider" ok={backend.llmReady} good="configured" bad="missing" />
          <Status label="Workflow mode" ok={backend.liveWorkflowReady} good="live backend" bad="local simulation" />
          <Status label="Provider keys" ok={backend.providerKeysSecure} good="secure storage" bad="demo-only" />
        </div>
      </section>}

      <section className="card mt-8 rounded-3xl p-4 sm:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="mono-label">{t('mvp.pilot.eyebrow')}</p>
            <h2 className="mt-2 text-2xl font-extrabold text-text">{t('mvp.pilot.title')}</h2>
            <p className="mt-1 text-sm text-muted">{t('mvp.pilot.subtitle')}</p>
          </div>
          <Button to="/app/templates" variant="outline">{t('mvp.pilot.openTemplates')}</Button>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-4">
          <PilotAction n="01" title={t('mvp.pilot.courseConsultant')} desc={t('mvp.pilot.courseConsultantDesc')} onClick={createCourseConsultant} />
          <PilotAction n="02" title={t('mvp.pilot.operationsTeam')} desc={t('mvp.pilot.operationsTeamDesc')} onClick={createOperationsTeam} />
          <PilotAction n="03" title={t('mvp.pilot.paymentDemo')} desc={t('mvp.pilot.paymentDemoDesc')} onClick={() => runDemo('payment-control')} />
          <PilotAction n="04" title={t('mvp.pilot.meetingDemo')} desc={t('mvp.pilot.meetingDemoDesc')} onClick={() => runDemo('meeting-to-tasks')} />
        </div>
      </section>

      <div className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <section className="card min-w-0 rounded-3xl p-4 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-text">{t('mvp.dashboard.teamsTitle')}</h2>
              <p className="mt-1 text-sm text-muted">{t('mvp.dashboard.teamsDesc')}</p>
            </div>
            <Button to="/app/teams" size="sm" variant="outline" className="shrink-0">{t('mvp.dashboard.openTeams')}</Button>
          </div>
          <div className="mt-5 space-y-3">
            {teams.length === 0 && !savedTeamId ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center">
                <p className="text-sm text-muted">{t('mvp.dashboard.empty')}</p>
                <Button to="/app/create-team" size="sm" className="mt-4"><Plus size={14} /> {t('mvp.dashboard.createFirst')}</Button>
              </div>
            ) : (
              <Link to={savedTeamId ? `/app/teams/${savedTeamId}` : '/app/teams'} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4 hover:border-violet/40">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet"><Users size={20} /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-text">{savedTeamName || teams[0]?.name || 'AI Sales Team'}</p>
                  <p className="mt-1 text-xs text-muted">{t('mvp.dashboard.ready')}</p>
                </div>
                <span className="shrink-0 rounded-pill border border-teal/20 bg-teal/10 px-3 py-1 text-xs text-teal">{t('mvp.dashboard.active')}</span>
              </Link>
            )}
          </div>
        </section>

        <section className="card min-w-0 rounded-3xl p-4 sm:p-6">
          <div className="flex items-center gap-2"><Activity className="text-cyan" size={18} /><h2 className="text-xl font-bold text-text">{t('mvp.dashboard.latest')}</h2></div>
          <RecentActivity />
        </section>
      </div>
        </div>
      </details>
    </div>
  )
}

function Metric({ icon: Icon, label, value, hint }: { icon: typeof Zap; label: string; value: string; hint?: string }) {
  return <div className="card rounded-3xl p-4 sm:p-5"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet/15 text-violet"><Icon size={18} /></span><p className="mt-4 text-3xl font-extrabold text-text">{value}</p><p className="mt-1 text-sm text-muted">{label}</p>{hint && <p className="mt-2 text-[11px] leading-4 text-fog">{hint}</p>}</div>
}

function Status({ label, ok, good, bad }: { label: string; ok: boolean; good: string; bad: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3"><p className="font-semibold text-text">{label}</p><p className={ok ? 'mt-1 text-teal' : 'mt-1 text-amber'}>{ok ? good : bad}</p></div>
}

function PilotAction({ n, title, desc, onClick }: { n: string; title: string; desc: string; onClick: () => void }) {
  return <button onClick={onClick} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-left hover:border-cyan/30"><p className="text-xs font-bold text-cyan">{n}</p><h3 className="mt-3 font-semibold text-text">{title}</h3><p className="mt-1 text-xs leading-relaxed text-muted">{desc}</p></button>
}
