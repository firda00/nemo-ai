// Agent creation uses a fixed JWT for its entire profile/insert/readback operation.
// The shared Supabase client may refresh or replace its session while requests wait.
interface AgentSession { user: { id: string }; access_token: string }
export interface EmployeeAuthClient {
  auth: {
    getSession: () => PromiseLike<{ data: { session: AgentSession | null }; error?: unknown }>
    onAuthStateChange: (callback: (event: string, session: AgentSession | null) => void) => { data: { subscription: { unsubscribe: () => void } } }
  }
}

export interface EmployeePersistenceOptions {
  alive?: () => boolean
  timeoutMs?: number
  connection?: { url: string; anonKey: string }
  fetch?: typeof globalThis.fetch
}

export class EmployeePersistenceError extends Error {
  readonly code: 'AUTH_REQUIRED' | 'SESSION_CHANGED' | 'PROFILE_UNAVAILABLE' | 'SAVE_TIMEOUT' | 'SAVE_FAILED' | 'DRAFT_CONFLICT' | 'BACKEND_UNAVAILABLE'
  constructor(code: EmployeePersistenceError['code']) {
    super(code)
    this.name = 'EmployeePersistenceError'
    this.code = code
  }
}

type Row = Record<string, unknown>
interface Scope {
  accountId: string
  userId: string
  isAdmin: boolean
  check: () => void
  request: (table: string, query: Record<string, string>, row?: Row) => Promise<{ ok: boolean; status: number; data: unknown }>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isRow = (value: unknown): value is Row => Boolean(value && typeof value === 'object' && !Array.isArray(value))

async function withEmployeeScope<T>(client: EmployeeAuthClient, options: EmployeePersistenceOptions, work: (scope: Scope) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let stopCode: 'SESSION_CHANGED' | 'SAVE_TIMEOUT' = 'SESSION_CHANGED'
  const stop = (code: typeof stopCode) => { stopCode = code; controller.abort() }
  let userId: string | undefined
  let observedUserId: string | null | undefined
  const subscription = client.auth.onAuthStateChange((event, session) => {
    observedUserId = session?.user.id ?? null
    if (event === 'SIGNED_OUT' || (userId === undefined && event === 'SIGNED_IN') || (userId !== undefined && observedUserId !== userId)) stop('SESSION_CHANGED')
  }).data.subscription
  const check = () => {
    if (controller.signal.aborted) throw new EmployeePersistenceError(stopCode)
    if (options.alive && !options.alive()) {
      stop('SESSION_CHANGED')
      throw new EmployeePersistenceError('SESSION_CHANGED')
    }
  }
  const timer = setTimeout(() => stop('SAVE_TIMEOUT'), options.timeoutMs ?? 15_000)
  let rejectOnAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(new EmployeePersistenceError(stopCode))
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
  })
  try {
    const operation = (async () => {
      check()
      const { data, error } = await client.auth.getSession()
      check()
      const session = data?.session
      if (error || !session?.user.id || !session.access_token) throw new EmployeePersistenceError('AUTH_REQUIRED')
      userId = session.user.id
      if (observedUserId !== undefined && observedUserId !== userId) throw new EmployeePersistenceError('SESSION_CHANGED')

      const connection = options.connection ?? {
        url: String(import.meta.env.VITE_SUPABASE_URL ?? ''),
        anonKey: String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''),
      }
      if (!connection.url || !connection.anonKey) throw new EmployeePersistenceError('BACKEND_UNAVAILABLE')
      const token = session.access_token
      const request: Scope['request'] = async (table, query, row) => {
        check()
        const url = new URL(`rest/v1/${table}`, connection.url.replace(/\/?$/, '/'))
        for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
        const response = await (options.fetch ?? globalThis.fetch)(url, {
          method: row ? 'POST' : 'GET',
          headers: { apikey: connection.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(row ? { Prefer: 'return=representation' } : {}) },
          ...(row ? { body: JSON.stringify(row) } : {}), signal: controller.signal,
        })
        check()
        // The outer deadline also bounds stalled response bodies, not just fetch.
        const text = await response.text()
        check()
        if (text.length > 2_000_000) throw new EmployeePersistenceError('SAVE_FAILED')
        let body: unknown
        try { body = text ? JSON.parse(text) : null } catch { throw new EmployeePersistenceError('SAVE_FAILED') }
        return { ok: response.ok, status: response.status, data: body }
      }
      let profile: Awaited<ReturnType<typeof request>>
      try { profile = await request('users', { select: 'account_id,is_admin', id: `eq.${userId}`, limit: '1' }) }
      catch (error) {
        check()
        if (error instanceof EmployeePersistenceError) throw error
        throw new EmployeePersistenceError('PROFILE_UNAVAILABLE')
      }
      if (!profile.ok || !Array.isArray(profile.data) || profile.data.length !== 1 || !isRow(profile.data[0]) || typeof profile.data[0].account_id !== 'string' || !UUID.test(profile.data[0].account_id)) {
        throw new EmployeePersistenceError('PROFILE_UNAVAILABLE')
      }
      const result = await work({ accountId: profile.data[0].account_id, userId, isAdmin: profile.data[0].is_admin === true, check, request })
      check()
      return result
    })()
    return await Promise.race([operation, cancelled])
  } finally {
    clearTimeout(timer)
    if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort)
    subscription.unsubscribe()
  }
}

export async function resolveEmployeeAccount(client: EmployeeAuthClient, options: EmployeePersistenceOptions = {}) {
  return withEmployeeScope(client, options, async ({ accountId, userId, isAdmin }) => ({ accountId, userId, isAdmin }))
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRow(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

/** A conflict can recover only the same UUID, tenant and exact authoring payload. No upsert. */
export async function persistEmployeeDraft(client: EmployeeAuthClient, clientId: string, sourceRow: Row, options: EmployeePersistenceOptions = {}) {
  const row = JSON.parse(JSON.stringify(sourceRow)) as Row
  // Caller-controlled identifiers cannot override the verified tenant scope.
  delete row.id
  delete row.account_id
  const requestedId = UUID.test(clientId) ? clientId.toLowerCase() : undefined
  return withEmployeeScope(client, options, async (scope) => {
    const payload = { ...row, ...(requestedId ? { id: requestedId } : {}), account_id: scope.accountId }
    const matches = (data: unknown): data is Row => isRow(data)
      && typeof data.id === 'string' && UUID.test(data.id)
      && (!requestedId || data.id === requestedId)
      && data.account_id === scope.accountId
      && Object.entries(payload).every(([key, value]) => canonical(data[key]) === canonical(value)
        // The database may strengthen the submitted safety tier. No other
        // authored field may change, and regulated can never weaken to standard.
        || (key === 'risk_tier' && value === 'standard' && data[key] === 'regulated'))
    let result: Awaited<ReturnType<Scope['request']>> | undefined
    try { result = await scope.request('agents', { select: '*,channels(type)' }, payload) }
    catch (error) {
      scope.check()
      if (error instanceof EmployeePersistenceError || !requestedId) throw new EmployeePersistenceError('SAVE_FAILED')
      // A lost network reply may follow a committed insert; readback is safe.
    }
    if (result?.ok && Array.isArray(result.data) && result.data.length === 1 && matches(result.data[0])) {
      return { row: result.data[0], accountId: scope.accountId, userId: scope.userId, isAdmin: scope.isAdmin }
    }
    // PostgreSQL BEFORE INSERT plan/rate checks can raise P0001 before the UUID
    // unique constraint, even when a timed-out attempt already committed this row.
    const beforeInsertRefusal = result?.status === 400 && isRow(result.data) && result.data.code === 'P0001'
    if (requestedId && (!result || result.status === 409 || result.status >= 500 || beforeInsertRefusal)) {
      const existing = await scope.request('agents', { select: '*,channels(type)', id: `eq.${requestedId}`, account_id: `eq.${scope.accountId}`, limit: '1' })
      if (existing.ok && Array.isArray(existing.data) && existing.data.length === 1) {
        if (!matches(existing.data[0])) throw new EmployeePersistenceError('DRAFT_CONFLICT')
        return { row: existing.data[0], accountId: scope.accountId, userId: scope.userId, isAdmin: scope.isAdmin }
      }
    }
    throw new EmployeePersistenceError('SAVE_FAILED')
  })
}
