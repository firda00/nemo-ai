import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, Check, Clock3, FileText, Film, Gauge, Inbox, Loader2,
  RefreshCw, ShieldCheck, X,
} from 'lucide-react'
import { Button } from './ui/Button'
import { getAccessToken } from '../lib/supabase'

const POLL_INTERVAL_MS = 3_000
const MAX_SIGNED_URL_TTL_MS = 305_000
const GATEWAY = String(import.meta.env.VITE_API_GATEWAY_URL ?? '').trim().replace(/\/+$/, '')

type ComputeProfile = 'PROFILE_A_WASI' | 'PROFILE_B_DOCS' | 'PROFILE_C_BROWSER'
type WorkflowState =
  | 'received' | 'classified' | 'planned' | 'waiting_for_policy'
  | 'executing' | 'checkpointed' | 'waiting_for_approval'
  | 'waiting_for_action' | 'completed' | 'failed' | 'cancelled'

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
  id: 'lead' | 'copywriter' | 'finance' | 'media'
  title: string
  team: string
  image: string
  operationalStatus: 'Анализ брифа' | 'Расчёт сметы' | 'Рендер видео'
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

function apiUrl(path: string): string {
  return GATEWAY ? `${GATEWAY}${path}` : path
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
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

function activeRoomFor(status: VirtualOfficeWorkflowStatus | undefined, waitingApproval: boolean): RoomDefinition['id'] | null {
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
  const activeRoom = activeRoomFor(workflowStatus, Boolean(activeApproval))
  const artifact = useMemo(() => activeApproval?.artifacts[0] ?? null, [activeApproval])

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

  return (
    <section className="mt-8 overflow-hidden rounded-3xl border border-white/10 bg-[#080d1a] shadow-lg" aria-labelledby="virtual-office-title">
      <header className="flex flex-col gap-4 border-b border-white/10 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan/20 bg-cyan/10 text-cyan"><Activity size={18} /></span>
          <div>
            <p className="mono-label !text-cyan">Nemo operations</p>
            <h2 id="virtual-office-title" className="mt-1 text-xl font-bold text-white sm:text-2xl">Живой офис</h2>
            <p className="mt-1 text-sm text-[#94a3b8]">Безопасное представление активных этапов Durable Runtime</p>
          </div>
        </div>
        <button
          type="button" onClick={() => void refresh(undefined, true)} disabled={refreshing}
          className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-xl border border-white/10 bg-white/[0.04] px-3 text-xs font-semibold text-[#eaf0fb] transition-colors hover:border-cyan/30 hover:text-white disabled:opacity-50 lg:self-auto"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Обновить
        </button>
      </header>

      <div data-testid="virtual-office-grid" className="grid gap-px bg-white/10 md:grid-cols-2">
        {ROOMS.map((room) => {
          const active = room.id === activeRoom
          const waiting = active && Boolean(activeApproval)
          return (
            <article key={room.id} className="group relative isolate min-h-[280px] overflow-hidden bg-[#0c1222] sm:min-h-[340px]">
              <img src={room.image} alt={`Диорама ${room.title}`} className={`absolute inset-0 h-full w-full object-cover transition duration-700 ${active ? 'scale-[1.02] opacity-100 saturate-110' : 'opacity-[0.72] saturate-[0.82] group-hover:opacity-[0.88]'}`} />
              <div className="absolute inset-0 bg-gradient-to-t from-[#070b15] via-[#070b15]/15 to-transparent" aria-hidden="true" />
              <div className={`absolute inset-0 border-2 transition-colors ${active ? 'border-cyan/65 shadow-[inset_0_0_48px_rgba(34,211,238,0.18)]' : 'border-transparent'}`} aria-hidden="true" />
              <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-3 p-4 sm:p-5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${active ? waiting ? 'bg-amber shadow-[0_0_12px_rgba(245,159,0,0.9)]' : 'bg-cyan shadow-[0_0_12px_rgba(34,211,238,0.9)]' : 'bg-[#8290aa]'}`} />
                    <p className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-[#cbd5e1]">{room.team}</p>
                  </div>
                  <h3 className="mt-2 text-lg font-bold text-white sm:text-xl">{room.title}</h3>
                </div>
                <span className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold backdrop-blur-md ${active ? waiting ? 'border-amber/40 bg-amber/15 text-amber' : 'border-cyan/35 bg-cyan/15 text-cyan' : 'border-white/10 bg-black/35 text-[#94a3b8]'}`}>
                  {active ? waiting ? 'Ожидает согласования' : room.operationalStatus : 'Свободен'}
                </span>
              </div>
            </article>
          )
        })}
      </div>

      <div className="border-t border-white/10 bg-[#0b1120] p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Telemetry icon={Clock3} label="Uptime" value={metrics ? formatUptime(metrics.uptime_seconds) : '—'} />
          <Telemetry icon={Gauge} label="Live Gate F1" value={metrics ? formatPercent(metrics.f1_score) : '—'} state={metrics?.live_gate_status} />
          <Telemetry icon={Inbox} label="Inbox" value={metrics ? metrics.inbox_total.toLocaleString('ru-RU') : '—'} detail={metrics ? `${metrics.orphaned_inbox_count} без workflow` : undefined} />
          <Telemetry icon={Activity} label="Outbox" value={metrics ? metrics.outbox_delivered.toLocaleString('ru-RU') : '—'} detail={metrics ? `${metrics.dead_letter_count} dead letter` : undefined} />
        </div>

        {error && <div role="status" className="mt-4 rounded-xl border border-amber/20 bg-amber/10 px-4 py-3 text-sm text-amber">{error}</div>}
        {loading && <div className="mt-4 flex items-center gap-2 text-sm text-[#94a3b8]"><Loader2 size={15} className="animate-spin" />Загружаем операционную телеметрию…</div>}

        <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${activeApproval ? 'bg-amber/15 text-amber' : 'bg-teal/10 text-teal'}`}><ShieldCheck size={19} /></span>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">Human-in-the-Loop</p>
                <h3 className="mt-1 text-base font-bold text-white">{activeApproval ? 'Пакет ожидает решения' : 'Активных согласований нет'}</h3>
                {activeApproval && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[#eaf0fb]">{activeApproval.summary}</p>}
              </div>
            </div>
            {metrics && <span className={`self-start rounded-full border px-3 py-1 text-xs font-semibold ${metrics.zero_data_loss ? 'border-teal/25 bg-teal/10 text-teal' : 'border-amber/25 bg-amber/10 text-amber'}`}>
              {metrics.zero_data_loss ? 'Data loss: 0' : `${metrics.orphaned_inbox_count} требует проверки`}
            </span>}
          </div>

          {activeApproval && (
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div>
                <label htmlFor="virtual-office-reason" className="text-xs font-semibold text-[#94a3b8]">Комментарий оператору (необязательно)</label>
                <textarea id="virtual-office-reason" value={reason} onChange={(event) => setReason(event.target.value.slice(0, 500))} rows={3} className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-[#8290aa] focus:border-cyan/40" placeholder="Причина решения или правка…" />
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

function Telemetry({ icon: Icon, label, value, detail, state }: { icon: typeof Activity; label: string; value: string; detail?: string; state?: Metrics['live_gate_status'] }) {
  return <div className="rounded-2xl border border-white/10 bg-black/15 p-3.5"><div className="flex items-center gap-2 text-[#94a3b8]"><Icon size={15} /><span className="text-xs font-semibold uppercase tracking-[0.1em]">{label}</span></div><div className="mt-2 flex items-end justify-between gap-2"><p className="text-xl font-bold text-white">{value}</p>{state && <span className="text-[11px] text-[#94a3b8]">{state}</span>}</div>{detail && <p className="mt-1 text-[11px] text-[#8290aa]">{detail}</p>}</div>
}

function ArtifactPreview({ artifact }: { artifact: ApprovalArtifact | null }) {
  if (!artifact) return <div className="grid min-h-36 place-items-center rounded-xl border border-dashed border-white/10 bg-black/15 p-4 text-center text-xs text-[#8290aa]"><FileText size={22} className="mb-2" />Превью артефакта отсутствует</div>
  if (artifact.mime_type === 'video/mp4') return <div className="overflow-hidden rounded-xl border border-white/10 bg-black"><video src={artifact.url} controls preload="metadata" className="aspect-video w-full object-contain" aria-label={`Видео ${artifact.name}`} /><p className="flex items-center gap-2 px-3 py-2 text-xs text-[#94a3b8]"><Film size={13} />{artifact.name}</p></div>
  if (artifact.mime_type === 'image/jpeg') return <figure className="overflow-hidden rounded-xl border border-white/10 bg-black"><img src={artifact.url} alt={artifact.name} className="aspect-video w-full object-contain" /><figcaption className="px-3 py-2 text-xs text-[#94a3b8]">{artifact.name}</figcaption></figure>
  return <div className="overflow-hidden rounded-xl border border-white/10 bg-black"><iframe src={artifact.url} title={`PDF ${artifact.name}`} className="h-44 w-full bg-white" sandbox="allow-same-origin" /><p className="flex items-center gap-2 px-3 py-2 text-xs text-[#94a3b8]"><FileText size={13} />{artifact.name}</p></div>
}
