import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getAccessToken, isSupabaseEnabled, supabase } from '../lib/supabase'
import { useAgentStore } from '../store/useAgentStore'

export type BackendMode = 'live' | 'local_simulation' | 'not_configured'

export interface BackendStatus {
  authReady: boolean
  accountReady: boolean
  supabaseReady: boolean
  llmReady: boolean
  liveWorkflowReady: boolean
  providerKeysSecure: boolean
  mode: BackendMode
  reason: string
}

interface StatusResponse {
  ok?: boolean
  llmReady?: boolean
  providerKeysSecure?: boolean
  code?: string
  message?: string
}

export function useBackendStatus(enabled = true): BackendStatus {
  const { live, isAuthed } = useAuth()
  const accountId = useAgentStore((s) => s.accountId)
  const profileResolved = useAgentStore((s) => s.profileResolved)
  const [authReady, setAuthReady] = useState(false)
  const [serverChecked, setServerChecked] = useState(false)
  const [serverLlmReady, setServerLlmReady] = useState(false)
  const [providerKeysSecure, setProviderKeysSecure] = useState(false)
  const [serverReason, setServerReason] = useState('Backend status endpoint is not confirmed.')

  useEffect(() => {
    if (!enabled) return
    let active = true
    getAccessToken().then((token) => {
      if (active) setAuthReady(Boolean(token))
    })
    return () => {
      active = false
    }
  }, [enabled, isAuthed])

  useEffect(() => {
    if (!enabled) return
    if (!isSupabaseEnabled || !supabase || !authReady) {
      window.setTimeout(() => {
        setServerChecked(false)
        setServerLlmReady(false)
        setProviderKeysSecure(false)
        setServerReason('Supabase auth or backend status endpoint is missing.')
      }, 0)
      return
    }
    let active = true
    supabase.functions.invoke('backend-status', { body: {} }).then(({ data, error }) => {
      if (!active) return
      const payload = data as StatusResponse | null
      setServerChecked(Boolean(payload?.ok) && !error)
      setServerLlmReady(Boolean(payload?.ok && payload.llmReady))
      setProviderKeysSecure(Boolean(payload?.ok && payload.providerKeysSecure))
      setServerReason(error?.message || payload?.message || payload?.code || 'Backend status checked.')
    })
    return () => {
      active = false
    }
  }, [authReady, enabled])

  return useMemo(() => {
    const supabaseReady = isSupabaseEnabled && live
    const accountReady = profileResolved && Boolean(accountId) && accountId !== 'demo'
    const llmReady = serverChecked && serverLlmReady
    const liveWorkflowReady = Boolean(supabaseReady && authReady && accountReady && llmReady)
    const reason = liveWorkflowReady
      ? 'Live backend is ready.'
      : !supabaseReady
        ? 'Supabase frontend env is missing; using demo/local simulation.'
        : !authReady
          ? 'No authenticated Supabase session; live workflow is disabled.'
          : !accountReady
            ? 'Account profile/workspace is missing; using demo/local simulation.'
            : !llmReady
              ? serverReason || 'LLM provider is not confirmed server-side.'
              : 'Live backend is not configured.'
    const mode: BackendMode = liveWorkflowReady ? 'live' : supabaseReady ? 'not_configured' : 'local_simulation'
    return { authReady, accountReady, supabaseReady, llmReady, liveWorkflowReady, providerKeysSecure, mode, reason }
  }, [accountId, authReady, live, profileResolved, providerKeysSecure, serverChecked, serverLlmReady, serverReason])
}
