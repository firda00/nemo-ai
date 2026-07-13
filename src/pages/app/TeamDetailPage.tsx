import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Users, Bot, PlayCircle, ClipboardList, BellRing, GitBranch, ChevronDown, Wallet, ListChecks, Send, Users2, Truck } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase, isSupabaseEnabled } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { Markdown } from '../../components/ui/Markdown'
import { OpsWorkflowRunner, type OpsKind } from '../../components/platform/OpsWorkflowRunner'
import { AutonomousRunner } from '../../components/platform/AutonomousRunner'
import { TelegramBotConnect } from '../../components/platform/TelegramBotConnect'
import { PlanerkaSheetCard } from '../../components/platform/PlanerkaSheetCard'
import { PlanerkaMembersCard } from '../../components/platform/PlanerkaMembersCard'
import { CoordinatorAgentPanel } from '../../components/platform/CoordinatorAgentPanel'
import { PlannerCommandCenter } from '../../components/platform/PlannerCommandCenter'
import { SAMPLE_PAYMENT, SAMPLE_MEETING, SAMPLE_RETENTION } from '../../lib/ustudyTeam'
import { SAMPLE_LOGISTICS } from '../../lib/commerceTeams'
import { cn } from '../../lib/cn'

interface Sub { id: string; role: string; name: string; prompt: { role?: string; tasks?: string } }
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
interface Run { id: string; task: string; kind: string; status?: string; report?: string; steps?: RunStep[]; created_at: string }

const COLORS = ['#22D3EE', '#5B7CF6', '#8B7CF8', '#13C5B4', '#F4A640', '#EC6CB0']
const riskCls = (r?: string) => (r === 'high' ? 'bg-danger/15 text-danger' : r === 'medium' ? 'bg-amber/15 text-amber' : 'bg-teal/15 text-teal')
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
  const [tgConnected, setTgConnected] = useState(false)
  const [groupConnected, setGroupConnected] = useState(false)
  const [subBots, setSubBots] = useState<Set<string>>(new Set())

  const loadResults = useCallback(async (deptId: string) => {
    if (!supabase) return
    const [{ data: t }, { data: n }, { data: r }] = await Promise.all([
      supabase.from('tasks').select('*').eq('department_id', deptId).order('created_at', { ascending: false }).limit(40),
      supabase.from('notifications').select('*').eq('department_id', deptId).order('created_at', { ascending: false }).limit(20),
      supabase.from('research_runs').select('id, task, kind, status, report, steps, created_at').eq('department_id', deptId).order('created_at', { ascending: false }).limit(10),
    ])
    setTasks((t ?? []) as Task[])
    setNotifs((n ?? []) as Notif[])
    setRuns((r ?? []) as Run[])
  }, [])

  useEffect(() => {
    if (!isSupabaseEnabled || !supabase || !id) {
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

  const teamName = team?.name || dept?.name || 'Operations Team'
  const goal = team?.purpose || 'Automate routine operations: payments, admin escalation, meetings-to-tasks and manager reports.'

  // Show operational workflows only for teams that were created for that work.
  // Content, sales and store teams keep the universal "task the team" runner.
  const teamBlob = `${team?.name ?? ''} ${team?.purpose ?? ''} ${team?.niche ?? ''} ${dept?.name ?? ''} ${dept?.niche ?? ''} ${(dept?.subs ?? []).map((s) => `${s.role} ${s.prompt?.tasks ?? ''}`).join(' ')}`.toLowerCase()
  const explicitWorkflowMode = teamBlob.match(/nemo-workflow:(generic|operations|logistics)/)?.[1]
  const isRegulated = team?.riskTier === 'regulated' || /nemo-risk:regulated/.test(teamBlob)
  const isLogistics = explicitWorkflowMode === 'logistics' || (!explicitWorkflowMode && /logistics?|логист|shipment|carrier|доставк|fulfillment|sla monitor/.test(teamBlob))
  const isCommerceWorkspace = /marketplace seller team|dropshipping team|online store team/.test(teamBlob)
  const isOps = isLogistics
    || explicitWorkflowMode === 'operations'
    || (!explicitWorkflowMode && !isCommerceWorkspace && /\boperations?\b|\bops\b|оплат|payment|платеж|ученик|студент|student|посещ|attendance|retention|churn|уход|неоплат|meeting|совещ|встреч|отчёт по задач|task manager|admin control|payment reminder/.test(teamBlob))
  const workflowKind: OpsKind = isLogistics ? 'logistics_control' : kind === 'logistics_control' ? 'payment_control' : kind
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
    notice: 'Safety beta: use de-identified or minimum necessary data, review every result, and keep decisions with an authorized professional. Nemo does not yet provide an enforced approval queue for this team.',
    blockedTitle: 'Live channel connection is blocked in this beta',
    blockedBody: 'Test this team only inside Nemo with non-sensitive or de-identified data. Telegram can be enabled after enforced approval, audit and data-protection controls are implemented and verified.',
    status: 'Safety beta: this team runs only inside Nemo. Review the result; decisions and external actions remain with an authorized professional.',
    generalStatus: 'The team is ready for an internal task: provide facts and acceptance criteria, then review the result before any external action.',
  }

  if (loading) return <div className="grid min-h-[60vh] place-items-center text-2xl text-muted">…</div>
  if (!team && !dept && hydrated) {
    return <div className="container-page max-w-4xl py-10 text-center text-muted">{t('teamDetailPage.teamNotFound')}</div>
  }

  return (
    <div className="container-page max-w-7xl py-8">
      <div className="flex flex-col gap-3">
        <p className="mono-label">AI Team</p>
        <h1 className="text-3xl font-extrabold text-text">{teamName}</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted">{goal}</p>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-pill border border-teal/20 bg-teal/10 px-3 py-1 text-xs text-teal">{team?.status || 'active'}</span>
          <span className="rounded-pill border border-violet/20 bg-violet/10 px-3 py-1 text-xs text-violet">{dept ? t('teamDetailPage.specialistAgents', { n: dept.subs.length }) : t('teamDetailPage.noTeamStructure')}</span>
          {isRegulated && <span className="rounded-pill border border-amber/25 bg-amber/10 px-3 py-1 text-xs text-amber">{safetyCopy.badge}</span>}
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        {/* LEFT — team structure + workflow runner */}
        <div className="space-y-6">
          <section className="card rounded-3xl p-6">
            <div className="flex items-center gap-2"><Users size={18} className="text-cyan" /><h2 className="text-lg font-bold text-text">{t('teamDetailPage.teamStructure')}</h2></div>
            {dept && <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{t('teamDetailPage.subBotOptionalNote')}</p>}
            <div className="mt-4 space-y-2">
              {(dept?.subs ?? []).map((sa, i) => {
                const color = COLORS[i % COLORS.length]
                return (
                  <div key={sa.id} className="flex items-center gap-2.5 rounded-xl border border-ice/[0.07] px-3.5 py-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: `${color}22`, color }}><Bot size={14} /></span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{sa.name}</span>
                    <span className="hidden shrink-0 rounded-full px-2 py-0.5 text-[10px] sm:inline" style={{ background: `${color}1a`, color }}>{sa.role}</span>
                    {isRegulated
                      ? <span className="shrink-0 rounded-pill border border-amber/20 bg-amber/10 px-2 py-0.5 text-[10px] text-amber">{safetyCopy.specialist}</span>
                      : <TelegramBotConnect compact target={{ sub_agent_id: sa.id }} connected={subBots.has(sa.id)} onConnected={() => setSubBots((prev) => new Set(prev).add(sa.id))} />}
                  </div>
                )
              })}
              {!dept && <p className="rounded-xl border border-dashed border-ice/10 p-5 text-center text-sm text-muted">{t('teamDetailPage.noSavedStructure')}</p>}
            </div>
          </section>

          {/* Universal: give the SAVED team any task (make a post, write a plan, etc.) */}
          <section className="card rounded-3xl p-6">
            <div className="flex items-center gap-2"><PlayCircle size={18} className="text-violet" /><h2 className="text-lg font-bold text-text">{t('teamDetailPage.taskToTeamTitle')}</h2></div>
            <p className="mt-1.5 text-sm text-muted">{t('teamDetailPage.taskToTeamDesc')}</p>
            {isRegulated && (
              <p className="mt-3 rounded-xl border border-amber/25 bg-amber/[0.07] p-3 text-xs leading-relaxed text-amber">
                {safetyCopy.notice}
              </p>
            )}
            <div className="mt-4">
              <AutonomousRunner
                key={dept?.id ?? 'team'}
                presetSpecs={(dept?.subs ?? []).map((s) => ({ role: s.role, name: s.name, prompt: s.prompt }))}
                contextHint={goal}
                placeholder={t('teamDetailPage.taskToTeamPlaceholder')}
                departmentId={dept?.id}
                onRunSaved={() => dept ? loadResults(dept.id) : undefined}
              />
            </div>
          </section>

          {/* Operations scenarios — only for operations-type teams */}
          {isOps && (
            <section className="card rounded-3xl p-6">
              <div className="flex items-center gap-2"><PlayCircle size={18} className="text-violet" /><h2 className="text-lg font-bold text-text">{t('teamDetailPage.opsScenariosTitle')}</h2></div>
              <div className="mt-4 flex flex-wrap gap-2">
                {isLogistics ? (
                  <button onClick={() => setKind('logistics_control')} className="inline-flex items-center gap-1.5 rounded-xl border border-cyan/40 bg-cyan/10 px-3 py-2 text-sm text-text">
                    <Truck size={15} /> Manual logistics analysis (beta)
                  </button>
                ) : (
                  <>
                    <button onClick={() => setKind('retention_scan')} className={cn('inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm', workflowKind === 'retention_scan' ? 'border-danger/40 bg-danger/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>
                      <BellRing size={15} /> {t('teamDetailPage.churnBtn')}
                    </button>
                    <button onClick={() => setKind('payment_control')} className={cn('inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm', workflowKind === 'payment_control' ? 'border-violet/40 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>
                      <Wallet size={15} /> {t('teamDetailPage.paymentControl')}
                    </button>
                    <button onClick={() => setKind('meeting_to_tasks')} className={cn('inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm', workflowKind === 'meeting_to_tasks' ? 'border-violet/40 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>
                      <ListChecks size={15} /> {t('teamDetailPage.meetingToTasks')}
                    </button>
                  </>
                )}
              </div>
              <div className="mt-4">
                <OpsWorkflowRunner
                  key={workflowKind}
                  kind={workflowKind}
                  departmentId={dept?.id}
                  sampleInput={workflowKind === 'logistics_control' ? SAMPLE_LOGISTICS : workflowKind === 'retention_scan' ? SAMPLE_RETENTION : workflowKind === 'payment_control' ? SAMPLE_PAYMENT : SAMPLE_MEETING}
                  lang={lang}
                  onDone={() => dept && loadResults(dept.id)}
                />
              </div>
            </section>
          )}

          <section className="card space-y-5 rounded-3xl p-6">
            <div>
              <div className="flex items-center gap-2"><Send size={18} className="text-cyan" /><h2 className="text-lg font-bold text-text">{t('teamDetailPage.telegramBotsTitle')}</h2></div>
              <p className="mt-2 text-sm leading-relaxed text-muted">{t('teamDetailPage.telegramBotsDesc')}</p>
            </div>

            {isRegulated ? (
              <div className="rounded-2xl border border-amber/30 bg-amber/[0.07] p-4">
                <p className="text-sm font-semibold text-text">{safetyCopy.blockedTitle}</p>
                <p className="mt-2 text-[13px] leading-relaxed text-muted">{safetyCopy.blockedBody}</p>
              </div>
            ) : (
              <>
            {/* PRIMARY — one master bot / one token runs the whole team. This is the "start here". */}
            <div className="rounded-2xl border border-violet/25 bg-violet/[0.05] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-pill bg-violet/15 px-2.5 py-0.5 text-[11px] font-semibold text-violet">{t('teamDetailPage.masterBotBadge')}</span>
                <p className="text-[14px] font-semibold text-text">{t('teamDetailPage.teamCommonBot')}</p>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{t('teamDetailPage.teamCommonBotHint')}</p>
              <ol className="mt-3 space-y-2">
                {[t('teamDetailPage.botStep1'), t('teamDetailPage.botStep2'), t('teamDetailPage.botStep3')].map((step, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-muted">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet/15 text-[11px] font-semibold text-violet">{i + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-3.5">
                <TelegramBotConnect
                  target={{ agent_id: id }}
                  connected={tgConnected}
                  onConnected={() => setTgConnected(true)}
                />
              </div>
            </div>

            {/* OPTIONAL — group bot + personal specialist bots, folded so they don't distract from the one token. */}
            <details className="group rounded-2xl border border-ice/[0.07] bg-black/10 [&_summary]:list-none">
              <summary className="flex cursor-pointer items-center gap-2 p-4 text-[13px] font-medium text-text">
                <ChevronDown size={15} className="text-muted transition group-open:rotate-180" />
                {t('teamDetailPage.advancedBotsToggle')}
                <span className="ml-auto rounded-pill bg-white/[0.06] px-2 py-0.5 text-[10px] text-muted">{t('teamDetailPage.optionalBadge')}</span>
              </summary>
              <div className="border-t border-ice/[0.06] p-4">
                <p className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-text"><Users2 size={14} className="text-amber" /> {t('teamDetailPage.groupBotLabel')}</p>
                <TelegramBotConnect
                  target={{ agent_id: id, scope: 'group', label: 'Task bot' }}
                  connected={groupConnected}
                  hint={t('teamDetailPage.groupBotHint')}
                  onConnected={() => setGroupConnected(true)}
                />
                <p className="mt-2 rounded-xl border border-ice/[0.07] bg-black/20 p-3 text-[12px] leading-relaxed text-muted">
                  {t('teamDetailPage.specialistNotePart1')}<span className="text-text">{t('teamDetailPage.specialistNoteEmphasis')}</span>{t('teamDetailPage.specialistNotePart2')}
                </p>
              </div>
            </details>
              </>
            )}
          </section>
        </div>

        {/* RIGHT — live results from the DB */}
        <div className="space-y-6">
          <CoordinatorAgentPanel
            mode={isOps ? 'planner' : 'general'}
            context={`Team: ${teamName}. Tasks: ${tasks.map((task) => `${task.title} (${task.status ?? 'todo'}, owner: ${task.owner ?? 'none'})`).join('; ') || 'no saved tasks yet'}.`}
            liveStatus={isLogistics
              ? (tasks.some((task) => !task.owner) ? 'Есть логистические исключения без владельца: назначьте ответственного.' : 'Ручной анализ логистики готов: вставьте CSV отправлений. Живой трекинг перевозчиков пока не подключён, сообщения не отправляются автоматически.')
              : isOps
              ? (tasks.some((task) => !task.owner) ? 'Есть задачи без владельца: назначьте ответственного до начала работы.' : 'Планёрка готова: задачи распределяются, проверяются и закрываются с результатом.')
              : isRegulated
              ? safetyCopy.status
              : safetyCopy.generalStatus}
          />
          {isOps && !isLogistics && <PlannerCommandCenter tasks={tasks} />}
          {isOps && !isLogistics && <PlanerkaSheetCard />}
          {isOps && !isLogistics && <PlanerkaMembersCard />}
          {isOps && <section className="card rounded-3xl p-6">
            <div className="flex items-center gap-2"><BellRing size={18} className="text-amber" /><h2 className="text-lg font-bold text-text">{t('teamDetailPage.adminNotifications')}</h2><span className="ml-auto text-xs text-muted">{notifs.length}</span></div>
            <div className="mt-4 space-y-2">
              {notifs.length === 0 && <p className="rounded-xl border border-dashed border-ice/10 p-5 text-center text-sm text-muted">{t('teamDetailPage.noNotifications')}</p>}
              {notifs.map((n) => (
                <div key={n.id} className="rounded-xl border border-amber/15 bg-amber/[0.04] p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text">{n.title}</span>
                    {n.risk && <span className={cn('ml-auto rounded-full px-2 py-0.5 text-[10px]', riskCls(n.risk))}>{n.risk}</span>}
                  </div>
                  {n.body && <p className="mt-1 text-[13px] leading-relaxed text-muted">{n.body}</p>}
                  {n.target && <p className="mt-1 text-[11px] text-fog">→ {n.target}</p>}
                </div>
              ))}
            </div>
          </section>}

          {isOps && <section className="card rounded-3xl p-6">
            <div className="flex items-center gap-2"><ClipboardList size={18} className="text-cyan" /><h2 className="text-lg font-bold text-text">{t('teamDetailPage.tasksHeading')}</h2><span className="ml-auto text-xs text-muted">{tasks.length}</span></div>
            <div className="mt-4 space-y-2">
              {tasks.length === 0 && <p className="rounded-xl border border-dashed border-ice/10 p-5 text-center text-sm text-muted">{t('teamDetailPage.noTasks')}</p>}
              {tasks.map((tk) => (
                <div key={tk.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-ice/[0.07] p-3">
                  <span className="min-w-0 flex-1 text-sm text-text">{tk.title}</span>
                  {tk.owner && <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-muted">{tk.owner}</span>}
                  {tk.deadline && <span className="text-[11px] text-muted">{tk.deadline}</span>}
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px]', riskCls(tk.priority))}>{tk.priority ?? 'medium'}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', statusCls(tk.status))}>{tk.status ?? 'todo'}</span>
                </div>
              ))}
            </div>
          </section>}

          <section className="card rounded-3xl p-6">
            <div className="flex items-center gap-2"><GitBranch size={18} className="text-violet" /><h2 className="text-lg font-bold text-text">Runs & agent trace</h2><span className="ml-auto text-xs text-muted">{runs.length}</span></div>
            <div className="mt-4 space-y-2">
              {runs.length === 0 && <p className="rounded-xl border border-dashed border-ice/10 p-5 text-center text-sm text-muted">{t('teamDetailPage.noWorkflowRuns')}</p>}
              {runs.map((run) => {
                const isOpen = openRun === run.id
                return (
                  <div key={run.id} className="rounded-xl border border-ice/[0.07]">
                    <button onClick={() => setOpenRun(isOpen ? null : run.id)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
                      <span className="rounded-full bg-violet/10 px-2 py-0.5 text-[10px] text-violet">{run.kind}</span>
                      {run.status === 'needs_review' && <span className="rounded-full bg-amber/10 px-2 py-0.5 text-[10px] text-amber">human review</span>}
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{run.task}</span>
                      <span className="shrink-0 text-[11px] text-muted">{new Date(run.created_at).toLocaleString()}</span>
                      <ChevronDown size={15} className={cn('shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && (
                      <div className="space-y-3 border-t border-ice/[0.07] px-3.5 py-3">
                        {(run.steps ?? []).map((s, i) => (
                          <div key={i} className="rounded-lg bg-white/[0.02] p-2.5">
                            <p className="mb-1 text-[11px] font-medium text-cyan">{s.query}</p>
                            {s.review && (s.review.reviewed_by || s.review.needs_human_review) && (
                              <p className={cn('mb-1.5 text-[10.5px]', s.review.needs_human_review ? 'text-amber' : s.review.approved ? 'text-teal' : 'text-muted')}>
                                {s.review.reviewed_by ? `Peer: ${s.review.reviewed_by} / ${s.review.score ?? 0}/100` : 'Peer review'}
                                {s.review.revised ? ` / revised ${s.review.revisions ?? 1}x` : ''}
                                {s.review.needs_human_review ? ' / human review required' : ''}
                              </p>
                            )}
                            <div className="text-[12px] text-muted"><Markdown content={(s.findings || '—').slice(0, 1200)} /></div>
                          </div>
                        ))}
                        {run.report && (
                          <div className="rounded-lg border border-ice/[0.07] p-3">
                            <p className="mb-1 text-[11px] font-medium text-text">{t('teamDetailPage.managerSummary')}</p>
                            <Markdown content={run.report} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
