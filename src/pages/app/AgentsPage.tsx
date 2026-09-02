import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Plus, Bot, Pencil, Copy, Trash2, MoreVertical, Users, ArrowRight, Play, Settings2, Film, Handshake, Calculator, MessagesSquare, ShieldCheck, ExternalLink, X, FileCheck2, LayoutGrid, List, Sparkles, Search } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAgentStore } from '../../store/useAgentStore'
import { useToast } from '../../components/ui/Toast'
import { channelMeta, channelLabel, agentStatusStyle, agentTypeMeta } from '../../lib/platformMeta'
import { MODELS } from '../../data/platform'
import { AgentAvatar } from '../../components/ui/AgentAvatar'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { cn } from '../../lib/cn'
import { AutonomousRunner } from '../../components/platform/AutonomousRunner'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { BUSINESS_AGENT_PRESETS, guardedPresetRoles, type BusinessAgentPreset, type BusinessPresetId } from '../../data/businessAgentPresets'
import { TeamOfficeView } from '../../components/office/TeamOfficeView'
import { useTeamOfficeStore } from '../../store/useTeamOfficeStore'
import type { OperationalAgentStatus } from '../../types/orchestrator'
import { AgentQuickEditDrawer, type AgentQuickEditDraft } from '../../components/agents/AgentQuickEditDrawer'
import type { PlatformAgent } from '../../types/platform'
import { subscribeTeamRegistryChanged } from '../../lib/teamRegistrySync'
import { teamDisplayName } from '../../lib/teamDisplayName'

type PresetRunStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed'

interface PresetRunState {
  status: PresetRunStatus
  artifacts: string[]
}

interface TeamDepartmentRow { id: string; main_agent_id: string; created_at: string }
interface TeamMemberRow { department_id: string; name: string; role: string }
interface TeamRosterSummary { count: number; roles: string[] }

const PRESET_ICON = {
  media: Film,
  sales: Handshake,
  finance: Calculator,
  support: MessagesSquare,
}

const RUN_LABEL: Record<PresetRunStatus, string> = {
  idle: 'Готов к запуску',
  queued: 'В очереди Runtime',
  running: 'Выполняется',
  completed: 'Завершено',
  failed: 'Требует внимания',
}

const OFFICE_STATUS: Record<PresetRunStatus, OperationalAgentStatus> = {
  idle: 'idle', queued: 'queued', running: 'working', completed: 'completed', failed: 'failed',
}

const PRESET_TASK: Record<BusinessPresetId, string> = {
  'media-studio': 'video_rendering',
  'sales-manager': 'brief_analysis',
  'finance-analyst': 'estimate_calculation',
  'support-assistant': 'brief_analysis',
}

function artifactUrls(result: string): string[] {
  return [...new Set(result.match(/https?:\/\/[^\s)\]}>'"]+/g) ?? [])]
    .filter((url) => /\.(pdf|mp4|webm|docx|pptx|csv)(\?|$)|\/storage\/|\/object\//i.test(url))
    .slice(0, 6)
}

export default function AgentsPage() {
  const { lang, t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const { agents, toggleAgent, duplicateAgent, deleteAgent, updateAgent, hydrate, accountId } = useAgentStore()
  const setPresetRuntimeTeam = useTeamOfficeStore((state) => state.setPresetRuntimeTeam)
  const [menu, setMenu] = useState<string | null>(null)
  const [quickEditAgentId, setQuickEditAgentId] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<string | null>(null)
  const [activePresetId, setActivePresetId] = useState<BusinessPresetId | null>(null)
  const [goal, setGoal] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')
  const [model, setModel] = useState('')
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.9)
  const [requireCitations, setRequireCitations] = useState(true)
  const [requireApproval, setRequireApproval] = useState(true)
  const [runStates, setRunStates] = useState<Partial<Record<BusinessPresetId, PresetRunState>>>({})
  const [teamSearch, setTeamSearch] = useState('')
  const [teamRoster, setTeamRoster] = useState<Record<string, TeamRosterSummary>>({})
  const teamsView = location.pathname.startsWith('/app/teams')
  const officeView = location.pathname === '/app/agents'
  const visibleAgents = agents.filter((a) => teamsView ? a.type === 'workflow' : a.type !== 'workflow')
  const savedTeams = useMemo(() => agents.filter((agent) => agent.type === 'workflow'), [agents])
  const normalizedTeamSearch = teamSearch.trim().toLowerCase()
  const filteredTeams = teamsView && normalizedTeamSearch
    ? visibleAgents.filter((team) => `${teamDisplayName({ name: team.name, goal: team.purpose, niche: team.niche, tasks: team.prompt.tasks, lang })} ${team.purpose} ${team.niche ?? ''} ${(teamRoster[team.id]?.roles ?? []).join(' ')}`.toLowerCase().includes(normalizedTeamSearch))
    : visibleAgents
  const registryCopy = lang === 'uz' ? {
    search: 'Jamoani nomi, roli yoki vazifasi bo‘yicha qidiring…', searchLabel: 'AI jamoalarni qidirish', specialists: 'mutaxassis', noResults: 'Hech qanday jamoa topilmadi',
  } : lang === 'en' ? {
    search: 'Find a team by name, role, or task…', searchLabel: 'Search AI teams', specialists: 'specialists', noResults: 'No matching teams',
  } : {
    search: 'Найти команду по названию, роли или задаче…', searchLabel: 'Поиск AI-команд', specialists: 'специалистов', noResults: 'Команды не найдены',
  }
  const quickEditAgent = agents.find((agent) => agent.id === quickEditAgentId) ?? null

  useEffect(() => {
    if (!teamsView) return
    const refresh = () => void hydrate({ forceProfile: true })
    refresh()
    const unsubscribe = subscribeTeamRegistryChanged(refresh)
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [hydrate, teamsView])

  useEffect(() => {
    if (!teamsView || !isSupabaseEnabled || !supabase || !accountId || accountId === 'demo') return
    const client = supabase
    const channel = client
      .channel(`team-registry:${accountId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agents', filter: `account_id=eq.${accountId}` }, () => {
        void hydrate()
      })
      .subscribe()
    return () => { void client.removeChannel(channel) }
  }, [accountId, hydrate, teamsView])

  const saveQuickEdit = async (agent: PlatformAgent, draft: AgentQuickEditDraft) => updateAgent(agent.id, {
    name: draft.name.trim(),
    role: draft.role.trim(),
    model: draft.model,
    temperature: draft.temperature,
    language: draft.language,
    actionPolicy: draft.actionPolicy,
    prompt: {
      ...agent.prompt,
      role: draft.role.trim(),
      tasks: draft.tasks.trim(),
      tone: draft.tone.trim(),
      rules: draft.rules.trim(),
    },
    configRevision: (agent.configRevision ?? 1) + 1,
    status: agent.status === 'active' ? 'draft' : agent.status,
  })

  useEffect(() => {
    if (!teamsView || savedTeams.length === 0 || !isSupabaseEnabled || !supabase) return

    let cancelled = false

    void (async () => {
      await Promise.resolve()
      if (cancelled) return
      try {
        const { data: departments, error: departmentError } = await supabase
          .from('departments')
          .select('id, main_agent_id, created_at')
          .in('main_agent_id', savedTeams.map((team) => team.id))
          .order('created_at', { ascending: false })

        if (cancelled) return
        if (departmentError) {
          return
        }
        const departmentRows = [...new Map([...((departments ?? []) as TeamDepartmentRow[])].reverse().map((department) => [department.main_agent_id, department])).values()]
        if (departmentRows.length === 0) {
          setTeamRoster({})
          return
        }

        const { data: members, error: membersError } = await supabase
          .from('sub_agents')
          .select('department_id, name, role')
          .in('department_id', departmentRows.map((department) => department.id))
          .order('created_at', { ascending: true })

        if (cancelled) return
        if (membersError) return
        const teamByDepartment = new Map(departmentRows.map((department) => [department.id, department.main_agent_id]))
        const next: Record<string, TeamRosterSummary> = {}
        for (const member of (members ?? []) as TeamMemberRow[]) {
          const teamId = teamByDepartment.get(member.department_id)
          if (!teamId) continue
          const summary = next[teamId] ?? { count: 0, roles: [] }
          summary.count += 1
          if (member.role && !summary.roles.includes(member.role) && summary.roles.length < 3) summary.roles.push(member.role)
          next[teamId] = summary
        }
        setTeamRoster(next)
      } catch { /* Cards remain usable when the optional roster query is unavailable. */ }
    })()

    return () => { cancelled = true }
  }, [savedTeams, teamsView])

  const modelLabel = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id
  const activePreset = BUSINESS_AGENT_PRESETS.find((preset) => preset.id === activePresetId) ?? null
  const activeRoles = useMemo(() => activePreset ? guardedPresetRoles(activePreset, {
    customPrompt,
    confidenceThreshold,
    requireCitations,
    requireApproval,
  }) : [], [activePreset, customPrompt, confidenceThreshold, requireCitations, requireApproval])

  const openPreset = (preset: BusinessAgentPreset) => {
    setActivePresetId(preset.id)
    setGoal(preset.defaultGoal)
    setCustomPrompt('')
    setModel(preset.defaultModel)
    setConfidenceThreshold(0.9)
    setRequireCitations(true)
    setRequireApproval(true)
  }

  const onPresetState = useCallback((status: PresetRunStatus) => {
    if (!activePresetId) return
    setRunStates((current) => ({
      ...current,
      [activePresetId]: { status, artifacts: current[activePresetId]?.artifacts ?? [] },
    }))
    setPresetRuntimeTeam(activePresetId, activeRoles.map((role) => ({ ...role, model })), OFFICE_STATUS[status], PRESET_TASK[activePresetId])
  }, [activePresetId, activeRoles, model, setPresetRuntimeTeam])

  const onPresetComplete = useCallback((result: string) => {
    if (!activePresetId) return
    setRunStates((current) => ({
      ...current,
      [activePresetId]: { status: 'completed', artifacts: artifactUrls(result) },
    }))
  }, [activePresetId])

  return (
    <div className="container-page max-w-6xl overflow-x-hidden py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-normal tracking-tight text-text">{teamsView ? t('agentsPage.teamsTitle') : t('agentsPage.agentsTitle')}</h1>
          <p className="mt-1 text-sm text-muted">{teamsView ? t('agentsPage.teamsSubtitle') : t('agentsPage.agentsSubtitle')}</p>
        </div>
        <Button to="/app?create=team" size="md">
          <Plus size={16} /> {t('agentsPage.createTeam')}
        </Button>
      </div>

      <nav className="mt-5 flex w-full gap-1 overflow-x-auto rounded-2xl border border-white/8 bg-panel/70 p-1 sm:w-fit" aria-label={t('teamOffice.navTeams')}>
        {[
          { to: '/app/agents', label: t('teamOffice.office'), icon: LayoutGrid, active: officeView },
          { to: '/app/teams', label: t('teamOffice.navTeams'), icon: List, active: teamsView },
          { to: '/app?create=team', label: t('teamOffice.builder'), icon: Sparkles, active: false },
        ].map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40',
              tab.active ? 'bg-bg text-text shadow-sm' : 'text-muted hover:bg-white/[0.04] hover:text-text',
            )}
          >
            <tab.icon size={14} className={cn('shrink-0', tab.active && 'text-cyan')} />
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {!teamsView && (
        <section className="mt-7" aria-labelledby="business-teams-heading">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan">Production teams</p>
              <h2 id="business-teams-heading" className="mt-1 text-lg font-medium text-text">Боевые команды для бизнеса</h2>
              <p className="mt-1 max-w-3xl text-sm text-muted">Запускаются через Durable Runtime, используют изолированные compute-профили и передают неподтверждённые решения человеку.</p>
            </div>
            <span className={cn('inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs', isSupabaseEnabled ? 'border-teal/25 bg-teal/10 text-teal' : 'border-amber/25 bg-amber/10 text-amber')}>
              <span className={cn('h-1.5 w-1.5 rounded-full', isSupabaseEnabled ? 'bg-teal' : 'bg-amber')} />
              {isSupabaseEnabled ? 'Live Runtime' : 'Demo mode'}
            </span>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {BUSINESS_AGENT_PRESETS.map((preset) => {
              const Icon = PRESET_ICON[preset.icon]
              const state = runStates[preset.id] ?? { status: 'idle' as const, artifacts: [] }
              return (
                <article key={preset.id} className="card group relative overflow-hidden rounded-2xl p-5">
                  <div className="absolute inset-x-0 top-0 h-px opacity-80" style={{ background: `linear-gradient(90deg, transparent, ${preset.accent}, transparent)` }} />
                  <div className="flex items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl" style={{ background: `${preset.accent}18`, color: preset.accent }}><Icon size={21} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-medium text-text">{preset.title}</h3>
                        <span className={cn('rounded-full px-2 py-1 text-[10px] font-medium', state.status === 'completed' ? 'bg-teal/10 text-teal' : state.status === 'failed' ? 'bg-danger/10 text-danger' : state.status === 'running' || state.status === 'queued' ? 'bg-cyan/10 text-cyan' : 'bg-white/5 text-muted')}>{RUN_LABEL[state.status]}</span>
                      </div>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted">{preset.description}</p>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {preset.roles.map((role) => <span key={role.name} className="rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1 text-[11px] text-fog">{role.role}</span>)}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {preset.integrations.map((item) => <span key={item} className="rounded-lg px-2 py-1 text-[10px] font-medium" style={{ background: `${preset.accent}10`, color: preset.accent }}>{item}</span>)}
                  </div>

                  {state.artifacts.length > 0 && (
                    <div className="mt-4 rounded-xl border border-teal/15 bg-teal/[0.04] p-3">
                      <p className="flex items-center gap-1.5 text-[11px] font-medium text-teal"><FileCheck2 size={13} /> Артефакты Runtime</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {state.artifacts.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-cyan hover:underline">Файл {index + 1}<ExternalLink size={11} /></a>)}
                      </div>
                    </div>
                  )}

                  <div className="mt-5 flex items-center gap-2">
                    <Button size="sm" className="flex-1" onClick={() => openPreset(preset)}><Play size={14} /> Запустить задачу</Button>
                    <button type="button" onClick={() => openPreset(preset)} className="rounded-xl border border-white/10 p-2 text-muted transition hover:border-white/20 hover:text-text" aria-label={`Настроить ${preset.title}`}><Settings2 size={15} /></button>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {teamsView && savedTeams.length > 0 && (
        <div className="relative mt-7 max-w-xl">
          <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={teamSearch}
            onChange={(event) => setTeamSearch(event.target.value)}
            placeholder={registryCopy.search}
            aria-label={registryCopy.searchLabel}
            className="w-full rounded-2xl border border-ice/10 bg-panel/60 py-3 pl-10 pr-4 text-sm text-text outline-none transition placeholder:text-fog focus:border-cyan/35 focus:ring-2 focus:ring-cyan/10"
          />
        </div>
      )}

      {!teamsView && <TeamOfficeView platformAgents={visibleAgents} />}

      {filteredTeams.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={Bot}
            title={teamsView && normalizedTeamSearch ? registryCopy.noResults : teamsView ? t('agentsPage.emptyTeamsTitle') : t('agentsPage.emptyAgentsTitle')}
            desc={teamsView ? t('agentsPage.emptyTeamsDesc') : t('agentsPage.emptyAgentsDesc')}
            action={
              <Button to={teamsView ? '/app?create=team' : '/app?create=agent'} size="sm">
                <Plus size={15} /> {teamsView ? t('agentsPage.createTeam') : t('agentsPage.createAgent')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredTeams.map((a) => (
            teamsView ? (
              // Simple, browsable AI-team card: name, one-line description, status, Open.
              <div key={a.id} className="card group relative flex min-h-[188px] flex-col rounded-2xl p-5">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet/15 text-violet"><Users size={20} /></span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text">{teamDisplayName({ name: a.name, goal: a.purpose, niche: a.niche, tasks: a.prompt.tasks, lang })}</p>
                    <span className={cn('mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-normal', agentStatusStyle[a.status])}>{t(`platform.agentStatus.${a.status}`)}</span>
                  </div>
                </div>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-muted line-clamp-3">{a.purpose || a.prompt.tasks || t('agentsPage.teamCardFallback')}</p>
                <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-ice/[0.06] pt-3">
                  <span className="rounded-full border border-cyan/15 bg-cyan/[0.06] px-2.5 py-1 text-[11px] text-cyan">
                    {teamRoster[a.id]?.count ?? 0} {registryCopy.specialists}
                  </span>
                  {(teamRoster[a.id]?.roles ?? []).map((role) => (
                    <span key={role} className="max-w-32 truncate rounded-full bg-white/[0.04] px-2.5 py-1 text-[10px] text-muted">{role}</span>
                  ))}
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <Button size="sm" className="flex-1" onClick={() => navigate(`/app/teams/${a.id}`)}>{t('agentsPage.openTeam')} <ArrowRight size={15} /></Button>
                  <button onClick={() => setToDelete(a.id)} className="rounded-lg p-2 text-muted hover:bg-ice/[0.06] hover:text-danger" aria-label={t('platform.agents.delete')}><Trash2 size={15} /></button>
                </div>
              </div>
            ) : (
            <div key={a.id} className="card group relative rounded-2xl p-5">
              <div className="flex items-start justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <AgentAvatar color={a.avatarColor} glyph="search" size="lg" />
                  <div className="min-w-0">
                    <p className="truncate font-normal text-text">{a.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className={cn('inline-block rounded-full px-2 py-0.5 text-[10px] font-normal', agentStatusStyle[a.status])}>
                        {t(`platform.agentStatus.${a.status}`)}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: `${agentTypeMeta[a.type].color}1f`, color: agentTypeMeta[a.type].color }}>
                        {(() => {
                          const TIcon = agentTypeMeta[a.type].Icon
                          return <TIcon size={10} />
                        })()}
                        {t(agentTypeMeta[a.type].key)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="relative shrink-0">
                  <button onClick={() => setMenu(menu === a.id ? null : a.id)} aria-label={t('common.menu')} className="rounded-lg p-1.5 text-muted hover:bg-ice/[0.06]">
                    <MoreVertical size={16} />
                  </button>
                  {menu === a.id && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
                      <div className="card absolute right-0 z-20 mt-1 w-44 rounded-xl p-1.5">
                        <MenuBtn icon={Pencil} label={a.type === 'workflow' ? t('agentsPage.openAiTeam') : t('agentsPage.editEmployee')} onClick={() => { setMenu(null); if (a.type === 'workflow') navigate(`/app/teams/${a.id}`); else setQuickEditAgentId(a.id) }} />
                        <MenuBtn
                          icon={Copy}
                          label={t('platform.agents.duplicate')}
                          onClick={() => {
                            duplicateAgent(a.id)
                            setMenu(null)
                            toast(t('platform.toast.duplicated'))
                          }}
                        />
                        <MenuBtn
                          icon={Trash2}
                          label={t('platform.agents.delete')}
                          danger
                          onClick={() => {
                            setToDelete(a.id)
                            setMenu(null)
                          }}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                {a.channels.length ? (
                  a.channels.map((c) => {
                    const meta = channelMeta[c]
                    return (
                      <span key={c} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ background: `${meta.color}1f`, color: meta.color }}>
                        <meta.Icon size={12} /> {channelLabel(c, t)}
                      </span>
                    )
                  })
                ) : (
                  <span className="text-[11px] text-muted">—</span>
                )}
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-ice/[0.06] pt-3 text-xs text-muted">
                <span className="rounded-md bg-ice/[0.06] px-1.5 py-0.5 font-medium text-muted">{modelLabel(a.model)}</span>
                <span>
                  {a.dialoguesToday} {t('platform.agents.dialoguesToday')} · {a.lastActivity}
                </span>
              </div>

              <div className="mt-4 flex items-center gap-2">
                <Button size="sm" variant="ghost" className="flex-1" onClick={() => { if (a.type === 'workflow') navigate(`/app/teams/${a.id}`); else setQuickEditAgentId(a.id) }}>
                  <Pencil size={14} /> {a.type === 'workflow' ? t('agentsPage.openAiTeam') : t('agentsPage.editEmployee')}
                </Button>
                <button
                  onClick={() => toggleAgent(a.id)}
                  className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors', a.status === 'active' ? 'bg-teal' : 'bg-ice/15')}
                  role="switch"
                  aria-checked={a.status === 'active'}
                  title={a.status === 'active' ? t('platform.agents.disable') : t('platform.agents.enable')}
                >
                  <span className={cn('absolute top-0.5 h-6 w-6 rounded-full bg-ice shadow transition-all', a.status === 'active' ? 'left-[22px]' : 'left-0.5')} />
                </button>
              </div>
            </div>
            )
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!toDelete}
        title={t('platform.agents.deleteTitle')}
        message={t('platform.agents.deleteMsg')}
        confirmLabel={t('platform.agents.delete')}
        cancelLabel={t('common.cancel')}
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) {
            deleteAgent(toDelete)
            toast(t('platform.toast.deleted'))
          }
          setToDelete(null)
        }}
      />

      <AgentQuickEditDrawer
        agent={quickEditAgent}
        onClose={() => setQuickEditAgentId(null)}
        onSave={saveQuickEdit}
      />

      {activePreset && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="preset-runner-title">
          <div className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-t-3xl border border-white/10 bg-panel shadow-2xl sm:rounded-3xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-white/8 bg-panel/95 px-5 py-4 backdrop-blur sm:px-6">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: activePreset.accent }}>Durable team runner</p>
                <h2 id="preset-runner-title" className="mt-1 text-xl font-medium text-text">{activePreset.title}</h2>
                <p className="mt-1 text-xs text-muted">{activePreset.roles.map((role) => role.role).join(' → ')}</p>
              </div>
              <button type="button" onClick={() => setActivePresetId(null)} className="rounded-xl p-2 text-muted hover:bg-white/5 hover:text-text" aria-label="Закрыть"><X size={19} /></button>
            </div>

            <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[0.36fr_0.64fr]">
              <aside className="space-y-4">
                <div className="rounded-2xl border border-white/8 bg-black/10 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-text"><Settings2 size={15} className="text-violet" /> Системные параметры</h3>
                  <label className="mt-4 block text-xs text-muted">Модель
                    <select value={model} onChange={(event) => setModel(event.target.value)} className="mt-1.5 w-full rounded-xl border border-white/10 bg-bg px-3 py-2 text-sm text-text outline-none focus:border-violet/50">
                      {MODELS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                  <label className="mt-4 block text-xs text-muted">Дополнение к системному промпту
                    <textarea value={customPrompt} onChange={(event) => setCustomPrompt(event.target.value)} rows={5} placeholder="Тон, рынок, ограничения, формат результата…" className="mt-1.5 w-full resize-y rounded-xl border border-white/10 bg-bg px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
                  </label>
                  <label className="mt-4 block text-xs text-muted">Порог уверенности: <span className="font-medium text-text">{confidenceThreshold.toFixed(2)}</span>
                    <input type="range" min="0.75" max="0.99" step="0.01" value={confidenceThreshold} onChange={(event) => setConfidenceThreshold(Number(event.target.value))} className="mt-2 w-full accent-cyan" />
                  </label>
                  <label className="mt-4 flex items-start gap-2 text-xs text-muted"><input type="checkbox" checked={requireCitations} onChange={(event) => setRequireCitations(event.target.checked)} className="mt-0.5 accent-cyan" /><span>Требовать источники для внешних фактов</span></label>
                  <label className="mt-3 flex items-start gap-2 text-xs text-muted"><input type="checkbox" checked={requireApproval} onChange={(event) => setRequireApproval(event.target.checked)} className="mt-0.5 accent-cyan" /><span>Согласовывать внешние действия</span></label>
                </div>
                <div className="rounded-2xl border border-cyan/15 bg-cyan/[0.04] p-4">
                  <p className="flex items-center gap-2 text-xs font-medium text-cyan"><ShieldCheck size={14} /> Anti-hallucination gate</p>
                  <p className="mt-2 text-xs leading-relaxed text-muted">Источники и расчёты проверяются вторым агентом. Недостающие данные помечаются «Не подтверждено», а confidence ниже порога переводит задачу на согласование.</p>
                </div>
              </aside>

              <main className="min-w-0">
                <AutonomousRunner
                  goalValue={goal}
                  onGoalChange={setGoal}
                  presetSpecs={activeRoles}
                  contextKey={`business-preset:${activePreset.id}`}
                  contextHint={`Боевой пресет: ${activePreset.title}. Допустимые compute profiles: ${activePreset.profiles.join(', ')}. Разрешённые интеграции: ${activePreset.integrations.join(', ')}. Fail closed: не выполняй внешние действия без Runtime approval.`}
                  model={model}
                  postActions
                  placeholder="Опишите задачу и приложите подтверждающие файлы…"
                  onRunStateChange={onPresetState}
                  onComplete={onPresetComplete}
                />
              </main>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MenuBtn({ icon: Icon, label, onClick, danger }: { icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-ice/[0.05]',
        danger ? 'text-danger' : 'text-muted hover:text-text',
      )}
    >
      <Icon size={15} /> {label}
    </button>
  )
}
