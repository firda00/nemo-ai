import {
  useCallback, useEffect, useMemo, useRef, useState, type CSSProperties,
} from 'react'
import {
  Activity, ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight,
  Clock3, FileText, Film, Gauge, Inbox, LayoutGrid, Loader2, Palette,
  RefreshCw, Rows3, Settings2, ShieldCheck, X,
} from 'lucide-react'
import { Button } from './ui/Button'
import { getAccessToken } from '../lib/supabase'

const POLL_INTERVAL_MS = 3_000
const MAX_SIGNED_URL_TTL_MS = 305_000
const PREFERENCES_KEY = 'nemo.virtual-office.preferences.v1'
const GATEWAY = String(import.meta.env.VITE_API_GATEWAY_URL ?? '').trim().replace(/\/+$/, '')

type ComputeProfile = 'PROFILE_A_WASI' | 'PROFILE_B_DOCS' | 'PROFILE_C_BROWSER'
type WorkflowState =
  | 'received' | 'classified' | 'planned' | 'waiting_for_policy'
  | 'executing' | 'checkpointed' | 'waiting_for_approval'
  | 'waiting_for_action' | 'completed' | 'failed' | 'cancelled'
type RoomId = 'lead' | 'copywriter' | 'finance' | 'media'
type OfficeTheme = 'cyber' | 'cozy' | 'minimal'
type OfficeLayout = 'grid' | 'carousel'
type AccentId = 'cyan' | 'purple' | 'emerald' | 'amber'

export interface VirtualOfficeWorkflowStatus {
  state: WorkflowState
  profile?: ComputeProfile
}

interface Metrics {
  inbox_total: number
  outbox_delivered: number
  dead_letter_count: number
  live_gate_status: 'eligible' | 'blocked' | 'stale' | 'no_data'
  avg_grounding_score: number
  f1_score: number
  false_action_rate: number
  uptime_seconds: number
  zero_data_loss: boolean
  orphaned_inbox_count: number
  active_workflow_state?: WorkflowState
  active_compute_profile?: ComputeProfile
}

interface ApprovalArtifact {
  name: string
  mime_type: 'application/pdf' | 'image/jpeg' | 'video/mp4'
  size_bytes: number
  sha256: string
  url: string
  expires_at: string
}

interface Approval {
  id: string
  workflow_id: string
  summary: string
  workflow_type: string
  status: 'pending'
  artifacts: ApprovalArtifact[]
}

interface RoomDefinition {
  id: RoomId
  title: string
  team: string
  image: string
  operationalStatus: 'Анализ брифа' | 'Расчёт сметы' | 'Рендер видео'
}

interface OfficePreferences {
  theme: OfficeTheme
  accent: AccentId
  layout: OfficeLayout
  visibleRooms: RoomId[]
  roomOrder: RoomId[]
}

const ROOM_IDS: RoomId[] = ['lead', 'copywriter', 'finance', 'media']
const DEFAULT_PREFERENCES: OfficePreferences = {
  theme: 'cyber', accent: 'cyan', layout: 'grid',
  visibleRooms: [...ROOM_IDS], roomOrder: [...ROOM_IDS],
}

const ROOMS: readonly RoomDefinition[] = [
  {
    id: 'lead', title: 'Team Lead HQ', team: 'Orca Supervisor · Live Gate',
    image: '/assets/office/team-lead-hq.jpg', operationalStatus: 'Анализ брифа',
  },
  {
    id: 'copywriter', title: 'Copywriter Lounge', team: 'Сценарии · документы',
    image: '/assets/office/copywriter-lounge.jpg', operationalStatus: 'Анализ брифа',
  },
  {
    id: 'finance', title: 'Finance Desk', team: 'PROFILE_A_WASI · сметы',
    image: '/assets/office/finance-desk.jpg', operationalStatus: 'Расчёт сметы',
  },
  {
    id: 'media', title: 'Media Editing Booth', team: 'PROFILE_C_MEDIA · FFmpeg',
    image: '/assets/office/media-editing-booth.jpg', operationalStatus: 'Рендер видео',
  },
]

const ACCENTS: Record<AccentId, { label: string; value: string; glow: string }> = {
  cyan: { label: 'Cyan', value: '#00F0FF', glow: 'rgba(0,240,255,0.32)' },
  purple: { label: 'Purple', value: '#7928CA', glow: 'rgba(121,40,202,0.34)' },
  emerald: { label: 'Emerald', value: '#10B981', glow: 'rgba(16,185,129,0.32)' },
  amber: { label: 'Amber', value: '#F59E0B', glow: 'rgba(245,158,11,0.32)' },
}

const THEMES: Record<OfficeTheme, { label: string; style: Record<string, string>; imageClass: string }> = {
  cyber: {
    label: 'Cyber Neon', imageClass: 'saturate-[0.9]',
    style: { '--office-bg': '#080d1a', '--office-panel': '#0b1120', '--office-card': '#0c1222', '--office-text': '#ffffff', '--office-muted': '#94a3b8' },
  },
  cozy: {
    label: 'Cozy Wood', imageClass: 'sepia-[0.18] saturate-[0.92] brightness-[0.92]',
    style: { '--office-bg': '#17100d', '--office-panel': '#211712', '--office-card': '#271b15', '--office-text': '#fff7ed', '--office-muted': '#d6bca8' },
  },
  minimal: {
    label: 'Pure Minimal', imageClass: 'saturate-[0.55] brightness-[1.08]',
    style: { '--office-bg': '#eef2f7', '--office-panel': '#f8fafc', '--office-card': '#ffffff', '--office-text': '#111827', '--office-muted': '#64748b' },
  },
}

function isRoomId(value: unknown): value is RoomId {
  return typeof value === 'string' && ROOM_IDS.includes(value as RoomId)
}

function loadPreferences(): OfficePreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES
  try {
    const raw = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '') as Partial<OfficePreferences>
    const visibleRooms = Array.isArray(raw.visibleRooms) ? raw.visibleRooms.filter(isRoomId) : ROOM_IDS
    const ordered = Array.isArray(raw.roomOrder) ? raw.roomOrder.filter(isRoomId) : ROOM_IDS
    const roomOrder = [...ordered, ...ROOM_IDS.filter((id) => !ordered.includes(id))]
    return {
      theme: raw.theme === 'cozy' || raw.theme === 'minimal' ? raw.theme : 'cyber',
      accent: raw.accent && raw.accent in ACCENTS ? raw.accent : 'cyan',
      layout: raw.layout === 'carousel' ? 'carousel' : 'grid',
      visibleRooms: visibleRooms.length ? visibleRooms : [...ROOM_IDS],
      roomOrder,
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function apiUrl(path: string): string {
  return GATEWAY ? `${GATEWAY}${path}` : path
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
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
  const liveGate = raw.live_gate_status
  const allowedGate = liveGate === 'eligible' || liveGate === 'blocked' || liveGate === 'stale' || liveGate === 'no_data'
  const numbers = [
    raw.inbox_total, raw.outbox_delivered, raw.dead_letter_count, raw.avg_grounding_score,
    raw.f1_score, raw.false_action_rate, raw.uptime_seconds, raw.orphaned_inbox_count,
  ].map(finiteNonNegative)
  if (!allowedGate || numbers.some((item) => item === null) || typeof raw.zero_data_loss !== 'boolean') return null
  return {
    inbox_total: numbers[0]!, outbox_delivered: numbers[1]!, dead_letter_count: numbers[2]!,
    avg_grounding_score: numbers[3]!, f1_score: numbers[4]!, false_action_rate: numbers[5]!,
    uptime_seconds: numbers[6]!, orphaned_inbox_count: numbers[7]!,
    live_gate_status: liveGate, zero_data_loss: raw.zero_data_loss,
    active_workflow_state: readWorkflowState(raw.active_workflow_state),
    active_compute_profile: readProfile(raw.active_compute_profile),
  }
}

function safeArtifact(value: unknown): ApprovalArtifact | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.mime_type !== 'application/pdf' && raw.mime_type !== 'image/jpeg' && raw.mime_type !== 'video/mp4') return null
  try {
    const url = new URL(String(raw.url))
    const expiresAt = new Date(String(raw.expires_at)).getTime()
    const ttl = expiresAt - Date.now()
    if (url.protocol !== 'https:' || url.username || url.password || ttl <= 0 || ttl > MAX_SIGNED_URL_TTL_MS) return null
    return {
      name: String(raw.name).slice(0, 180), mime_type: raw.mime_type,
      size_bytes: Math.max(0, Number(raw.size_bytes) || 0), sha256: String(raw.sha256),
      url: url.toString(), expires_at: new Date(expiresAt).toISOString(),
    }
  } catch {
    return null
  }
}

function readApprovals(value: unknown): Approval[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    if (raw.status !== 'pending' || typeof raw.id !== 'string' || typeof raw.workflow_id !== 'string') return []
    return [{
      id: raw.id, workflow_id: raw.workflow_id, summary: String(raw.summary ?? '').slice(0, 2_000),
      workflow_type: String(raw.workflow_type ?? '').slice(0, 128), status: 'pending' as const,
      artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(safeArtifact).filter((artifact): artifact is ApprovalArtifact => artifact !== null) : [],
    }]
  })
}

async function dashboardRequest(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const token = await getAccessToken()
  if (!token) throw new Error('TELEMETRY_SESSION_UNAVAILABLE')
  const response = await fetch(apiUrl(path), {
    ...init, signal,
    headers: {
      Accept: 'application/json', Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error('TELEMETRY_REQUEST_FAILED')
  return await response.json() as Record<string, unknown>
}

function activeRoomFor(status: VirtualOfficeWorkflowStatus | undefined, waitingApproval: boolean): RoomId | null {
  if (waitingApproval || status?.state === 'waiting_for_approval') return 'lead'
  if (!status || ['completed', 'failed', 'cancelled'].includes(status.state)) return null
  if (status.profile === 'PROFILE_A_WASI') return 'finance'
  if (status.profile === 'PROFILE_C_BROWSER') return 'media'
  if (status.profile === 'PROFILE_B_DOCS') return 'copywriter'
  return 'lead'
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return days ? `${days}д ${hours}ч` : hours ? `${hours}ч ${minutes}м` : `${minutes}м`
}

function formatPercent(value: number): string {
  return `${(Math.min(1, value) * 100).toFixed(1)}%`
}

export function VirtualOffice({ workflowStatus }: { workflowStatus?: VirtualOfficeWorkflowStatus }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busyDecision, setBusyDecision] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [customizerOpen, setCustomizerOpen] = useState(false)
  const [preferences, setPreferences] = useState<OfficePreferences>(loadPreferences)
  const carouselRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)) } catch { /* preferences remain session-local */ }
  }, [preferences])

  const refresh = useCallback(async (signal?: AbortSignal, background = false) => {
    if (background) setRefreshing(true)
    try {
      const [metricsPayload, approvalsPayload] = await Promise.all([
        dashboardRequest('/v1/dashboard/metrics', {}, signal),
        dashboardRequest('/v1/dashboard/approvals', {}, signal),
      ])
      const nextMetrics = readMetrics(metricsPayload.metrics)
      if (!nextMetrics) throw new Error('TELEMETRY_RESPONSE_INVALID')
      setMetrics(nextMetrics)
      setApprovals(readApprovals(approvalsPayload.approvals))
      setError('')
    } catch (requestError) {
      if (!(requestError instanceof DOMException && requestError.name === 'AbortError')) setError('Телеметрия временно недоступна')
    } finally {
      setLoading(false)
      if (background) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(controller.signal, true), POLL_INTERVAL_MS)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh])

  const activeApproval = approvals[0] ?? null
  const statusFromMetrics = metrics?.active_workflow_state ? {
    state: metrics.active_workflow_state,
    profile: metrics.active_compute_profile,
  } satisfies VirtualOfficeWorkflowStatus : undefined
  const activeRoom = activeRoomFor(workflowStatus ?? statusFromMetrics, Boolean(activeApproval))
  const artifact = useMemo(() => activeApproval?.artifacts[0] ?? null, [activeApproval])
  const rooms = useMemo(() => preferences.roomOrder
    .filter((id) => preferences.visibleRooms.includes(id))
    .map((id) => ROOMS.find((room) => room.id === id)!)
    .filter(Boolean), [preferences.roomOrder, preferences.visibleRooms])
  const accent = ACCENTS[preferences.accent]
  const theme = THEMES[preferences.theme]
  const themeStyle = {
    ...theme.style,
    '--office-accent': accent.value,
    '--office-glow': accent.glow,
  } as CSSProperties

  const decide = async (decision: 'approve' | 'reject') => {
    if (!activeApproval || busyDecision) return
    setBusyDecision(true)
    try {
      await dashboardRequest(`/v1/dashboard/approvals/${encodeURIComponent(activeApproval.id)}/decide`, {
        method: 'POST', body: JSON.stringify({ decision, ...(reason.trim() ? { reason: reason.trim().slice(0, 500) } : {}) }),
      })
      setReason('')
      await refresh(undefined, true)
    } catch {
      setError('Решение не сохранено. Обновите очередь и повторите.')
    } finally {
      setBusyDecision(false)
    }
  }

  const toggleRoom = (id: RoomId) => setPreferences((current) => {
    const shown = current.visibleRooms.includes(id)
    if (shown && current.visibleRooms.length === 1) return current
    return { ...current, visibleRooms: shown ? current.visibleRooms.filter((room) => room !== id) : [...current.visibleRooms, id] }
  })

  const moveRoom = (id: RoomId, direction: -1 | 1) => setPreferences((current) => {
    const index = current.roomOrder.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= current.roomOrder.length) return current
    const roomOrder = [...current.roomOrder]
    ;[roomOrder[index], roomOrder[target]] = [roomOrder[target], roomOrder[index]]
    return { ...current, roomOrder }
  })

  const scrollCarousel = (direction: -1 | 1) => carouselRef.current?.scrollBy({ left: direction * carouselRef.current.clientWidth * 0.72, behavior: 'smooth' })

  return (
    <section
      className="office-shell overflow-hidden rounded-3xl border shadow-[0_24px_80px_rgba(4,8,20,0.18)] transition-colors"
      style={{ ...themeStyle, background: 'var(--office-bg)', color: 'var(--office-text)', borderColor: 'color-mix(in_srgb,var(--office-accent)_18%,transparent)' }}
      aria-labelledby="virtual-office-title"
    >
      <header className="flex flex-col gap-4 border-b border-white/10 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-black/10" style={{ borderColor: `${accent.value}40`, color: accent.value }}><Activity size={19} /></span>
          <div>
            <p className="mono-label" style={{ color: accent.value }}>Nemo office hub</p>
            <h2 id="virtual-office-title" className="mt-1 text-xl font-bold sm:text-2xl" style={{ color: 'var(--office-text)' }}>Живой командный центр</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--office-muted)' }}>Работа агентов, телеметрия и согласования — в одном безопасном пространстве</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button" onClick={() => setCustomizerOpen((open) => !open)} aria-expanded={customizerOpen} aria-controls="office-customizer"
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/10 px-3 text-xs font-semibold transition hover:border-white/25"
          >
            <Palette size={15} /> Настроить офис
          </button>
          <button
            type="button" onClick={() => void refresh(undefined, true)} disabled={refreshing}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/10 px-3 text-xs font-semibold transition hover:border-white/25 disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Обновить
          </button>
        </div>
      </header>

      {customizerOpen && (
        <OfficeCustomizer
          preferences={preferences}
          onChange={setPreferences}
          onToggleRoom={toggleRoom}
          onMoveRoom={moveRoom}
          onClose={() => setCustomizerOpen(false)}
        />
      )}

      <div className="relative p-2 sm:p-3">
        {preferences.layout === 'grid' && rooms.length > 1 && <DataCables active={Boolean(activeRoom)} accent={accent.value} />}
        {preferences.layout === 'carousel' && rooms.length > 1 && (
          <div className="absolute right-5 top-5 z-30 hidden gap-2 sm:flex">
            <button type="button" onClick={() => scrollCarousel(-1)} aria-label="Предыдущая комната" className="grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/55 text-white backdrop-blur hover:border-white/35"><ChevronLeft size={18} /></button>
            <button type="button" onClick={() => scrollCarousel(1)} aria-label="Следующая комната" className="grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/55 text-white backdrop-blur hover:border-white/35"><ChevronRight size={18} /></button>
          </div>
        )}
        <div
          ref={carouselRef}
          data-testid="virtual-office-grid"
          className={preferences.layout === 'grid'
            ? 'relative z-10 grid gap-3 md:grid-cols-2'
            : 'relative z-10 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'}
        >
          {rooms.map((room, index) => (
            <OfficeRoom
              key={room.id}
              room={room}
              index={index}
              active={room.id === activeRoom}
              waiting={room.id === activeRoom && Boolean(activeApproval)}
              accent={accent}
              imageClass={theme.imageClass}
              carousel={preferences.layout === 'carousel'}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-white/10 p-4 sm:p-6" style={{ background: 'var(--office-panel)' }}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Telemetry icon={Clock3} label="Uptime" value={metrics ? formatUptime(metrics.uptime_seconds) : '—'} />
          <Telemetry icon={Gauge} label="Live Gate F1" value={metrics ? formatPercent(metrics.f1_score) : '—'} state={metrics?.live_gate_status} />
          <Telemetry icon={Inbox} label="Inbox" value={metrics ? metrics.inbox_total.toLocaleString('ru-RU') : '—'} detail={metrics ? `${metrics.orphaned_inbox_count} без workflow` : undefined} />
          <Telemetry icon={Activity} label="Outbox" value={metrics ? metrics.outbox_delivered.toLocaleString('ru-RU') : '—'} detail={metrics ? `${metrics.dead_letter_count} dead letter` : undefined} />
        </div>

        {error && <div role="status" className="mt-4 rounded-xl border border-amber/25 bg-amber/10 px-4 py-3 text-sm text-amber">{error}</div>}
        {loading && <div className="mt-4 flex items-center gap-2 text-sm" style={{ color: 'var(--office-muted)' }}><Loader2 size={15} className="animate-spin" />Загружаем операционную телеметрию…</div>}

        <div className="mt-5 rounded-2xl border border-white/10 bg-black/[0.055] p-4 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${activeApproval ? 'bg-amber/15 text-amber' : 'bg-teal/10 text-teal'}`}><ShieldCheck size={19} /></span>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--office-muted)' }}>Human-in-the-Loop</p>
                <h3 className="mt-1 text-base font-bold" style={{ color: 'var(--office-text)' }}>{activeApproval ? 'Пакет ожидает решения' : 'Активных согласований нет'}</h3>
                {activeApproval && <p className="mt-1 max-w-2xl text-sm leading-relaxed opacity-90">{activeApproval.summary}</p>}
              </div>
            </div>
            {metrics && <span className={`self-start rounded-full border px-3 py-1 text-xs font-semibold ${metrics.zero_data_loss ? 'border-teal/25 bg-teal/10 text-teal' : 'border-amber/25 bg-amber/10 text-amber'}`}>
              {metrics.zero_data_loss ? 'Data loss: 0' : `${metrics.orphaned_inbox_count} требует проверки`}
            </span>}
          </div>

          {activeApproval && (
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div>
                <label htmlFor="virtual-office-reason" className="text-xs font-semibold" style={{ color: 'var(--office-muted)' }}>Комментарий оператору (необязательно)</label>
                <textarea id="virtual-office-reason" value={reason} onChange={(event) => setReason(event.target.value.slice(0, 500))} rows={3} className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none placeholder:opacity-60 focus:border-white/30" placeholder="Причина решения или правка…" />
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" variant="success" size="sm" loading={busyDecision} onClick={() => void decide('approve')}><Check size={15} />Одобрить</Button>
                  <Button type="button" variant="danger" size="sm" disabled={busyDecision} onClick={() => void decide('reject')}><X size={15} />Отклонить</Button>
                </div>
              </div>
              <ArtifactPreview artifact={artifact} />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function OfficeRoom({ room, index, active, waiting, accent, imageClass, carousel }: {
  room: RoomDefinition
  index: number
  active: boolean
  waiting: boolean
  accent: { value: string; glow: string }
  imageClass: string
  carousel: boolean
}) {
  const action = waiting ? 'Ожидает согласования' : room.operationalStatus
  return (
    <article
      className={`office-float relative isolate overflow-hidden rounded-2xl p-[2px] ${carousel ? 'min-w-[88%] snap-center sm:min-w-[72%] lg:min-w-[48%]' : ''} ${active ? 'office-active-border' : ''}`}
      style={{
        animationDelay: `${index * -0.7}s`,
        backgroundImage: active ? `linear-gradient(115deg, transparent 5%, ${accent.value} 28%, #ffffff 50%, ${accent.value} 72%, transparent 95%)` : 'none',
        boxShadow: active ? `0 0 44px ${accent.glow}` : 'none',
      }}
    >
      <div className="group relative min-h-[300px] overflow-hidden rounded-[14px] sm:min-h-[350px]" style={{ background: 'var(--office-card)' }}>
        <img
          src={room.image}
          alt={`Диорама ${room.title}`}
          className={`absolute inset-0 h-full w-full object-cover transition duration-700 ${imageClass} ${active ? 'scale-[1.035] opacity-100' : 'opacity-[0.66] grayscale-[0.08] group-hover:scale-[1.02] group-hover:opacity-[0.86]'}`}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#070b15] via-[#070b15]/10 to-transparent" aria-hidden="true" />
        {active && (
          <div className="office-speech absolute left-4 top-4 z-20 max-w-[82%] rounded-2xl rounded-bl-sm border bg-black/70 px-3 py-2 text-xs font-semibold text-white shadow-xl backdrop-blur" style={{ borderColor: `${accent.value}66` }} role="status">
            <span className="office-typewriter">{action}</span>
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: active ? accent.value : '#8290aa', boxShadow: active ? `0 0 12px ${accent.value}` : 'none' }} />
              <p className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-[#cbd5e1]">{room.team}</p>
            </div>
            <h3 className="mt-2 text-lg font-bold text-white sm:text-xl">{room.title}</h3>
          </div>
          <span className="shrink-0 rounded-full border border-white/15 bg-black/50 px-3 py-1.5 text-xs font-semibold text-[#cbd5e1] backdrop-blur">
            {active ? action : 'Свободен'}
          </span>
        </div>
      </div>
    </article>
  )
}

function DataCables({ active, accent }: { active: boolean; accent: string }) {
  return (
    <svg className="pointer-events-none absolute inset-3 z-20 hidden h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)] md:block" viewBox="0 0 1000 700" preserveAspectRatio="none" aria-hidden="true">
      <path d="M 470 175 C 500 175, 500 175, 530 175 M 250 335 C 250 350, 250 350, 250 365 M 750 335 C 750 350, 750 350, 750 365 M 470 525 C 500 525, 500 525, 530 525" fill="none" stroke={accent} strokeOpacity={active ? 0.8 : 0.28} strokeWidth="5" strokeLinecap="round" className={active ? 'office-data-stream' : ''} />
      <path d="M 470 175 C 500 175, 500 175, 530 175 M 250 335 C 250 350, 250 350, 250 365 M 750 335 C 750 350, 750 350, 750 365 M 470 525 C 500 525, 500 525, 530 525" fill="none" stroke="#ffffff" strokeOpacity={active ? 0.85 : 0} strokeWidth="1.5" strokeLinecap="round" className={active ? 'office-data-stream office-data-stream-fast' : ''} />
    </svg>
  )
}

function OfficeCustomizer({ preferences, onChange, onToggleRoom, onMoveRoom, onClose }: {
  preferences: OfficePreferences
  onChange: (next: OfficePreferences | ((current: OfficePreferences) => OfficePreferences)) => void
  onToggleRoom: (id: RoomId) => void
  onMoveRoom: (id: RoomId, direction: -1 | 1) => void
  onClose: () => void
}) {
  return (
    <aside id="office-customizer" className="border-b border-white/10 bg-black/10 px-4 py-5 sm:px-6" aria-label="Конструктор офиса">
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-sm font-bold">Конструктор офиса</p><p className="mt-1 text-xs opacity-65">Настройки сохраняются на этом устройстве</p></div>
        <button type="button" onClick={onClose} aria-label="Закрыть настройки" className="grid h-9 w-9 place-items-center rounded-full border border-white/10 hover:border-white/25"><X size={17} /></button>
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_1fr_1.25fr]">
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-[0.12em] opacity-65">Атмосфера</legend>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(Object.entries(THEMES) as [OfficeTheme, typeof THEMES[OfficeTheme]][]).map(([id, item]) => (
              <button key={id} type="button" onClick={() => onChange({ ...preferences, theme: id })} className={`min-h-10 rounded-xl border px-2 text-xs font-semibold transition ${preferences.theme === id ? 'border-white/45 bg-white/10' : 'border-white/10 hover:border-white/25'}`} aria-pressed={preferences.theme === id}>{item.label}</button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-[0.12em] opacity-65">Неоновый акцент</legend>
          <div className="mt-3 flex flex-wrap gap-3">
            {(Object.entries(ACCENTS) as [AccentId, typeof ACCENTS[AccentId]][]).map(([id, item]) => (
              <button key={id} type="button" onClick={() => onChange({ ...preferences, accent: id })} className={`h-9 w-9 rounded-full border-2 transition hover:scale-105 ${preferences.accent === id ? 'border-white ring-2 ring-white/25' : 'border-transparent'}`} style={{ background: item.value }} aria-label={item.label} aria-pressed={preferences.accent === id} />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-[0.12em] opacity-65">Комнаты и раскладка</legend>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => onChange({ ...preferences, layout: 'grid' })} className={`inline-flex min-h-9 items-center gap-2 rounded-xl border px-3 text-xs font-semibold ${preferences.layout === 'grid' ? 'border-white/45 bg-white/10' : 'border-white/10'}`} aria-pressed={preferences.layout === 'grid'}><LayoutGrid size={14} />Grid 2×2</button>
            <button type="button" onClick={() => onChange({ ...preferences, layout: 'carousel' })} className={`inline-flex min-h-9 items-center gap-2 rounded-xl border px-3 text-xs font-semibold ${preferences.layout === 'carousel' ? 'border-white/45 bg-white/10' : 'border-white/10'}`} aria-pressed={preferences.layout === 'carousel'}><Rows3 size={14} />Carousel</button>
          </div>
          <div className="mt-3 space-y-2">
            {preferences.roomOrder.map((id, index) => {
              const room = ROOMS.find((item) => item.id === id)!
              const shown = preferences.visibleRooms.includes(id)
              return (
                <div key={id} className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/10 px-2 py-1.5">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-xs font-medium"><input type="checkbox" checked={shown} onChange={() => onToggleRoom(id)} className="accent-current" /><span className="truncate">{room.title}</span></label>
                  <button type="button" onClick={() => onMoveRoom(id, -1)} disabled={index === 0} aria-label={`Переместить ${room.title} раньше`} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-white/10 disabled:opacity-25"><ArrowLeft size={14} /></button>
                  <button type="button" onClick={() => onMoveRoom(id, 1)} disabled={index === preferences.roomOrder.length - 1} aria-label={`Переместить ${room.title} позже`} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-white/10 disabled:opacity-25"><ArrowRight size={14} /></button>
                </div>
              )
            })}
          </div>
        </fieldset>
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={() => onChange(DEFAULT_PREFERENCES)} className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-white/10 px-3 text-xs font-semibold hover:border-white/25"><Settings2 size={14} />Сбросить</button>
      </div>
    </aside>
  )
}

function Telemetry({ icon: Icon, label, value, detail, state }: { icon: typeof Activity; label: string; value: string; detail?: string; state?: Metrics['live_gate_status'] }) {
  return <div className="rounded-2xl border border-white/10 bg-black/[0.055] p-3.5"><div className="flex items-center gap-2 opacity-65"><Icon size={15} /><span className="text-xs font-semibold uppercase tracking-[0.1em]">{label}</span></div><div className="mt-2 flex items-end justify-between gap-2"><p className="text-xl font-bold">{value}</p>{state && <span className="text-[11px] opacity-65">{state}</span>}</div>{detail && <p className="mt-1 text-[11px] opacity-55">{detail}</p>}</div>
}

function ArtifactPreview({ artifact }: { artifact: ApprovalArtifact | null }) {
  if (!artifact) return <div className="grid min-h-36 place-items-center rounded-xl border border-dashed border-white/10 bg-black/10 p-4 text-center text-xs opacity-60"><FileText size={22} className="mb-2" />Превью артефакта отсутствует</div>
  if (artifact.mime_type === 'video/mp4') return <div className="overflow-hidden rounded-xl border border-white/10 bg-black"><video src={artifact.url} controls preload="metadata" className="aspect-video w-full object-contain" aria-label={`Видео ${artifact.name}`} /><p className="flex items-center gap-2 px-3 py-2 text-xs text-[#94a3b8]"><Film size={13} />{artifact.name}</p></div>
  if (artifact.mime_type === 'image/jpeg') return <figure className="overflow-hidden rounded-xl border border-white/10 bg-black"><img src={artifact.url} alt={artifact.name} className="aspect-video w-full object-contain" /><figcaption className="px-3 py-2 text-xs text-[#94a3b8]">{artifact.name}</figcaption></figure>
  return <div className="overflow-hidden rounded-xl border border-white/10 bg-black"><iframe src={artifact.url} title={`PDF ${artifact.name}`} className="h-44 w-full bg-white" sandbox="allow-same-origin" /><p className="flex items-center gap-2 px-3 py-2 text-xs text-[#94a3b8]"><FileText size={13} />{artifact.name}</p></div>
}
