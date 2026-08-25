import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, Bot, Check, ChevronRight, CircleDot, Clock3, Focus,
  FileText, Film, Inbox, Loader2, Minus, Plus, RefreshCw, Send, Sparkles, X,
} from 'lucide-react'
import { IsometricOfficeRoom, type OfficeAgentNode, type OfficeAgentRole } from './office/IsometricOfficeRoom'
import { getAccessToken, supabase } from '../lib/supabase'

const POLL_INTERVAL_MS = 3_000
const TEAM_STORAGE_KEY = 'nemo.virtual-office.team.v2'
const GATEWAY = String(import.meta.env.VITE_API_GATEWAY_URL ?? '').trim().replace(/\/+$/, '')

type ComputeProfile = 'PROFILE_A_WASI' | 'PROFILE_B_DOCS' | 'PROFILE_C_BROWSER'
type WorkflowState =
  | 'received' | 'classified' | 'planned' | 'waiting_for_policy'
  | 'executing' | 'checkpointed' | 'waiting_for_approval'
  | 'waiting_for_action' | 'completed' | 'failed' | 'cancelled'

interface WorkflowStatus {
  state: WorkflowState
  profile?: ComputeProfile
  workflowId?: string
}

interface Metrics {
  inbox_total: number
  outbox_delivered: number
  live_gate_status: 'eligible' | 'blocked' | 'stale' | 'no_data'
  f1_score: number
  uptime_seconds: number
  active_workflow_state?: WorkflowState
  active_compute_profile?: ComputeProfile
  active_workflow_id?: string
}

interface Approval {
  id: string
  workflow_id: string
  summary: string
  status: 'pending'
}

interface ChatMessage {
  id: string
  author: 'coordinator' | 'user' | 'system'
  body: string
  timestamp: string
  artifacts?: { name: string; kind: 'document' | 'video' }[]
}

interface ActivityEvent {
  id: string
  label: string
  timestamp: string
  tone: 'cyan' | 'violet' | 'emerald' | 'amber'
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'welcome', author: 'coordinator',
    body: 'Я Nemo Coordinator. Опишите результат — я соберу команду, распределю работу и покажу движение каждого агента в офисе.',
    timestamp: 'сейчас',
  },
  {
    id: 'privacy', author: 'system',
    body: 'В журнале отображаются только безопасные этапы работы. Внутренние рассуждения моделей и секреты не выводятся.',
    timestamp: 'system',
  },
]

type SpecialistRole = Exclude<OfficeAgentRole, 'coordinator' | 'specialist'>

const COORDINATOR: OfficeAgentNode = { id: 'lead', name: 'Nemo Lead', role: 'coordinator', state: 'idle', status: 'Координирую команду' }
const SPECIALISTS: Record<SpecialistRole, OfficeAgentNode> = {
  copywriter: { id: 'copy', name: 'Mira · Copy', role: 'copywriter', state: 'idle', status: 'Ожидаю бриф' },
  finance: { id: 'finance', name: 'Arman · Finance', role: 'finance', state: 'idle', status: 'Ожидаю расчёт' },
  media: { id: 'media', name: 'Kai · Media', role: 'media', state: 'idle', status: 'Ожидаю монтаж' },
}

const ROLE_STATUS: Record<SpecialistRole, { working: string; complete: string }> = {
  copywriter: { working: 'Пишу сценарий', complete: 'Сценарий готов' },
  finance: { working: 'Считаю смету', complete: 'Смета готова' },
  media: { working: 'Рендерю видео', complete: 'Видео готово' },
}

function apiUrl(path: string): string {
  return GATEWAY ? `${GATEWAY}${path}` : path
}

function currentTime(): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date())
}

async function dashboardRequest(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const token = await getAccessToken()
  if (!token) throw new Error('DASHBOARD_SESSION_UNAVAILABLE')
  const response = await fetch(apiUrl(path), {
    ...init, signal,
    headers: {
      Accept: 'application/json', Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error('DASHBOARD_REQUEST_FAILED')
  return await response.json() as Record<string, unknown>
}

function readWorkflowState(value: unknown): WorkflowState | undefined {
  const allowed: WorkflowState[] = ['received', 'classified', 'planned', 'waiting_for_policy', 'executing', 'checkpointed', 'waiting_for_approval', 'waiting_for_action', 'completed', 'failed', 'cancelled']
  return typeof value === 'string' && allowed.includes(value as WorkflowState) ? value as WorkflowState : undefined
}

function readProfile(value: unknown): ComputeProfile | undefined {
  return value === 'PROFILE_A_WASI' || value === 'PROFILE_B_DOCS' || value === 'PROFILE_C_BROWSER' ? value : undefined
}

function readMetrics(value: unknown): Metrics | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const numbers = [raw.inbox_total, raw.outbox_delivered, raw.f1_score, raw.uptime_seconds]
  if (numbers.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) return null
  if (raw.live_gate_status !== 'eligible' && raw.live_gate_status !== 'blocked' && raw.live_gate_status !== 'stale' && raw.live_gate_status !== 'no_data') return null
  return {
    inbox_total: raw.inbox_total as number,
    outbox_delivered: raw.outbox_delivered as number,
    f1_score: raw.f1_score as number,
    uptime_seconds: raw.uptime_seconds as number,
    live_gate_status: raw.live_gate_status,
    active_workflow_state: readWorkflowState(raw.active_workflow_state),
    active_compute_profile: readProfile(raw.active_compute_profile),
    active_workflow_id: typeof raw.active_workflow_id === 'string' ? raw.active_workflow_id : undefined,
  }
}

function readApprovals(value: unknown): Approval[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    if (raw.status !== 'pending' || typeof raw.id !== 'string' || typeof raw.workflow_id !== 'string') return []
    return [{ id: raw.id, workflow_id: raw.workflow_id, summary: String(raw.summary ?? '').slice(0, 1000), status: 'pending' as const }]
  })
}

function profileForBrief(brief: string): ComputeProfile {
  if (/видео|ролик|рилс|reels|монтаж|субтитр/i.test(brief)) return 'PROFILE_C_BROWSER'
  if (/смет|финанс|бюджет|стоимост|расч[её]т|маржин/i.test(brief)) return 'PROFILE_A_WASI'
  return 'PROFILE_B_DOCS'
}

function specialistsForBrief(brief: string): SpecialistRole[] {
  const roles = new Set<SpecialistRole>()
  if (/видео|ролик|рилс|reels|монтаж|субтитр|промо/i.test(brief)) {
    roles.add('copywriter')
    roles.add('media')
  }
  if (/смет|финанс|бюджет|стоимост|расч[её]т|маржин|цена/i.test(brief)) roles.add('finance')
  if (/текст|сценар|пост|копирайт|описан|контент/i.test(brief)) roles.add('copywriter')
  if (roles.size === 0) roles.add('copywriter')
  return [...roles]
}

function highLevelStage(status: WorkflowStatus | undefined, approval: boolean): string {
  if (approval || status?.state === 'waiting_for_approval') return 'Ожидает согласования'
  if (!status) return 'Команда свободна'
  if (status.profile === 'PROFILE_C_BROWSER') return 'Рендер видео'
  if (status.profile === 'PROFILE_A_WASI') return 'Расчёт сметы'
  if (status.profile === 'PROFILE_B_DOCS') return 'Готовим материалы'
  return 'Анализ брифа'
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  return days ? `${days}д ${hours}ч` : `${hours}ч`
}

function loadExtraAgents(): number {
  try {
    const value = Number(localStorage.getItem(TEAM_STORAGE_KEY) ?? 0)
    return Number.isInteger(value) ? Math.min(3, Math.max(0, value)) : 0
  } catch {
    return 0
  }
}

export function VirtualOffice() {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [workflow, setWorkflow] = useState<WorkflowStatus | undefined>()
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES)
  const [activities, setActivities] = useState<ActivityEvent[]>([
    { id: 'ready', label: 'Координатор готов сформировать команду', timestamp: 'сейчас', tone: 'emerald' },
  ])
  const [brief, setBrief] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [extraAgents, setExtraAgents] = useState(loadExtraAgents)
  const [spawnedRoles, setSpawnedRoles] = useState<SpecialistRole[]>([])
  const [assignedRoles, setAssignedRoles] = useState<SpecialistRole[]>([])
  const simulationTimers = useRef<number[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try { localStorage.setItem(TEAM_STORAGE_KEY, String(extraAgents)) } catch { /* session-only customization */ }
  }, [extraAgents])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [messages])

  const addActivity = useCallback((label: string, tone: ActivityEvent['tone'] = 'cyan') => {
    setActivities((current) => [{ id: crypto.randomUUID(), label, timestamp: currentTime(), tone }, ...current].slice(0, 8))
  }, [])

  const refresh = useCallback(async (signal?: AbortSignal, background = false) => {
    if (background) setRefreshing(true)
    try {
      const [metricsPayload, approvalsPayload] = await Promise.all([
        dashboardRequest('/v1/dashboard/metrics', {}, signal),
        dashboardRequest('/v1/dashboard/approvals', {}, signal),
      ])
      const nextMetrics = readMetrics(metricsPayload.metrics)
      if (!nextMetrics) throw new Error('DASHBOARD_RESPONSE_INVALID')
      const nextApprovals = readApprovals(approvalsPayload.approvals)
      setMetrics(nextMetrics)
      setApprovals(nextApprovals)
      if (nextMetrics.active_workflow_state) {
        setWorkflow({
          state: nextMetrics.active_workflow_state,
          profile: nextMetrics.active_compute_profile,
          workflowId: nextMetrics.active_workflow_id,
        })
      } else if (nextApprovals[0]) {
        setWorkflow({ state: 'waiting_for_approval', workflowId: nextApprovals[0].workflow_id })
      }
      setError('')
    } catch (requestError) {
      if (!(requestError instanceof DOMException && requestError.name === 'AbortError') && supabase) {
        setError('Live-телеметрия временно недоступна')
      }
    } finally {
      if (background) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(controller.signal, true), POLL_INTERVAL_MS)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh])

  useEffect(() => () => simulationTimers.current.forEach((timer) => window.clearTimeout(timer)), [])

  const activeApproval = approvals[0]
  const stage = highLevelStage(workflow, Boolean(activeApproval))
  const isActive = workflow && !['completed', 'failed', 'cancelled'].includes(workflow.state)

  const agents = useMemo<OfficeAgentNode[]>(() => {
    const waiting = Boolean(activeApproval) || workflow?.state === 'waiting_for_approval'
    const roster = [COORDINATOR, ...spawnedRoles.map((role) => SPECIALISTS[role])]
    const result = roster.map((agent) => {
      if (waiting && agent.role === 'coordinator') return { ...agent, state: 'waiting_approval' as const, status: 'Нужно ваше решение' }
      if (waiting && agent.role !== 'coordinator' && agent.role !== 'specialist' && assignedRoles.includes(agent.role)) {
        return { ...agent, state: 'complete' as const, status: ROLE_STATUS[agent.role].complete }
      }
      if (isActive && agent.role === 'coordinator') return { ...agent, state: 'working' as const, status: 'Координирую workflow' }
      if (isActive && agent.role !== 'coordinator' && agent.role !== 'specialist' && assignedRoles.includes(agent.role)) {
        return { ...agent, state: 'working' as const, status: ROLE_STATUS[agent.role].working }
      }
      return agent
    })
    for (let index = 0; index < extraAgents; index += 1) {
      result.push({
        id: `specialist-${index + 1}`,
        name: `Specialist ${index + 1}`,
        role: 'specialist',
        state: 'idle',
        status: 'Ожидаю задачу',
      })
    }
    return result
  }, [activeApproval, assignedRoles, extraAgents, isActive, spawnedRoles, workflow])

  const hireAgent = () => {
    setExtraAgents((current) => Math.min(3, current + 1))
    if (extraAgents < 3) {
      addActivity('Добавлено новое рабочее место', 'violet')
      setMessages((current) => [...current, { id: crypto.randomUUID(), author: 'coordinator', body: 'Новое рабочее место готово. Специалист присоединён к офису.', timestamp: currentTime() }])
    }
  }

  const removeAgent = () => {
    setExtraAgents((current) => Math.max(0, current - 1))
    if (extraAgents > 0) addActivity('Свободное рабочее место убрано', 'amber')
  }

  const simulateWorkflow = (profile: ComputeProfile, roles: SpecialistRole[]) => {
    setWorkflow({ state: 'planned', profile })
    simulationTimers.current.forEach((timer) => window.clearTimeout(timer))
    simulationTimers.current = [
      window.setTimeout(() => {
        setWorkflow({ state: 'executing', profile })
        addActivity(highLevelStage({ state: 'executing', profile }, false), 'violet')
      }, 850),
      window.setTimeout(() => {
        setWorkflow({ state: 'waiting_for_approval', profile })
        addActivity('Пакет готов к безопасной проверке', 'amber')
        const artifacts: ChatMessage['artifacts'] = []
        if (roles.includes('copywriter')) artifacts.push({ name: 'campaign-script.pdf', kind: 'document' })
        if (roles.includes('finance')) artifacts.push({ name: 'service-estimate.pdf', kind: 'document' })
        if (roles.includes('media')) artifacts.push({ name: 'promo-cut.mp4', kind: 'video' })
        setMessages((current) => [...current, {
          id: crypto.randomUUID(),
          author: 'coordinator',
          body: 'Orca DAG завершён. Артефакты собраны и переданы в Human-in-the-Loop для проверки.',
          timestamp: currentTime(),
          artifacts,
        }])
      }, 5600),
    ]
  }

  const submitBrief = async () => {
    const goal = brief.trim().slice(0, 4000)
    if (!goal || submitting) return
    const profile = profileForBrief(goal)
    const roles = specialistsForBrief(goal)
    const newRoles = roles.filter((role) => !spawnedRoles.includes(role))
    setSubmitting(true)
    setBrief('')
    setSpawnedRoles((current) => [...new Set([...current, ...roles])])
    setAssignedRoles(roles)
    setMessages((current) => [...current, { id: crypto.randomUUID(), author: 'user', body: goal, timestamp: currentTime() }])
    setWorkflow({ state: 'received', profile })
    addActivity('Новый бриф принят координатором')
    newRoles.forEach((role) => addActivity(`Создано рабочее место: ${SPECIALISTS[role].name}`, 'violet'))
    try {
      if (supabase) {
        const runRef = crypto.randomUUID()
        const { data, error: invokeError } = await supabase.functions.invoke('orchestrate', {
          body: {
            action: 'run_enqueue', goal, orchestrated_goal: goal,
            context_key: 'virtual-office', run_ref: runRef, requested_roles: roles,
          },
        })
        const payload = data as { ok?: boolean; run?: { run_ref?: string } } | null
        if (invokeError || !payload?.ok) throw new Error('WORKFLOW_ENQUEUE_FAILED')
        setWorkflow({ state: 'planned', profile, workflowId: payload.run?.run_ref })
        await refresh(undefined, true)
      } else {
        simulateWorkflow(profile, roles)
      }
      setMessages((current) => [...current, {
        id: crypto.randomUUID(), author: 'coordinator',
        body: `Бриф принят. Orca DAG назначил: ${roles.map((role) => SPECIALISTS[role].name).join(', ')}. Текущий этап: ${highLevelStage({ state: 'planned', profile }, false)}.`,
        timestamp: currentTime(),
      }])
    } catch {
      setWorkflow(undefined)
      setError('Не удалось запустить workflow. Бриф сохранён в чате — повторите отправку.')
      addActivity('Запуск workflow отклонён безопасным шлюзом', 'amber')
    } finally {
      setSubmitting(false)
    }
  }

  const decide = async (decision: 'approve' | 'reject') => {
    if (!activeApproval) return
    try {
      await dashboardRequest(`/v1/dashboard/approvals/${encodeURIComponent(activeApproval.id)}/decide`, {
        method: 'POST', body: JSON.stringify({ decision }),
      })
      addActivity(decision === 'approve' ? 'Результат одобрен оператором' : 'Результат возвращён команде', decision === 'approve' ? 'emerald' : 'amber')
      await refresh(undefined, true)
    } catch {
      setError('Решение не сохранено. Обновите очередь и повторите.')
    }
  }

  const statusUpdate = () => setMessages((current) => [...current, {
    id: crypto.randomUUID(), author: 'coordinator', body: `Статус команды: ${stage}. Активных агентов: ${agents.filter((agent) => agent.state !== 'idle').length}.`, timestamp: currentTime(),
  }])

  return (
    <section className="overflow-hidden rounded-[26px] border border-[#dce3ee] bg-[#f4f7fb] shadow-[0_22px_70px_rgba(15,23,42,.12)]" aria-labelledby="office-title">
      <header className="flex flex-col gap-3 border-b border-[#dce3ee] bg-white px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#111827] text-cyan-300 shadow-lg"><Sparkles size={18} /></span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 id="office-title" className="truncate text-base font-bold text-[#111827] sm:text-lg">Nemo Virtual Office</h2>
              <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700">Live</span>
            </div>
            <p className="mt-0.5 truncate text-xs text-[#64748b]">Командный чат и живой изометрический workspace</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MetricPill icon={Activity} label={stage} />
          <button type="button" onClick={() => void refresh(undefined, true)} disabled={refreshing} className="grid h-9 w-9 place-items-center rounded-xl border border-[#dce3ee] bg-white text-[#475569] transition hover:border-[#94a3b8] disabled:opacity-50" aria-label="Обновить телеметрию">
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      <div className="grid min-h-[720px] lg:h-[720px] lg:min-h-0 lg:grid-cols-[42%_58%]">
        <aside className="flex min-h-[620px] flex-col border-b border-[#dce3ee] bg-white lg:min-h-[720px] lg:border-b-0 lg:border-r" aria-label="Командный чат координатора">
          <div className="border-b border-[#e6ebf2] px-4 py-3.5 sm:px-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <img src="/assets/office/sprites/coordinator.png" alt="Nemo Coordinator" className="h-9 w-9 rounded-xl border border-cyan-200 bg-white object-cover shadow-sm" />
                <div><p className="text-sm font-bold text-[#111827]">Team Chat</p><p className="text-[11px] text-[#64748b]">Nemo Coordinator + {agents.length - 1} специалистов</p></div>
              </div>
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700"><span className="h-2 w-2 rounded-full bg-emerald-500" />online</span>
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <HintButton icon={Focus} label="Refocus" onClick={() => { addActivity('Фокус команды обновлён'); statusUpdate() }} />
              <HintButton icon={CircleDot} label="Status update" onClick={statusUpdate} />
              <HintButton icon={Plus} label="Add agent" onClick={hireAgent} disabled={extraAgents >= 3} />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5" data-testid="office-team-chat">
            <div className="space-y-4">
              {messages.map((message) => <ChatBubble key={message.id} message={message} />)}
              <div ref={chatEndRef} />
            </div>

            <div className="my-5 flex items-center gap-3"><span className="h-px flex-1 bg-[#e6ebf2]" /><span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#94a3b8]">Журнал действий</span><span className="h-px flex-1 bg-[#e6ebf2]" /></div>
            <div className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] p-3.5">
              <p className="mb-3 text-[11px] leading-relaxed text-[#64748b]">Без внутренних рассуждений: только безопасные операционные события.</p>
              <div className="space-y-3">
                {activities.map((event) => (
                  <div key={event.id} className="flex items-start gap-2.5 text-xs">
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${event.tone === 'emerald' ? 'bg-emerald-500' : event.tone === 'amber' ? 'bg-amber-500' : event.tone === 'violet' ? 'bg-violet-500' : 'bg-cyan-500'}`} />
                    <span className="min-w-0 flex-1 leading-relaxed text-[#334155]">{event.label}</span>
                    <span className="shrink-0 text-[10px] text-[#94a3b8]">{event.timestamp}</span>
                  </div>
                ))}
              </div>
            </div>

            {activeApproval && (
              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-700">Human-in-the-Loop</p>
                <p className="mt-2 text-sm font-semibold text-[#1f2937]">{activeApproval.summary}</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => void decide('approve')} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-xs font-bold text-white"><Check size={14} />Одобрить</button>
                  <button type="button" onClick={() => void decide('reject')} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3 text-xs font-bold text-rose-700"><X size={14} />Отклонить</button>
                </div>
              </div>
            )}
            {error && <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{error}</p>}
          </div>

          <div className="border-t border-[#e6ebf2] bg-white p-3.5 sm:p-4">
            <label htmlFor="office-brief" className="mb-2 block text-[11px] font-bold uppercase tracking-[0.12em] text-[#64748b]">Бриф для координатора</label>
            <div className="rounded-2xl border border-[#d8e0ea] bg-[#f8fafc] p-2 shadow-inner focus-within:border-cyan-400 focus-within:ring-4 focus-within:ring-cyan-100">
              <textarea
                id="office-brief" value={brief} onChange={(event) => setBrief(event.target.value.slice(0, 4000))}
                onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submitBrief() } }}
                rows={3} placeholder="Например: создай рилс и смету для запуска новой услуги…"
                className="w-full resize-none bg-transparent px-2 py-1 text-sm leading-relaxed text-[#111827] outline-none placeholder:text-[#94a3b8]"
              />
              <div className="flex items-center justify-between gap-3 px-1 pb-0.5">
                <span className="text-[10px] text-[#94a3b8]">Ctrl/⌘ + Enter</span>
                <button type="button" onClick={() => void submitBrief()} disabled={!brief.trim() || submitting} className="inline-flex min-h-9 items-center gap-2 rounded-xl bg-[#111827] px-3.5 text-xs font-bold text-white transition hover:bg-[#1e293b] disabled:cursor-not-allowed disabled:opacity-40">
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}Запустить
                </button>
              </div>
            </div>
          </div>
        </aside>

        <div className="relative min-h-[520px] bg-[#07101d] lg:min-h-[720px]">
          <IsometricOfficeRoom agents={agents} deskCount={agents.length} />
          <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2 rounded-2xl border border-white/15 bg-[#06101c]/80 p-2 shadow-2xl backdrop-blur-md">
            <button type="button" onClick={removeAgent} disabled={extraAgents === 0} className="grid h-9 w-9 place-items-center rounded-xl text-white transition hover:bg-white/10 disabled:opacity-30" aria-label="Удалить последнее рабочее место"><Minus size={16} /></button>
            <button type="button" onClick={hireAgent} disabled={extraAgents >= 3} className="inline-flex min-h-9 items-center gap-2 rounded-xl bg-white px-3 text-xs font-bold text-[#111827] transition hover:bg-cyan-50 disabled:opacity-40"><Plus size={15} />Add Agent</button>
          </div>
          <div className="absolute right-4 top-16 z-20 hidden w-48 rounded-2xl border border-white/15 bg-[#06101c]/75 p-3 text-white shadow-2xl backdrop-blur-md xl:block">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-200">Office telemetry</p>
            <div className="mt-3 space-y-2.5">
              <CanvasMetric icon={Clock3} label="Uptime" value={metrics ? formatUptime(metrics.uptime_seconds) : '—'} />
              <CanvasMetric icon={Inbox} label="Inbox" value={metrics ? metrics.inbox_total.toLocaleString('ru-RU') : '—'} />
              <CanvasMetric icon={Activity} label="Live Gate F1" value={metrics ? `${(Math.min(1, metrics.f1_score) * 100).toFixed(1)}%` : '—'} />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.author === 'system') return (
    <div className="flex items-start gap-2 rounded-xl bg-[#f1f5f9] px-3 py-2.5 text-[11px] leading-relaxed text-[#64748b]"><Bot size={14} className="mt-0.5 shrink-0" />{message.body}</div>
  )
  const user = message.author === 'user'
  return (
    <div className={`flex gap-2.5 ${user ? 'justify-end' : 'justify-start'}`}>
      {!user && <img src="/assets/office/sprites/coordinator.png" alt="" className="mt-1 h-7 w-7 shrink-0 rounded-lg bg-white object-cover shadow-sm" />}
      <div className={`max-w-[86%] ${user ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className={`rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${user ? 'rounded-br-md bg-[#111827] text-white' : 'rounded-bl-md border border-[#e2e8f0] bg-white text-[#334155] shadow-sm'}`}>{message.body}</div>
        {message.artifacts && message.artifacts.length > 0 && (
          <div className="mt-2 grid w-full gap-1.5">
            {message.artifacts.map((artifact) => (
              <div key={artifact.name} className="flex items-center gap-2 rounded-xl border border-[#dce3ee] bg-[#f8fafc] px-3 py-2 text-[11px] font-semibold text-[#334155]">
                {artifact.kind === 'video' ? <Film size={14} className="text-violet-600" /> : <FileText size={14} className="text-cyan-700" />}
                <span className="min-w-0 flex-1 truncate">{artifact.name}</span>
                <span className="text-[9px] uppercase tracking-[0.12em] text-emerald-700">ready</span>
              </div>
            ))}
          </div>
        )}
        <span className="mt-1 px-1 text-[9px] text-[#94a3b8]">{message.timestamp}</span>
      </div>
    </div>
  )
}

function HintButton({ icon: Icon, label, onClick, disabled }: { icon: typeof Focus; label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-[#dce3ee] bg-[#f8fafc] px-3 text-[11px] font-semibold text-[#475569] transition hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-800 disabled:opacity-40"><Icon size={13} />{label}</button>
}

function MetricPill({ icon: Icon, label }: { icon: typeof Activity; label: string }) {
  return <span className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-[#dce3ee] bg-[#f8fafc] px-3 text-[11px] font-semibold text-[#475569]"><Icon size={14} className="text-cyan-600" />{label}<ChevronRight size={12} className="text-[#94a3b8]" /></span>
}

function CanvasMetric({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 text-[11px]"><span className="flex items-center gap-1.5 text-slate-300"><Icon size={12} />{label}</span><strong className="text-white">{value}</strong></div>
}
