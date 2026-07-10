import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Users, Bot, PlayCircle, ClipboardList, BellRing, GitBranch, ChevronDown, Wallet, ListChecks, Send, Users2 } from 'lucide-react'
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
import { cn } from '../../lib/cn'

interface Sub { id: string; role: string; name: string; prompt: { role?: string; tasks?: string } }
interface Dept { id: string; name: string; niche?: string; subs: Sub[] }
interface Task { id: string; title: string; owner?: string; deadline?: string; priority?: string; status?: string }
interface Notif { id: string; title: string; body?: string; risk?: string; target?: string; created_at: string }
interface Run { id: string; task: string; kind: string; report?: string; steps?: { query: string; findings: string }[]; created_at: string }

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
      supabase.from('research_runs').select('id, task, kind, report, steps, created_at').eq('department_id', deptId).order('created_at', { ascending: false }).limit(10),
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
      const { data: chs } = await supabase!.from('channels').select('sub_agent_id, scope').eq('agent_id', id).eq('type', 'telegram')
      if (on) {
        const list = (chs ?? []) as { sub_agent_id: string | null; scope: string | null }[]
        setSubBots(new Set(list.filter((c) => c.sub_agent_id).map((c) => c.sub_agent_id as string)))
        setGroupConnected(list.some((c) => c.scope === 'group'))
        setTgConnected(list.some((c) => !c.sub_agent_id && c.scope !== 'group'))
      }
      await loadResults(d.id)
    })()
    return () => { on = false }
  }, [id, loadResults])

  const teamName = team?.name || dept?.name || 'Operations Team'
  const goal = team?.purpose || 'Automate routine operations: payments, admin escalation, meetings-to-tasks and manager reports.'

  // Show operations scenarios (payment/retention/meeting) ONLY for operations-type
  // teams; a content/sales/other team just gets the universal "task the team" runner.
  const teamBlob = `${team?.purpose ?? ''} ${team?.niche ?? ''} ${dept?.niche ?? ''} ${(dept?.subs ?? []).map((s) => `${s.role} ${s.prompt?.tasks ?? ''}`).join(' ')}`.toLowerCase()
  const isOps = /оплат|payment|платеж|ученик|студент|student|посещ|attendance|churn|уход|неоплат|meeting|совещ|встреч|отчёт по задач|task manager|admin control|payment reminder/.test(teamBlob)

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
                    <TelegramBotConnect compact target={{ sub_agent_id: sa.id }} connected={subBots.has(sa.id)} onConnected={() => setSubBots((prev) => new Set(prev).add(sa.id))} />
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
            <div className="mt-4">
              <AutonomousRunner
                key={dept?.id ?? 'team'}
                presetSpecs={(dept?.subs ?? []).map((s) => ({ role: s.role, name: s.name, prompt: s.prompt }))}
                contextHint={goal}
                placeholder={t('teamDetailPage.taskToTeamPlaceholder')}
              />
            </div>
          </section>

          {/* Operations scenarios — only for operations-type teams */}
          {isOps && (
            <section className="card rounded-3xl p-6">
              <div className="flex items-center gap-2"><PlayCircle size={18} className="text-violet" /><h2 className="text-lg font-bold text-text">{t('teamDetailPage.opsScenariosTitle')}</h2></div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button onClick={() => setKind('retention_scan')} className={cn('inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm', kind === 'retention_scan' ? 'border-danger/40 bg-danger/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>
                  <BellRing size={15} /> {t('teamDetailPage.churnBtn')}
                </button>
                <button onClick={() => setKind('payment_control')} className={cn('inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm', kind === 'payment_control' ? 'border-violet/40 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>
                  <Wallet size={15} /> {t('teamDetailPage.paymentControl')}
                </button>
                <button onClick={() => setKind('meeting_to_tasks')} className={cn('inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm', kind === 'meeting_to_tasks' ? 'border-violet/40 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:text-text')}>
                  <ListChecks size={15} /> {t('teamDetailPage.meetingToTasks')}
                </button>
              </div>
              <div className="mt-4">
                <OpsWorkflowRunner
                  key={kind}
                  kind={kind}
                  departmentId={dept?.id}
                  sampleInput={kind === 'retention_scan' ? SAMPLE_RETENTION : kind === 'payment_control' ? SAMPLE_PAYMENT : SAMPLE_MEETING}
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
          </section>
        </div>

        {/* RIGHT — live results from the DB */}
        <div className="space-y-6">
          <CoordinatorAgentPanel
            mode="planner"
            context={`Team: ${teamName}. Tasks: ${tasks.map((task) => `${task.title} (${task.status ?? 'todo'}, owner: ${task.owner ?? 'none'})`).join('; ') || 'no saved tasks yet'}.`}
            liveStatus={tasks.some((task) => !task.owner) ? 'Есть задача без владельца. Диспетчер должен назначить ответственного до начала работы.' : 'Планёрка готова: задачи можно распределять, проверять и закрывать только с результатом.'}
          />
          <PlannerCommandCenter tasks={tasks} />
          <PlanerkaSheetCard />
          <PlanerkaMembersCard />
          <section className="card rounded-3xl p-6">
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
          </section>

          <section className="card rounded-3xl p-6">
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
          </section>

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
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{run.task}</span>
                      <span className="shrink-0 text-[11px] text-muted">{new Date(run.created_at).toLocaleString()}</span>
                      <ChevronDown size={15} className={cn('shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && (
                      <div className="space-y-3 border-t border-ice/[0.07] px-3.5 py-3">
                        {(run.steps ?? []).map((s, i) => (
                          <div key={i} className="rounded-lg bg-white/[0.02] p-2.5">
                            <p className="mb-1 text-[11px] font-medium text-cyan">{s.query}</p>
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
