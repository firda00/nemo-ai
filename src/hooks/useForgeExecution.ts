import { useCallback, useEffect, useMemo, useState } from 'react'
import { compileTask } from '../lib/forge-task-compiler'
import { isSupabaseEnabled, supabase } from '../lib/supabase'
import { ProjectExecutionPlanSchema, type ProjectExecutionPlan } from '../types/forge-contracts'

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
}

interface ApprovalQueueItem {
  id: string
  summary: string
  status: string
  created_at: string
}

const LOCAL_CONNECTORS: ForgeConnectorState[] = [
  { id: 'media-worker', label: 'Nemo Media Worker', detail: 'FFmpeg / Remotion', state: 'unverified' },
  { id: 'voice-worker', label: 'Nemo Voice Worker', detail: 'Piper TTS', state: 'unverified' },
]

export function useForgeExecution() {
  const [prompt, setPrompt] = useState('')
  const [budgetCapUsd, setBudgetCapUsd] = useState(5)
  const [routingMode, setRoutingMode] = useState<ForgeRoutingMode>('auto')
  const [plan, setPlan] = useState<ProjectExecutionPlan | null>(null)
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

  const refreshOperations = useCallback(async () => {
    if (!supabase) {
      setLoadingOperations(false)
      return
    }
    setOperationsError('')
    const [providersResult, approvalsResult] = await Promise.all([
      supabase.functions.invoke('connect-provider', { body: { action: 'status' } }),
      supabase.functions.invoke('approval-queue', { body: { action: 'list' } }),
    ])
    const providersPayload = providersResult.data as { connected?: string[] } | null
    const approvalsPayload = approvalsResult.data as { ok?: boolean; requests?: ApprovalQueueItem[]; error?: string } | null
    if (providersResult.error) setOperationsError('Не удалось проверить часть подключений.')
    setConnectedProviders(providersPayload?.connected ?? [])
    if (approvalsResult.error || !approvalsPayload?.ok) {
      setOperationsError((current) => current || approvalsPayload?.error || 'Не удалось загрузить согласования.')
    } else {
      setApprovals((approvalsPayload.requests ?? []).filter((item) => item.status === 'pending').map((item) => ({
        id: item.id, summary: item.summary, status: item.status, createdAt: item.created_at,
      })))
    }
    setLoadingOperations(false)
  }, [])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('nemo.forge.last-plan')
      if (raw) setPlan(ProjectExecutionPlanSchema.parse(JSON.parse(raw)))
    } catch { /* ignore invalid local previews */ }
    void refreshOperations()
    const timer = window.setInterval(() => void refreshOperations(), 15_000)
    return () => window.clearInterval(timer)
  }, [refreshOperations])

  const decideApproval = useCallback(async (id: string, decision: 'approved' | 'rejected') => {
    if (!supabase) return
    setApprovalBusy(id)
    setOperationsError('')
    try {
      const { data, error } = await supabase.functions.invoke('approval-queue', {
        body: { action: 'decide', id, decision },
      })
      const payload = data as { ok?: boolean; error?: string } | null
      if (error || !payload?.ok) throw new Error(payload?.error || 'APPROVAL_FAILED')
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
    plan, compile, compileError, connectors, approvals, decideApproval, approvalBusy,
    loadingOperations, operationsError, live: isSupabaseEnabled, refreshOperations,
  }
}
