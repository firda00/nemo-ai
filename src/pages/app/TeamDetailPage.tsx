import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Users, Bot, ClipboardList, BellRing, GitBranch, ChevronDown, Send, Users2, Truck, Loader2, LayoutDashboard, Network, History, Settings2, PanelRightClose, PanelRightOpen, X, Activity, FileText, CircleDot } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { PROVIDERS } from '../../data/platform'
import { useAgentStore } from '../../store/useAgentStore'
import { Markdown } from '../../components/ui/Markdown'
import { OpsWorkflowRunner, type OpsKind } from '../../components/platform/OpsWorkflowRunner'
import { AutonomousRunner } from '../../components/platform/AutonomousRunner'
import { TelegramBotConnect } from '../../components/platform/TelegramBotConnect'
import { PlanerkaSheetCard } from '../../components/platform/PlanerkaSheetCard'
import { PlanerkaMembersCard } from '../../components/platform/PlanerkaMembersCard'
import { SAMPLE_PAYMENT, SAMPLE_MEETING, SAMPLE_RETENTION } from '../../lib/dynamicTeams'
import { SAMPLE_LOGISTICS } from '../../lib/commerceTeams'
import { cn } from '../../lib/cn'
import { TeamOfficeView } from '../../components/office/TeamOfficeView'
import type { AgentNodeData } from '../../types/orchestrator'
import { LiveCodeSandboxArtifact } from '../../components/platform/LiveCodeSandboxArtifact'
import { isCodeCreationIntent } from '../../lib/codeCreationIntent'
import { teamDisplayName } from '../../lib/teamDisplayName'
import { StoreSnapshotArtifact } from '../../components/platform/StoreSnapshotArtifact'
import { isStoreSnapshotIntent } from '../../lib/storeArtifactIntent'
import { isAnalyticalArtifactIntent } from '../../lib/analyticalArtifactIntent'
import { AnalyticalReportArtifact } from '../../components/platform/AnalyticalReportArtifact'
import { isTeamQuickReplyIntent } from '../../lib/teamQuickReplyIntent'

interface Sub { id: string; role: string; name: string; model: string; skills?: string[]; prompt: { role?: string; tasks?: string } }
interface Dept { id: string; name: string; niche?: string; subs: Sub[] }
interface Task { id: string; title: string; owner?: string; deadline?: string; priority?: string; status?: string }
interface Notif { id: string; title: string; body?: string; risk?: string; target?: string; created_at: string }
interface RunStep {
  query: string
  findings: string
  review?: {
    reviewed_by?: string
    approved?: boolean
    score?: number
    issues?: string[]
    revised?: boolean
    revisions?: number
    needs_human_review?: boolean
  }
}
interface Run { id: string; task: string; kind: string; status?: string; human_review_status?: 'pending' | 'approved' | 'rejected' | null; report?: string; steps?: RunStep[]; created_at: string }

const COLORS = ['#22D3EE', '#5B7CF6', '#8B7CF8', '#13C5B4', '#F4A640', '#EC6CB0']
const statusCls = (s?: string) => (s === 'overdue' ? 'bg-danger/15 text-danger' : s === 'done' ? 'bg-teal/15 text-teal' : s === 'in_progress' ? 'bg-cyan/15 text-cyan' : 'bg-white/[0.06] text-muted')

export default function TeamDetailPage() {
  const { id } = useParams()
  const { lang, t } = useI18n()
  const team = useAgentStore((s) => s.agents.find((a) => a.id === id))
  const hydrated = useAgentStore((s) => s.hydrated)

  const [dept, setDept] = useState<Dept | null>(null)
  const [loading, setLoading] = useState(isSupabaseEnabled)
  const [kind, setKind] = useState<OpsKind>('payment_control')
  const [tasks, setTasks] = useState<Task[]>([])
  const [notifs, setNotifs] = useState<Notif[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [savingSubModel, setSavingSubModel] = useState<string | null>(null)
  const [modelMsg, setModelMsg] = useState('')
  const [modelOk, setModelOk] = useState(false)
  const [tgConnected, setTgConnected] = useState(false)
  const [groupConnected, setGroupConnected] = useState(false)
  const [subBots, setSubBots] = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab] = useState<'overview' | 'graph' | 'runs'>('overview')
  const [telegramOpen, setTelegramOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1180)
  const [selectedSub, setSelectedSub] = useState<Sub | null>(null)
  const [pendingTask, setPendingTask] = useState<string | null>(null)
  const [runnerStatus, setRunnerStatus] = useState<'idle' | 'queued' | 'running' | 'completed' | 'failed'>('idle')
  const [fastStoreArtifact, setFastStoreArtifact] = useState<{ task: string; runRef: string } | null>(null)
  const [fastReply, setFastReply] = useState<{ loading: boolean; text: string; error: boolean } | null>(null)
  const streamEndRef = useRef<HTMLDivElement | null>(null)

  const loadResults = useCallback(async (deptId: string) => {
    if (!supabase) return
    const [{ data: t }, { data: n }, { data: r }] = await Promise.all([
      supabase.from('tasks').select('*').eq('department_id', deptId).order('created_at', { ascending: false }).limit(40),
      supabase.from('notifications').select('*').eq('department_id', deptId).order('created_at', { ascending: false }).limit(20),
      supabase.from('research_runs').select('id, task, kind, status, human_review_status, report, steps, created_at').eq('department_id', deptId).order('created_at', { ascending: false }).limit(10),
    ])
    setTasks((t ?? []) as Task[])
    setNotifs((n ?? []) as Notif[])
    setRuns((r ?? []) as Run[])
  }, [])

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase || !id) {
      if (id) {
        try {
          const raw = window.localStorage.getItem(`nemo-team-blueprint:${id}`)
          if (raw) {
            const saved = JSON.parse(raw) as { departmentId?: string; name?: string; goal?: string; members?: Array<{ name: string; role: string; skills?: string[]; prompt?: { role?: string; tasks?: string } }> }
            const savedMembers = saved.members ?? []
            if (savedMembers.length) window.setTimeout(() => setDept({
              id: saved.departmentId || `demo-${id}`,
              name: saved.name || 'AI Team',
              niche: saved.goal,
              subs: savedMembers.map((member, index) => ({ id: `${id}-member-${index}`, name: member.name, role: member.role, skills: member.skills, prompt: member.prompt ?? {}, model: 'openai/gpt-4o-mini' })),
            }), 0)
          }
        } catch { /* optional demo persistence */ }
      }
      window.setTimeout(() => setLoading(false), 0)
      return
    }
    let on = true
    ;(async () => {
      // Load saved channel state before the optional department structure. A
      // team without a department can still own a master Telegram bot.
      const { data: chs } = await supabase!.from('channels').select('sub_agent_id, scope').eq('agent_id', id).eq('type', 'telegram').eq('status', 'connected')
      if (on) {
        const list = (chs ?? []) as { sub_agent_id: string | null; scope: string | null }[]
        setSubBots(new Set(list.filter((c) => c.sub_agent_id).map((c) => c.sub_agent_id as string)))
        setGroupConnected(list.some((c) => c.scope === 'group'))
        setTgConnected(list.some((c) => !c.sub_agent_id && c.scope !== 'group'))
      }
      const { data: depts } = await supabase!.from('departments').select('*').eq('main_agent_id', id).order('created_at', { ascending: false }).limit(1)
      const d = depts?.[0]
      if (!d) {
        if (on) { setDept(null); setLoading(false) }
        return
      }
      const { data: subs } = await supabase!.from('sub_agents').select('*').eq('department_id', d.id).order('created_at', { ascending: true })
      if (!on) return
      setDept({ id: d.id, name: d.name, niche: d.niche ?? undefined, subs: (subs ?? []) as Sub[] })
      setLoading(false)
      await loadResults(d.id)
    })()
    return () => { on = false }
  }, [id, loadResults])

  const goal = team?.purpose || 'Automate routine operations: payments, admin escalation, meetings-to-tasks and manager reports.'
  const teamName = teamDisplayName({ name: team?.name || dept?.name, goal, niche: team?.niche || dept?.niche, tasks: team?.prompt.tasks, lang })
  const latestRun = runs[0]
  const graphRuntimeStatus: AgentNodeData['status'] = runnerStatus === 'running' ? 'working' : runnerStatus === 'queued' ? 'queued' : runnerStatus === 'failed' ? 'failed' : runnerStatus === 'completed' || latestRun ? 'completed' : 'idle'
  const graphLead: AgentNodeData = {
    id: id ?? dept?.id ?? 'team-lead', name: teamName, role: lang === 'ru' ? 'Координатор команды' : lang === 'uz' ? 'Jamoa koordinatori' : 'Team coordinator', avatar: COLORS[0], status: graphRuntimeStatus,
    currentTask: runnerStatus === 'running' || runnerStatus === 'queued' ? (lang === 'ru' ? 'Выполняет текущую задачу' : lang === 'uz' ? 'Joriy vazifani bajarmoqda' : 'Running current task') : undefined,
    tools: team?.skills ?? [], metrics: { tasksCompleted: runs.length, avgExecutionTimeMs: 0 }, model: team?.model, provider: team?.model?.split('/')[0] ?? 'configured', configurationSummary: goal,
  }
  const permanentGraphAgents: AgentNodeData[] = (dept?.subs ?? []).map((sub, index) => ({
    id: sub.id,
    name: sub.name,
    role: sub.role,
    avatar: COLORS[index % COLORS.length],
    status: graphRuntimeStatus,
    tools: sub.skills ?? [],
    metrics: { tasksCompleted: runs.filter((run) => (run.steps?.length ?? 0) > index).length, avgExecutionTimeMs: 0 },
    model: sub.model,
    provider: sub.model?.includes('/') ? sub.model.split('/')[0] : 'configured',
    configurationSummary: sub.prompt?.tasks || sub.prompt?.role || sub.role,
    parentId: graphLead.id,
  }))
  const temporaryGraphAgents: AgentNodeData[] = (latestRun?.steps ?? []).slice(permanentGraphAgents.length).map((step, index) => {
    const role = step.query.split(':')[0]?.trim() || (lang === 'ru' ? 'Профильный эксперт' : lang === 'uz' ? 'Maxsus ekspert' : 'Task specialist')
    return {
      id: `run:${latestRun?.id}:${index}`, name: role, role: lang === 'ru' ? 'Временный субагент задачи' : lang === 'uz' ? 'Vazifaning vaqtinchalik subagenti' : 'Temporary task subagent', avatar: COLORS[(permanentGraphAgents.length + index + 1) % COLORS.length], status: 'completed',
      tools: [], metrics: { tasksCompleted: 1, avgExecutionTimeMs: 0 }, provider: 'runtime', configurationSummary: step.query, parentId: graphLead.id,
    }
  })
  const graphAgents: AgentNodeData[] = [graphLead, ...permanentGraphAgents, ...temporaryGraphAgents]
  const tabCopy = lang === 'uz' ? {
    overview: 'Boshqaruv va vazifalar', graph: 'Hamkorlik sxemasi', runs: 'Ishga tushirish tarixi',
  } : lang === 'en' ? {
    overview: 'Management & tasks', graph: 'A2A orchestration', runs: 'Runs & traces',
  } : {
    overview: 'Управление и задачи', graph: 'Схема взаимодействия', runs: 'История запусков',
  }

  // Show operational workflows only for teams that were created for that work.
  // Content, sales and store teams keep the universal "task the team" runner.
  const teamBlob = `${team?.name ?? ''} ${team?.purpose ?? ''} ${team?.niche ?? ''} ${dept?.name ?? ''} ${dept?.niche ?? ''} ${(dept?.subs ?? []).map((s) => `${s.role} ${s.prompt?.tasks ?? ''}`).join(' ')}`.toLowerCase()
  const explicitWorkflowMode = teamBlob.match(/nemo-workflow:(generic|operations|logistics)/)?.[1]
  const isRegulated = team?.riskTier === 'regulated' || /nemo-risk:regulated/.test(teamBlob)
  const isLogistics = explicitWorkflowMode === 'logistics' || (!explicitWorkflowMode && /logistics?|логист|shipment|carrier|доставк|fulfillment|sla monitor/.test(teamBlob))
  const isMarketplaceWorkspace = /uzum|marketplace|маркетплейс|маркетплейс|marketplace seller team/.test(teamBlob)
  const isCommerceWorkspace = isMarketplaceWorkspace || /dropshipping team|online store team/.test(teamBlob)
  const isOps = isLogistics
    || explicitWorkflowMode === 'operations'
    || (!explicitWorkflowMode && !isCommerceWorkspace && /\boperations?\b|\bops\b|оплат|payment|платеж|ученик|студент|student|посещ|attendance|retention|churn|уход|неоплат|meeting|совещ|встреч|отчёт по задач|task manager|admin control|payment reminder/.test(teamBlob))
  const workflowKind: OpsKind = isLogistics ? 'logistics_control' : kind === 'logistics_control' ? 'payment_control' : kind
  const marketplaceDefaultGoal = isMarketplaceWorkspace
    ? lang === 'uz'
      ? 'Ulangan Uzum do‘konimning boshlang‘ich auditini o‘tkazing. Server Uzumdan olgan faktlar bilan ishlang: do‘konlar, SKU, narx, qoldiq va mavjud bo‘lsa 7 kunlik sotuvni ko‘rsating. Har SKU uchun scale, keep, fix, clear, pause yoki insufficient data tasnifini va dalilni bering. 7 kunlik aniq harakatlar rejasini, xarid uchun yetishmayotgan ma’lumotlar ro‘yxatini hamda tasdiqlashimni kutadigan qarorlarni tayyorlang. Narx, qoldiq, karta, reklama, xarid, FBS/FBO yoki yetkazib berishni o‘zgartirmang. 300% o‘sishni va’da qilmang.'
      : lang === 'en'
        ? 'Run the first audit of my connected Uzum store. Use only server-fetched Uzum facts: shops, SKUs, price, stock and, if available, seven-day sales. Classify every SKU as scale, keep, fix, clear, pause or insufficient data and cite the evidence. Produce a concrete seven-day action plan, the missing data needed for purchase decisions, and a list of decisions awaiting my approval. Do not change prices, stock, listings, ads, purchases, FBS/FBO or delivery settings. Do not promise 300% growth.'
        : 'Проведите стартовый аудит подключённого магазина Uzum. Используйте только факты, которые сервер получил из Uzum: магазины, SKU, цену, остаток и, если доступны, продажи за 7 дней. Для каждого SKU укажите класс scale, keep, fix, clear, pause или insufficient data и основание. Подготовьте конкретный план на 7 дней, список недостающих данных для закупок и решения, ожидающие моего подтверждения. Не меняйте цены, остатки, карточки, рекламу, закупки, FBS/FBO и настройки доставки. Не обещайте рост на 300%.'
    : undefined

  const updateSubModel = async (subId: string, model: string) => {
    if (!supabase || !dept || !model) return
    const previous = dept.subs.find((sub) => sub.id === subId)?.model
    if (!previous || previous === model) return
    setSavingSubModel(subId)
    setModelMsg('')
    const { error } = await supabase.from('sub_agents').update({ model }).eq('id', subId).eq('department_id', dept.id)
    if (error) {
      setModelOk(false)
      setModelMsg(t('teamDetailPage.teamModelError'))
    } else {
      setDept((current) => current ? { ...current, subs: current.subs.map((sub) => sub.id === subId ? { ...sub, model } : sub) } : current)
      setModelOk(true)
      setModelMsg(t('teamDetailPage.teamModelSaved'))
    }
    setSavingSubModel(null)
  }
  const safetyCopy = lang === 'ru' ? {
    badge: 'Безопасная бета · только Nemo',
    specialist: 'Только Nemo',
    notice: 'Безопасная бета: используйте обезличенные или минимально необходимые данные, проверяйте каждый результат и оставляйте решения уполномоченному специалисту. Для этой команды Nemo пока не предоставляет обязательную очередь согласований.',
    blockedTitle: 'Подключение внешних каналов заблокировано в этой бета-версии',
    blockedBody: 'Тестируйте команду только внутри Nemo на нечувствительных или обезличенных данных. Telegram можно будет включить после реализации и проверки обязательного согласования, аудита и защиты данных.',
    status: 'Безопасная бета: команда работает только внутри Nemo. Проверьте результат; решения и внешние действия остаются за уполномоченным специалистом.',
    generalStatus: 'Команда готова к внутренней задаче: дайте факты и критерий результата, затем проверьте итог перед внешним действием.',
  } : lang === 'uz' ? {
    badge: 'Xavfsiz beta · faqat Nemo',
    specialist: 'Faqat Nemo',
    notice: 'Xavfsiz beta: shaxssizlantirilgan yoki minimal zarur ma’lumotlardan foydalaning, har bir natijani tekshiring va qarorlarni vakolatli mutaxassisga qoldiring. Nemo bu jamoa uchun hali majburiy tasdiqlash navbatini bermaydi.',
    blockedTitle: 'Bu beta-versiyada tashqi kanallarni ulash bloklangan',
    blockedBody: 'Jamoani faqat Nemo ichida maxfiy bo‘lmagan yoki shaxssizlantirilgan ma’lumotlarda sinang. Telegram majburiy tasdiqlash, audit va ma’lumotlarni himoya qilish nazoratlari joriy etilib tekshirilgandan keyin yoqiladi.',
    status: 'Xavfsiz beta: jamoa faqat Nemo ichida ishlaydi. Natijani tekshiring; qarorlar va tashqi harakatlar vakolatli mutaxassisda qoladi.',
    generalStatus: 'Jamoa ichki vazifaga tayyor: faktlar va natija mezonini bering, so‘ng tashqi harakatdan oldin yakunni tekshiring.',
  } : {
    badge: 'Safety beta · Nemo only',
    specialist: 'Nemo only',
    notice: 'Safety beta: use de-identified or minimum necessary data, review every result, and keep decisions with an authorized professional. Consequential browser actions create an owner approval request; approval alone never executes an action.',
    blockedTitle: 'Live channel connection is blocked in this beta',
    blockedBody: 'Test this team only inside Nemo with non-sensitive or de-identified data. Telegram can be enabled after enforced approval, audit and data-protection controls are implemented and verified.',
    status: 'Safety beta: this team runs only inside Nemo. Review the result; decisions and external actions remain with an authorized professional.',
    generalStatus: 'The team is ready for an internal task: provide facts and acceptance criteria, then review the result before any external action.',
  }

  const activeAgents = dept?.subs.length ?? 0
  const latestRunId = latestRun?.id

  useEffect(() => {
    if (!pendingTask && !latestRunId) return
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [pendingTask, runnerStatus, latestRunId, fastReply])

  if (loading) return <div className="grid min-h-[60vh] place-items-center text-2xl text-muted">…</div>
  if (!team && !dept && hydrated) {
    return <div className="container-page max-w-4xl py-10 text-center text-muted">{t('teamDetailPage.teamNotFound')}</div>
  }

  return (
    <div className="container-page max-w-[1540px] py-6 sm:py-8">
      <header className="flex flex-col gap-4 border-b border-ice/[0.07] pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 title={teamName} className="max-w-[min(720px,72vw)] truncate text-2xl font-extrabold tracking-[-0.035em] text-text sm:text-3xl">{teamName}</h1>
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-teal/20 bg-teal/[0.07] px-2.5 py-1 text-[11px] font-semibold text-teal"><span className="h-1.5 w-1.5 rounded-full bg-teal" />{t('teamDetailPage.onlineAgents', { n: activeAgents })}</span>
            {isRegulated && <span className="rounded-lg border border-amber/25 bg-amber/[0.07] px-2.5 py-1 text-[11px] text-amber">{safetyCopy.badge}</span>}
          </div>
          <p title={goal} className="mt-2 max-w-3xl text-sm leading-6 text-muted text-pretty line-clamp-2">{goal}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setTelegramOpen(true)} className="inline-flex items-center gap-2 rounded-xl border border-ice/[0.09] bg-card/[0.025] px-3.5 py-2.5 text-xs font-semibold text-muted transition hover:border-cyan/25 hover:text-text active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/30"><Settings2 size={15} />{t('teamDetailPage.telegramSettings')}</button>
          <button type="button" onClick={() => setInspectorOpen((value) => !value)} aria-pressed={inspectorOpen} className="inline-flex items-center gap-2 rounded-xl border border-ice/[0.09] bg-card/[0.025] px-3.5 py-2.5 text-xs font-semibold text-muted transition hover:border-cyan/25 hover:text-text active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/30">{inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}{t('teamDetailPage.inspector')}</button>
        </div>
      </header>

      <nav className="mt-4 flex max-w-full gap-1 overflow-x-auto" aria-label={t('teamDetailPage.teamSections')}>
        {([
          { id: 'overview' as const, label: tabCopy.overview, icon: LayoutDashboard },
          { id: 'graph' as const, label: tabCopy.graph, icon: Network },
          { id: 'runs' as const, label: tabCopy.runs, icon: History },
        ]).map((tab) => (
          <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} aria-pressed={activeTab === tab.id} className={cn('inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/30', activeTab === tab.id ? 'border-cyan text-text' : 'border-transparent text-muted hover:border-ice/15 hover:text-text')}><tab.icon size={15} />{tab.label}</button>
        ))}
      </nav>

      {activeTab === 'graph' && <TeamOfficeView key={id} platformAgents={[]} supplementalAgents={graphAgents} loading={loading} initialMode="graph" showModeSwitcher={false} />}

      {activeTab === 'overview' && (
        <div className={cn('mt-5 grid min-w-0 gap-4', inspectorOpen ? 'min-[1180px]:grid-cols-[220px_minmax(0,1fr)_310px]' : 'min-[1180px]:grid-cols-[220px_minmax(0,1fr)]')}>
          <aside className="min-w-0 min-[1180px]:sticky min-[1180px]:top-20 min-[1180px]:self-start" aria-label={t('teamDetailPage.specialists')}>
            <div className="mb-3 flex items-center justify-between px-1"><h2 className="text-xs font-bold uppercase tracking-[0.13em] text-fog">{t('teamDetailPage.specialists')}</h2><span className="font-mono text-[10px] text-muted">{activeAgents}</span></div>
            <div className="space-y-1.5">
              {(dept?.subs ?? []).map((sa, index) => {
                const color = COLORS[index % COLORS.length]
                return <button key={sa.id} type="button" onClick={() => setSelectedSub(sa)} className="group flex w-full min-w-0 items-center gap-3 rounded-2xl px-2.5 py-3 text-left transition hover:bg-white/[0.035] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/30">
                  <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: `${color}18`, color }}><Bot size={16} /><span className={cn('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg', latestRun && index < (latestRun.steps?.length ?? 0) ? 'bg-teal' : 'bg-fog')} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-text">{sa.name}</span><span className="mt-0.5 block truncate text-[11px] text-muted">{sa.role}</span></span>
                  <ChevronDown size={14} className="-rotate-90 text-fog opacity-0 transition group-hover:opacity-100" />
                </button>
              })}
              {!dept && <p className="rounded-2xl border border-dashed border-ice/10 p-4 text-xs leading-5 text-muted">{t('teamDetailPage.noSavedStructure')}</p>}
            </div>
            <p className="mt-4 px-3 text-[10px] leading-4 text-fog">{t('teamDetailPage.agentSettingsHint')}</p>
          </aside>

          <main className="min-w-0 overflow-hidden rounded-3xl border border-ice/[0.08] bg-card/[0.018]" aria-labelledby="team-stream-title">
            <div className="flex items-center gap-3 border-b border-ice/[0.07] px-4 py-3.5 sm:px-5"><span className="grid h-9 w-9 place-items-center rounded-xl bg-cyan/[0.08] text-cyan"><Activity size={17} /></span><div><h2 id="team-stream-title" className="text-sm font-bold text-text">{t('teamDetailPage.commandStream')}</h2><p className="mt-0.5 text-[11px] text-muted">{t('teamDetailPage.commandStreamHint')}</p></div>{latestRun && <span className="ml-auto hidden items-center gap-1.5 font-mono text-[10px] text-teal sm:inline-flex"><CircleDot size={11} />{t('teamDetailPage.latestRun')}</span>}</div>

            <div className="max-h-[58vh] min-h-72 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
              {!latestRun && <div className="grid min-h-56 place-items-center text-center"><div><Users size={26} className="mx-auto text-fog" /><p className="mt-3 text-sm font-semibold text-text">{t('teamDetailPage.streamEmpty')}</p><p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted">{t('teamDetailPage.streamEmptyHint')}</p></div></div>}
              {latestRun && <>
                <article className="ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-cyan/[0.08] px-4 py-3"><p className="mb-1 text-[10px] font-semibold text-cyan">{t('teamDetailPage.you')}</p><p className="break-words text-sm leading-6 text-text">{latestRun.task}</p></article>
                <article className="max-w-[92%]"><div className="flex items-start gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-violet/[0.1] text-violet"><Bot size={15} /></span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="text-xs font-bold text-text">{t('teamDetailPage.coordinator')}</p><span className="text-[10px] text-fog">{new Date(latestRun.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><p className="mt-1 text-sm leading-6 text-muted">{t('teamDetailPage.coordinatorAccepted')}</p><div className="mt-2 space-y-1.5">{(latestRun.steps ?? []).slice(0, 4).map((step, index) => <button type="button" key={`${step.query}-${index}`} onClick={() => { setOpenRun(latestRun.id); setActiveTab('runs') }} className="flex w-full min-w-0 items-center gap-2 rounded-xl bg-white/[0.025] px-3 py-2 text-left transition hover:bg-white/[0.05]"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal" /><span className="min-w-0 flex-1 truncate text-xs text-muted">{step.query}</span><span className="text-[10px] text-fog">{step.review?.approved ? t('teamDetailPage.ready') : t('teamDetailPage.inProgress')}</span></button>)}</div></div></div></article>
                {latestRun.report && latestRun.kind === 'store_snapshot' ? <div className="ml-0 min-w-0 sm:ml-11"><StoreSnapshotArtifact lang={lang} task={latestRun.task} /></div> : latestRun.report && isAnalyticalArtifactIntent(latestRun.task) ? <div className="ml-0 min-w-0 sm:ml-11"><AnalyticalReportArtifact task={latestRun.task} report={latestRun.report} lang={lang} /></div> : latestRun.report && <article className="ml-0 max-w-[96%] overflow-hidden rounded-2xl border border-teal/20 bg-teal/[0.045] sm:ml-11"><header className="flex items-center gap-3 border-b border-teal/10 px-4 py-3"><FileText size={17} className="shrink-0 text-teal" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-text">{t('teamDetailPage.resultReady')}</p><p className="mt-0.5 text-[10px] text-muted">{t('teamDetailPage.resultReadyHint', { n: latestRun.steps?.length ?? 0 })}</p></div><button type="button" onClick={() => { setOpenRun(latestRun.id); setActiveTab('runs') }} className="text-[10px] font-semibold text-cyan transition hover:text-text">{t('teamDetailPage.viewAll')}</button></header><div className="max-h-80 overflow-y-auto px-4 py-3 text-sm leading-6"><Markdown content={latestRun.report} /></div></article>}
                {latestRun.report && isCodeCreationIntent(latestRun.task) && <div className="ml-0 min-w-0 sm:ml-11"><LiveCodeSandboxArtifact prompt={latestRun.task} compact /></div>}
              </>}
              {pendingTask && (fastStoreArtifact || fastReply || runnerStatus !== 'completed') && <>
                <article className="team-message-in ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-cyan/[0.08] px-4 py-3"><p className="mb-1 text-[10px] font-semibold text-cyan">{t('teamDetailPage.you')}</p><p className="break-words text-sm leading-6 text-text">{pendingTask}</p></article>
                {!fastStoreArtifact && !fastReply && <article className="team-working-message max-w-[92%]" role="status" aria-live="polite">
                  <div className="flex items-start gap-3">
                    <span className="team-working-avatar relative grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cyan/[0.09] text-cyan"><Activity size={16} /><span className="absolute inset-0 rounded-xl border border-cyan/35" /></span>
                    <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-ice/[0.07] bg-white/[0.025] px-4 py-3.5">
                      <div className="flex items-center gap-2"><p className="text-xs font-bold text-text">{t('teamDetailPage.coordinator')}</p><span className="team-thinking-dots" aria-hidden="true"><i /><i /><i /></span></div>
                      <p className="mt-1 text-xs leading-5 text-muted">{runnerStatus === 'queued' ? (lang === 'ru' ? 'Задача принята и ожидает запуска' : lang === 'uz' ? 'Vazifa qabul qilindi va ishga tushishni kutmoqda' : 'Task accepted and waiting to start') : (lang === 'ru' ? 'Координатор выбрал профильных субагентов и собирает готовый результат' : lang === 'uz' ? 'Koordinator maxsus subagentlarni tanlab, tayyor natijani yig‘moqda' : 'The coordinator selected task specialists and is assembling the result')}</p>
                      <div className="mt-3 flex flex-wrap gap-1.5">{(dept?.subs ?? []).slice(0, 4).map((agent, index) => <span key={agent.id} className="team-agent-working inline-flex items-center gap-1.5 rounded-lg bg-white/[0.035] px-2.5 py-1.5 text-[10px] text-muted" style={{ animationDelay: `${index * 180}ms` }}><span className="h-1.5 w-1.5 rounded-full bg-teal" />{agent.name}</span>)}<span className="team-agent-working inline-flex items-center gap-1.5 rounded-lg border border-cyan/15 bg-cyan/[0.045] px-2.5 py-1.5 text-[10px] text-cyan"><span className="h-1.5 w-1.5 rounded-full bg-cyan" />{lang === 'ru' ? '+ субагенты по задаче' : lang === 'uz' ? '+ vazifa subagentlari' : '+ task subagents'}</span></div>
                    </div>
                  </div>
                </article>}
                {fastReply && <article className={cn('ml-0 max-w-[96%] overflow-hidden rounded-2xl border sm:ml-11', fastReply.error ? 'border-danger/20 bg-danger/[0.045]' : 'border-cyan/15 bg-cyan/[0.035]')} aria-live="polite">
                  <div className="flex items-start gap-3 px-4 py-3.5">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-cyan/[0.09] text-cyan">{fastReply.loading ? <Loader2 size={15} className="animate-spin" /> : <Bot size={15} />}</span>
                    <div className="min-w-0 flex-1 text-sm leading-6 text-muted">{fastReply.loading ? (lang === 'ru' ? 'Отвечаю…' : lang === 'uz' ? 'Javob tayyorlanmoqda…' : 'Answering…') : <Markdown content={fastReply.text} />}</div>
                  </div>
                </article>}
                {fastStoreArtifact && <div className="min-w-0 sm:ml-11"><StoreSnapshotArtifact lang={lang} departmentId={dept?.id} task={fastStoreArtifact.task} runRef={fastStoreArtifact.runRef} onSettled={(ok) => setRunnerStatus(ok ? 'completed' : 'failed')} onSaved={async () => { if (dept) await loadResults(dept.id); setFastStoreArtifact(null); setPendingTask(null) }} /></div>}
              </>}
              <div ref={streamEndRef} />
            </div>

            <div className="border-t border-ice/[0.07] bg-bg/20 p-3 sm:p-4">
              {isRegulated && <p className="mb-3 rounded-xl border border-amber/20 bg-amber/[0.06] p-3 text-xs leading-5 text-amber">{safetyCopy.notice}</p>}
              <AutonomousRunner key={dept?.id ?? 'team'} defaultGoal={marketplaceDefaultGoal} presetSpecs={(dept?.subs ?? []).map((s) => ({ role: s.role, name: s.name, skills: s.skills ?? [], prompt: s.prompt }))} adaptiveTeam contextHint={`${goal}\n\nПостоянный состав команды: ${(dept?.subs ?? []).map((s) => `${s.name} — ${s.role}`).join('; ')}. Координатор может собрать временных профильных субагентов, если постоянному составу не хватает компетенции для точного результата.`} placeholder={t('teamDetailPage.streamPlaceholder')} departmentId={dept?.id} streamMode onTaskSubmitted={(task) => { setPendingTask(task); setFastStoreArtifact(null); setFastReply(null) }} onFastTask={async (task, context) => {
                if (!context.hasInputArtifacts && isMarketplaceWorkspace && isStoreSnapshotIntent(task)) {
                  setFastStoreArtifact({ task, runRef: crypto.randomUUID() })
                  return true
                }
                if (context.hasInputArtifacts || !isTeamQuickReplyIntent(task) || !supabase) return false
                setFastReply({ loading: true, text: '', error: false })
                try {
                  const teamContext = `${teamName}. ${goal}. Состав: ${(dept?.subs ?? []).map((member) => `${member.name} — ${member.role}`).join('; ') || 'не указан'}.`
                  const previousResult = latestRun?.report ? `\nПоследний результат команды для контекста:\n${latestRun.report.slice(0, 3500)}` : ''
                  const { data, error } = await supabase.functions.invoke('cli-chat', { body: { model: 'openai/gpt-4o-mini', messages: [{ role: 'system', content: `Ты отвечаешь внутри комнаты этой AI-команды. Контекст команды: ${teamContext}${previousResult}` }, { role: 'user', content: task }], tools: [] } })
                  const answer = typeof data?.message?.content === 'string' ? data.message.content.trim() : ''
                  if (error || !answer) throw new Error('quick_reply_failed')
                  setFastReply({ loading: false, text: answer, error: false })
                } catch {
                  setFastReply({ loading: false, text: lang === 'ru' ? 'Не удалось быстро получить ответ. Попробуйте ещё раз.' : lang === 'uz' ? 'Tez javobni olish imkoni bo‘lmadi. Qayta urinib ko‘ring.' : 'The quick answer failed. Please try again.', error: true })
                }
                return true
              }} onRunStateChange={setRunnerStatus} onRunSaved={async () => { if (dept) await loadResults(dept.id); setPendingTask(null) }} />
            </div>

            {isOps && <details className="group border-t border-ice/[0.07] bg-bg/10 [&_summary]:list-none"><summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-xs font-semibold text-muted transition hover:text-text"><ChevronDown size={14} className="transition group-open:rotate-180" />{t('teamDetailPage.operationsTools')}<span className="ml-auto text-[10px] text-fog">{t('teamDetailPage.optionalBadge')}</span></summary><div className="space-y-4 border-t border-ice/[0.06] p-4">
              <div className="flex flex-wrap gap-2">{isLogistics ? <button onClick={() => setKind('logistics_control')} className="inline-flex items-center gap-1.5 rounded-xl border border-cyan/30 bg-cyan/[0.06] px-3 py-2 text-xs text-text"><Truck size={14} />{t('teamDetailPage.logisticsAnalysis')}</button> : <><button onClick={() => setKind('retention_scan')} className={cn('rounded-xl border px-3 py-2 text-xs', workflowKind === 'retention_scan' ? 'border-cyan/30 bg-cyan/[0.06] text-text' : 'border-ice/10 text-muted')}>{t('teamDetailPage.churnBtn')}</button><button onClick={() => setKind('payment_control')} className={cn('rounded-xl border px-3 py-2 text-xs', workflowKind === 'payment_control' ? 'border-cyan/30 bg-cyan/[0.06] text-text' : 'border-ice/10 text-muted')}>{t('teamDetailPage.paymentControl')}</button><button onClick={() => setKind('meeting_to_tasks')} className={cn('rounded-xl border px-3 py-2 text-xs', workflowKind === 'meeting_to_tasks' ? 'border-cyan/30 bg-cyan/[0.06] text-text' : 'border-ice/10 text-muted')}>{t('teamDetailPage.meetingToTasks')}</button></>}</div>
              <OpsWorkflowRunner key={workflowKind} kind={workflowKind} departmentId={dept?.id} sampleInput={workflowKind === 'logistics_control' ? SAMPLE_LOGISTICS : workflowKind === 'retention_scan' ? SAMPLE_RETENTION : workflowKind === 'payment_control' ? SAMPLE_PAYMENT : SAMPLE_MEETING} lang={lang} onDone={() => dept && loadResults(dept.id)} />
              {!isLogistics && <><PlanerkaSheetCard /><PlanerkaMembersCard /></>}
            </div></details>}
          </main>

          {inspectorOpen && <>
            <button type="button" aria-label={t('teamDetailPage.closeInspector')} onClick={() => setInspectorOpen(false)} className="fixed inset-0 z-40 bg-bg/65 backdrop-blur-sm min-[1180px]:hidden" />
            <aside className="fixed inset-y-0 right-0 z-50 w-[min(360px,92vw)] overflow-y-auto border-l border-ice/[0.09] bg-bg p-4 shadow-2xl min-[1180px]:sticky min-[1180px]:top-20 min-[1180px]:z-auto min-[1180px]:h-[calc(100dvh-6rem)] min-[1180px]:w-auto min-[1180px]:rounded-3xl min-[1180px]:border min-[1180px]:bg-card/[0.02] min-[1180px]:shadow-none" aria-label={t('teamDetailPage.inspector')}>
              <div className="flex items-center gap-2"><Activity size={16} className="text-cyan" /><h2 className="text-sm font-bold text-text">{t('teamDetailPage.inspector')}</h2><button type="button" onClick={() => setInspectorOpen(false)} aria-label={t('teamDetailPage.closeInspector')} className="ml-auto rounded-lg p-1.5 text-muted transition hover:bg-white/[0.05] hover:text-text"><X size={15} /></button></div>
              <section className="mt-4 rounded-2xl bg-white/[0.025] p-3.5"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-fog">{t('teamDetailPage.activeRun')}</p>{latestRun ? <><div className="mt-2 flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-teal" /><p className="min-w-0 flex-1 truncate text-xs font-semibold text-text">{latestRun.task}</p></div><p className="mt-2 font-mono text-[10px] text-muted">{t('teamDetailPage.agentsInRun', { n: Math.min(activeAgents, latestRun.steps?.length || activeAgents) })} · {latestRun.status ?? t('teamDetailPage.ready')}</p></> : <p className="mt-2 text-xs leading-5 text-muted">{t('teamDetailPage.noActiveRun')}</p>}</section>
              <section className="mt-5"><div className="flex items-center justify-between"><h3 className="text-xs font-bold text-text">{t('teamDetailPage.agentActivity')}</h3><span className="font-mono text-[10px] text-muted">{activeAgents}</span></div><div className="mt-2 space-y-1">{(dept?.subs ?? []).slice(0, 6).map((sa, index) => <button type="button" key={sa.id} onClick={() => setSelectedSub(sa)} className="flex w-full min-w-0 items-center gap-2 rounded-xl px-2 py-2 text-left transition hover:bg-white/[0.035]"><span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', latestRun && index < (latestRun.steps?.length ?? 0) ? 'bg-teal' : 'bg-fog')} /><span className="min-w-0 flex-1 truncate text-xs text-muted">{sa.name}</span><span className="text-[10px] text-fog">{latestRun && index < (latestRun.steps?.length ?? 0) ? t('teamDetailPage.ready') : t('teamDetailPage.waiting')}</span></button>)}</div></section>
              {notifs.length > 0 && <section className="mt-5"><h3 className="flex items-center gap-2 text-xs font-bold text-text"><BellRing size={13} className="text-amber" />{t('teamDetailPage.adminNotifications')}<span className="ml-auto font-mono text-[10px] text-muted">{notifs.length}</span></h3><div className="mt-2 space-y-2">{notifs.slice(0, 3).map((notification) => <div key={notification.id} className="rounded-xl bg-amber/[0.045] px-3 py-2.5"><p className="text-xs font-medium text-text">{notification.title}</p>{notification.body && <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted">{notification.body}</p>}</div>)}</div></section>}
              {tasks.length > 0 && <section className="mt-5"><h3 className="flex items-center gap-2 text-xs font-bold text-text"><ClipboardList size={13} className="text-cyan" />{t('teamDetailPage.tasksHeading')}<span className="ml-auto font-mono text-[10px] text-muted">{tasks.length}</span></h3><div className="mt-2 space-y-1.5">{tasks.slice(0, 4).map((task) => <div key={task.id} className="rounded-xl bg-white/[0.025] px-3 py-2.5"><p className="line-clamp-2 text-xs text-text">{task.title}</p><div className="mt-1.5 flex items-center gap-2 text-[9px] text-fog">{task.owner && <span>{task.owner}</span>}<span className={cn('ml-auto rounded-md px-1.5 py-0.5', statusCls(task.status))}>{task.status ?? 'todo'}</span></div></div>)}</div></section>}
              <section className="mt-5"><div className="flex items-center justify-between"><h3 className="text-xs font-bold text-text">{t('teamDetailPage.previousRuns')}</h3><button type="button" onClick={() => setActiveTab('runs')} className="text-[10px] font-semibold text-cyan hover:underline">{t('teamDetailPage.viewAll')}</button></div><div className="mt-2 space-y-1.5">{runs.slice(0, 5).map((run) => <button key={run.id} type="button" onClick={() => { setOpenRun(run.id); setActiveTab('runs') }} className="flex w-full min-w-0 items-center gap-2 rounded-xl px-2 py-2 text-left transition hover:bg-white/[0.035]"><FileText size={13} className="shrink-0 text-fog" /><span className="min-w-0 flex-1 truncate text-xs text-muted">{run.task}</span><span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', run.human_review_status === 'rejected' ? 'bg-danger' : run.human_review_status === 'approved' ? 'bg-teal' : 'bg-amber')} /></button>)}{runs.length === 0 && <p className="py-3 text-xs text-muted">{t('teamDetailPage.noWorkflowRuns')}</p>}</div></section>
            </aside>
          </>}
        </div>
      )}

      {activeTab === 'runs' && <section className="card mx-auto mt-6 min-w-0 max-w-6xl overflow-hidden rounded-3xl p-4 sm:p-6">
            <div className="flex items-center gap-2"><GitBranch size={18} className="text-violet" /><h2 className="text-lg font-bold text-text">{t('teamDetailPage.runsTrace')}</h2><span className="ml-auto text-xs text-muted">{runs.length}</span></div>
            <div className="mt-4 space-y-2">
              {runs.length === 0 && <p className="rounded-xl border border-dashed border-ice/10 p-5 text-center text-sm text-muted">{t('teamDetailPage.noWorkflowRuns')}</p>}
              {runs.map((run) => {
                const isOpen = openRun === run.id
                return (
                  <div key={run.id} className="min-w-0 overflow-hidden rounded-xl border border-ice/[0.07]">
                    <button onClick={() => setOpenRun(isOpen ? null : run.id)} className="flex w-full min-w-0 items-center gap-2.5 px-3.5 py-2.5 text-left">
                      <span className="shrink-0 rounded-full bg-violet/10 px-2 py-0.5 text-[10px] text-violet">{run.kind}</span>
                       {(run.human_review_status === 'pending' || (!run.human_review_status && run.status === 'needs_review')) && <span className="shrink-0 rounded-lg bg-amber/10 px-2 py-0.5 text-[10px] text-amber">{t('teamDetailPage.humanReview')}</span>}
                       {run.human_review_status === 'approved' && <span className="shrink-0 rounded-lg bg-teal/10 px-2 py-0.5 text-[10px] text-teal">{t('teamDetailPage.ownerApproved')}</span>}
                       {run.human_review_status === 'rejected' && <span className="shrink-0 rounded-lg bg-danger/10 px-2 py-0.5 text-[10px] text-danger">{t('teamDetailPage.ownerRejected')}</span>}
                      <span title={run.task} className="min-w-0 flex-1 truncate text-sm text-text">{run.task}</span>
                      <span className="hidden shrink-0 text-[11px] text-muted min-[1800px]:inline">{new Date(run.created_at).toLocaleString()}</span>
                      <ChevronDown size={15} className={cn('shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && (
                      <div className="min-w-0 space-y-3 overflow-hidden border-t border-ice/[0.07] px-3.5 py-3">
                        {(run.steps ?? []).map((s, i) => (
                          <div key={i} className="rounded-lg bg-white/[0.02] p-2.5">
                            <p className="mb-1 break-words text-[11px] font-medium text-cyan">{s.query}</p>
                            {s.review && (s.review.reviewed_by || s.review.needs_human_review) && (
                              <p className={cn('mb-1.5 text-[10.5px]', s.review.needs_human_review ? 'text-amber' : s.review.approved ? 'text-teal' : 'text-muted')}>
                                {s.review.reviewed_by ? `${t('teamDetailPage.peer')}: ${s.review.reviewed_by} / ${s.review.score ?? 0}/100` : t('teamDetailPage.peerReview')}
                                {s.review.revised ? ` / ${t('teamDetailPage.revised', { n: s.review.revisions ?? 1 })}` : ''}
                                 {s.review.needs_human_review && (run.human_review_status === 'pending' || !run.human_review_status) ? ` / ${t('teamDetailPage.humanReviewRequired')}` : ''}
                              </p>
                            )}
                            <div className="min-w-0 overflow-x-auto text-[12px] text-muted"><Markdown content={(s.findings || '—').slice(0, 1200)} /></div>
                          </div>
                        ))}
                        {run.report && (
                          <div className="rounded-lg border border-ice/[0.07] p-3">
                            <p className="mb-1 text-[11px] font-medium text-text">{t('teamDetailPage.managerSummary')}</p>
                            <div className="min-w-0 overflow-x-auto"><Markdown content={run.report} /></div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>}

      {telegramOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-bg/75 p-3 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTelegramOpen(false) }}><section role="dialog" aria-modal="true" aria-labelledby="telegram-settings-title" className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-ice/[0.1] bg-panel p-5 shadow-2xl sm:p-6"><div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan/[0.08] text-cyan"><Send size={18} /></span><div className="min-w-0 flex-1"><h2 id="telegram-settings-title" className="text-lg font-bold text-text">{t('teamDetailPage.telegramBotsTitle')}</h2><p className="mt-1 text-sm leading-6 text-muted">{t('teamDetailPage.telegramBotsDesc')}</p></div><button type="button" onClick={() => setTelegramOpen(false)} aria-label={t('teamDetailPage.closeTelegram')} className="rounded-xl p-2 text-muted transition hover:bg-white/[0.05] hover:text-text"><X size={17} /></button></div>
        {isRegulated ? (
          <div className="mt-5 rounded-2xl border border-amber/25 bg-amber/[0.06] p-4"><p className="text-sm font-semibold text-text">{safetyCopy.blockedTitle}</p><p className="mt-2 text-xs leading-5 text-muted">{safetyCopy.blockedBody}</p></div>
        ) : (
          <div className="mt-5 space-y-4"><div className="rounded-2xl bg-violet/[0.055] p-4"><p className="text-sm font-semibold text-text">{t('teamDetailPage.teamCommonBot')}</p><p className="mt-1.5 text-xs leading-5 text-muted">{t('teamDetailPage.teamCommonBotHint')}</p><ol className="mt-3 space-y-2">{[t('teamDetailPage.botStep1'), t('teamDetailPage.botStep2'), t('teamDetailPage.botStep3')].map((step, index) => <li key={step} className="flex gap-2.5 text-xs leading-5 text-muted"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-violet/15 text-[10px] font-bold text-violet">{index + 1}</span><span>{step}</span></li>)}</ol><div className="mt-4"><TelegramBotConnect target={{ agent_id: id }} connected={tgConnected} onConnected={() => setTgConnected(true)} /></div></div><details className="group rounded-2xl border border-ice/[0.08] [&_summary]:list-none"><summary className="flex cursor-pointer items-center gap-2 p-4 text-xs font-semibold text-text"><ChevronDown size={14} className="transition group-open:rotate-180" />{t('teamDetailPage.advancedBotsToggle')}<span className="ml-auto text-[10px] text-fog">{t('teamDetailPage.optionalBadge')}</span></summary><div className="border-t border-ice/[0.07] p-4"><p className="mb-2 flex items-center gap-2 text-xs font-semibold text-text"><Users2 size={14} className="text-amber" />{t('teamDetailPage.groupBotLabel')}</p><TelegramBotConnect target={{ agent_id: id, scope: 'group', label: 'Task bot' }} connected={groupConnected} hint={t('teamDetailPage.groupBotHint')} onConnected={() => setGroupConnected(true)} /></div></details></div>
        )}
      </section></div>}

      {selectedSub && <div className="fixed inset-0 z-50 grid place-items-center bg-bg/75 p-3 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedSub(null) }}><section role="dialog" aria-modal="true" aria-labelledby="agent-settings-title" className="w-full max-w-md rounded-3xl border border-ice/[0.1] bg-panel p-5 shadow-2xl"><div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan/[0.08] text-cyan"><Bot size={18} /></span><div className="min-w-0 flex-1"><h2 id="agent-settings-title" className="text-lg font-bold text-text">{selectedSub.name}</h2><p className="mt-0.5 text-xs text-muted">{selectedSub.role}</p></div><button type="button" onClick={() => setSelectedSub(null)} aria-label={t('teamDetailPage.closeAgentSettings')} className="rounded-xl p-2 text-muted transition hover:bg-white/[0.05] hover:text-text"><X size={17} /></button></div><p className="mt-5 text-xs leading-5 text-muted">{selectedSub.prompt?.tasks || selectedSub.prompt?.role || t('teamDetailPage.agentNoDescription')}</p><label className="mt-5 block text-[10px] font-bold uppercase tracking-[0.12em] text-fog">{t('teamDetailPage.agentModel')}<select aria-label={`${selectedSub.name} model`} value={selectedSub.model} disabled={savingSubModel === selectedSub.id} onChange={(event) => { const model = event.target.value; setSelectedSub((current) => current ? { ...current, model } : current); void updateSubModel(selectedSub.id, model) }} className="mt-2 w-full rounded-xl border border-ice/[0.09] bg-bg/40 px-3 py-2.5 text-sm text-text outline-none focus:border-cyan/35">{PROVIDERS.map((provider) => <optgroup key={provider.id} label={provider.name} className="bg-panel">{provider.models.map((model) => <option key={model.id} value={model.id} className="bg-panel">{model.label}{model.premium ? ' 💎' : ''}</option>)}</optgroup>)}</select></label>{savingSubModel === selectedSub.id && <p className="mt-2 flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{t('teamDetailPage.savingModel')}</p>}{modelMsg && <p className={cn('mt-2 text-xs', modelOk ? 'text-teal' : 'text-danger')}>{modelMsg}</p>}{!isRegulated && <div className="mt-5 border-t border-ice/[0.07] pt-4"><p className="mb-2 text-xs font-semibold text-text">{t('teamDetailPage.personalBot')}</p><TelegramBotConnect compact target={{ sub_agent_id: selectedSub.id }} connected={subBots.has(selectedSub.id)} onConnected={() => setSubBots((previous) => new Set(previous).add(selectedSub.id))} /></div>}</section></div>}
    </div>
  )
}
