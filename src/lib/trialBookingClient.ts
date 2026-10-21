// One transport for the local chat and genuine Auth/PostgREST integration checks.
// No model, service-role credential, inferred approval, or automatic mutation retry.
export interface TrialSlot {
  id: string; course_id: string; course_name: string; starts_at: string
  timezone: string; capacity: number; available: number; status: string
}
export interface TrialOperation {
  operation_id: string; approval_request_id: string; status: string
  payload: Record<string, unknown>; booking_id?: string | null
  result?: Record<string, unknown> | null
}
export function isLocalTrialUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) } catch { return false }
}
type TrialSession = { access_token: string; expires_at?: number; user: { id: string } }
type TrialAuth = {
  getSession: () => Promise<{ data: { session: TrialSession | null }; error: unknown }>
  refreshSession: () => Promise<{ data: { session: TrialSession | null }; error: unknown }>
}
export function createTrialSessionTokenProvider(auth: TrialAuth, userId: string, signal?: AbortSignal) {
  return async () => {
    if (signal?.aborted) throw new Error('TRIAL_SESSION_CHANGED')
    let current = await auth.getSession()
    if (signal?.aborted || (current.data.session && current.data.session.user.id !== userId)) throw new Error('TRIAL_SESSION_CHANGED')
    if (current.error || !current.data.session) throw new Error('TRIAL_AUTH_REQUIRED')
    if ((current.data.session.expires_at ?? 0) <= Date.now() / 1000 + 30) current = await auth.refreshSession()
    if (signal?.aborted || (current.data.session && current.data.session.user.id !== userId)) throw new Error('TRIAL_SESSION_CHANGED')
    if (current.error || !current.data.session || (current.data.session.expires_at ?? 0) <= Date.now() / 1000) throw new Error('TRIAL_AUTH_REQUIRED')
    return current.data.session.access_token
  }
}
export function createTrialBookingClient(config: {
  url: string; apiKey: string; accessToken?: string; getAccessToken?: () => Promise<string>; accountId: string; signal?: AbortSignal
}) {
  if (!isLocalTrialUrl(config.url)) throw new Error('TRIAL_LOCAL_ONLY')
  const rpc = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const token = config.getAccessToken ? await config.getAccessToken() : config.accessToken
    if (!token) throw new Error('TRIAL_AUTH_REQUIRED')
    if (config.signal?.aborted) throw new Error('TRIAL_SESSION_CHANGED')
    const response = await fetch(`${config.url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST', redirect: 'error', signal: config.signal,
      headers: { apikey: config.apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_account_id: config.accountId, ...args }),
    })
    if (!response.ok) {
      if (response.status === 401) throw new Error('TRIAL_AUTH_REQUIRED')
      // Never surface provider bodies, SQL details, secrets or customer fields.
      throw new Error(`TRIAL_REQUEST_FAILED_${response.status}`)
    }
    return await response.json() as T
  }
  return {
    schedule: () => rpc<TrialSlot[]>('trial_booking_schedule'),
    request: (sessionId: string, operationKey: string, attendeeLabel: string) => rpc<TrialOperation>('trial_booking_request', {
      p_session_id: sessionId, p_operation_key: operationKey, p_attendee_label: attendeeLabel,
    }),
    decide: (operationId: string, decision: 'approve' | 'reject') => rpc<TrialOperation>('trial_booking_decide', {
      p_operation_id: operationId, p_decision: decision,
    }),
    execute: (operationId: string) => rpc<TrialOperation>('trial_booking_execute', { p_operation_id: operationId }),
    result: (operationId: string) => rpc<TrialOperation>('trial_booking_result', { p_operation_id: operationId }),
    recover: (operationKey: string) => rpc<TrialOperation | null>('trial_booking_recover', { p_operation_key: operationKey }),
    recent: () => rpc<TrialOperation[]>('trial_booking_recent'),
  }
}
