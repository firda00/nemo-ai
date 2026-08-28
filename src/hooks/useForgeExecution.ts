import { useCallback, useEffect, useMemo, useState } from 'react'
import { createContentGrowthWorkflow, CONTENT_GROWTH_USTADI_PROMPT } from '../lib/content-growth-workflow'
import { compileTask } from '../lib/forge-task-compiler'
import { getAccessToken, isSupabaseEnabled, supabase } from '../lib/supabase'
import { ProjectExecutionPlanSchema, type ProjectExecutionPlan } from '../types/forge-contracts'
import { BusinessIntentSchema } from '../types/business-intent'
import { BUSINESS_INTENT_STORAGE_KEY, businessIntentToForgePrompt } from '../lib/business-intent'

export type ForgeRoutingMode = 'auto' | 'local_first' | 'gpu_enabled'

export interface ForgeConnectorState {
  id: string
  label: string
  detail: string
  state: 'ready' | 'unverified' | 'unavailable'
}

export interface ForgeApproval {
  id: string
  summary: string
  status: string
  createdAt: string
  artifacts: ForgeApprovalArtifact[]
}

export interface ForgeApprovalArtifact {
  name: string
  mimeType: 'application/pdf' | 'video/mp4'
  sizeBytes: number
  sha256: string
  url: string
  expiresAt: string
}

interface ApprovalQueueItem {
  id: string
  summary: string
  status: string
  created_at: string
}

interface DashboardApprovalItem {
  id: string
  summary: string
  status: string
  created_at: string
  artifacts?: unknown[]
}

const API_GATEWAY = String(import.meta.env.VITE_API_GATEWAY_URL ?? '').trim().replace(/\/+$/, '')
const SIGNED_URL_MAX_TTL_MS = 305_000

function parseApprovalArtifact(raw: unknown, now = Date.now()): ForgeApprovalArtifact | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (item.mime_type !== 'application/pdf' && item.mime_type !== 'video/mp4') return null
  if (typeof item.url !== 'string' || typeof item.expires_at !== 'string') return null
  const expiresAt = Date.parse(item.expires_at)
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > SIGNED_URL_MAX_TTL_MS) return null
  try {
    const url = new URL(item.url)
    if (url.protocol !== 'https:' || url.username || url.password) return null
  } catch { return null }
  if (typeof item.name !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) return null
  if (typeof item.size_bytes !== 'number' || !Number.isSafeInteger(item.size_bytes) || item.size_bytes <= 0) return null
  return {
    name: item.name.slice(0, 160),
    mimeType: item.mime_type,
    sizeBytes: item.size_bytes,
    sha256: item.sha256,
    url: item.url,
    expiresAt: item.expires_at,
  }
}

async function dashboardRequest(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  if (!API_GATEWAY) throw new Error('DASHBOARD_GATEWAY_NOT_CONFIGURED')
  const token = await getAccessToken()
  if (!token) throw new Error('DASHBOARD_SESSION_REQUIRED')
  const response = await fetch(`${API_GATEWAY}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || payload.ok !== true) throw new Error(typeof payload.error === 'string' ? payload.error : 'DASHBOARD_REQUEST_FAILED')
  return payload
}

const LOCAL_CONNECTORS: ForgeConnectorState[] = [
  { id: 'media-worker', label: 'Nemo Media Worker', detail: 'FFmpeg / Remotion', state: 'unverified' },
  { id: 'voice-worker', label: 'Nemo Voice Worker', detail: 'Piper TTS', state: 'unverified' },
]

export function useForgeExecution() {
  const [prompt, setPrompt] = useState(() => {
    try {
      const structured = window.sessionStorage.getItem(BUSINESS_INTENT_STORAGE_KEY)
      window.sessionStorage.removeItem(BUSINESS_INTENT_STORAGE_KEY)
      if (structured) {
        const parsed = BusinessIntentSchema.safeParse(JSON.parse(structured))
        if (parsed.success) return businessIntentToForgePrompt(parsed.data).slice(0, 16_384)
      }
      const incoming = window.sessionStorage.getItem('nemo.forge.incoming-brief') ?? ''
      window.sessionStorage.removeItem('nemo.forge.incoming-brief')
      return incoming.slice(0, 16_384)
    } catch {
      return ''
    }
  })
  const [budgetCapUsd, setBudgetCapUsd] = useState(5)
  const [routingMode, setRoutingMode] = useState<ForgeRoutingMode>('auto')
  const [plan, setPlan] = useState<ProjectExecutionPlan | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      const raw = window.localStorage.getItem('nemo.forge.last-plan')
      return raw ? ProjectExecutionPlanSchema.parse(JSON.parse(raw)) : null
    } catch { return null }
  })
  const [compileError, setCompileError] = useState('')
  const [connectedProviders, setConnectedProviders] = useState<string[]>([])
  const [approvals, setApprovals] = useState<ForgeApproval[]>([])
  const [loadingOperations, setLoadingOperations] = useState(isSupabaseEnabled)
  const [operationsError, setOperationsError] = useState('')
  const [approvalBusy, setApprovalBusy] = useState('')

  const compile = useCallback(() => {
    setCompileError('')
    try {
      const next = compileTask(prompt, { totalBudgetCapUsd: budgetCapUsd })
      if (routingMode === 'local_first' && next.steps.some((step) => step.computeProfile === 'PROFILE_C_BROWSER' || step.computeProfile === 'PROFILE_D_GPU')) {
        setCompileError('План требует медиа-профиль. Подключите локальный media worker или выберите автоматическую маршрутизацию.')
      }
      setPlan(next)
      try { window.localStorage.setItem('nemo.forge.last-plan', JSON.stringify(next)) } catch { /* storage is optional */ }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'FORGE_COMPILE_FAILED'
      setCompileError(code === 'FORGE_PROMPT_TOO_SHORT'
        ? 'Опишите задачу минимум тремя символами.'
        : code.includes('estimated cost exceeds budget cap')
          ? 'Расчётная стоимость превышает установленный лимит.'
          : 'Не удалось собрать безопасный план. Проверьте задачу и бюджет.')
    }
  }, [budgetCapUsd, prompt, routingMode])

  const compileContentGrowthTemplate = useCallback(() => {
    setCompileError('')
    try {
      const templateBudget = Math.max(5, budgetCapUsd)
      const next = createContentGrowthWorkflow({ totalBudgetCapUsd: templateBudget })
      setPrompt(CONTENT_GROWTH_USTADI_PROMPT)
      setBudgetCapUsd(templateBudget)
      setPlan(next)
      try { window.localStorage.setItem('nemo.forge.last-plan', JSON.stringify(next)) } catch { /* storage is optional */ }
    } catch {
      setCompileError('Не удалось собрать шаблон Content Growth.')
    }
  }, [budgetCapUsd])

  const refreshOperations = useCallback(async () => {
    if (!supabase) {
      setLoadingOperations(false)
      return
    }
    setOperationsError('')
    const [providersResult, approvalsResult] = await Promise.all([
      supabase.functions.invoke('connect-provider', { body: { action: 'status' } }),
      API_GATEWAY
        ? dashboardRequest('/v1/dashboard/approvals').then((data) => ({ data, error: null })).catch((error: Error) => ({ data: null, error }))
        : supabase.functions.invoke('approval-queue', { body: { action: 'list' } }),
    ])
    const providersPayload = providersResult.data as { connected?: string[] } | null
    const approvalsPayload = approvalsResult.data as {
      ok?: boolean
      requests?: ApprovalQueueItem[]
      approvals?: DashboardApprovalItem[]
      error?: string
    } | null
    if (providersResult.error) setOperationsError('Не удалось проверить часть подключений.')
    setConnectedProviders(providersPayload?.connected ?? [])
    if (approvalsResult.error || !approvalsPayload?.ok) {
      setOperationsError((current) => current || approvalsPayload?.error || 'Не удалось загрузить согласования.')
    } else {
      const items = approvalsPayload.approvals ?? approvalsPayload.requests ?? []
      setApprovals(items.filter((item) => item.status === 'pending').map((item) => ({
        id: item.id,
        summary: item.summary,
        status: item.status,
        createdAt: item.created_at,
        artifacts: 'artifacts' in item && Array.isArray(item.artifacts)
          ? item.artifacts.map((artifact) => parseApprovalArtifact(artifact)).filter((artifact): artifact is ForgeApprovalArtifact => artifact !== null)
          : [],
      })))
    }
    setLoadingOperations(false)
  }, [])

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshOperations(), 0)
    const timer = window.setInterval(() => void refreshOperations(), 15_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refreshOperations])

  const decideApproval = useCallback(async (id: string, decision: 'approved' | 'rejected') => {
    if (!supabase) return
    setApprovalBusy(id)
    setOperationsError('')
    try {
      if (API_GATEWAY) {
        await dashboardRequest(`/v1/dashboard/approvals/${encodeURIComponent(id)}/decide`, {
          method: 'POST', body: JSON.stringify({ decision: decision === 'approved' ? 'approve' : 'reject' }),
        })
      } else {
        const { data, error } = await supabase.functions.invoke('approval-queue', {
          body: { action: 'decide', id, decision },
        })
        const payload = data as { ok?: boolean; error?: string } | null
        if (error || !payload?.ok) throw new Error(payload?.error || 'APPROVAL_FAILED')
      }
      setApprovals((items) => items.filter((item) => item.id !== id))
    } catch {
      setOperationsError('Решение не сохранено. Проверьте доступ и повторите попытку.')
    } finally {
      setApprovalBusy('')
    }
  }, [])

  const connectors = useMemo<ForgeConnectorState[]>(() => [
    ...LOCAL_CONNECTORS,
    { id: 'higgsfield', label: 'Higgsfield', detail: 'MCP / media', state: connectedProviders.includes('higgsfield') ? 'ready' : 'unavailable' },
    { id: 'replicate', label: 'Replicate', detail: 'GPU provider', state: connectedProviders.includes('replicate') ? 'ready' : 'unavailable' },
    { id: 'telegram', label: 'Telegram', detail: 'Delivery channel', state: connectedProviders.includes('telegram') ? 'ready' : 'unavailable' },
  ], [connectedProviders])

  return {
    prompt, setPrompt, budgetCapUsd, setBudgetCapUsd, routingMode, setRoutingMode,
    plan, compile, compileContentGrowthTemplate, compileError, connectors, approvals, decideApproval, approvalBusy,
    loadingOperations, operationsError, live: isSupabaseEnabled, refreshOperations,
  }
}
