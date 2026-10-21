import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistEmployeeDraft, resolveEmployeeAccount, type EmployeeAuthClient } from '../src/lib/employeePersistence'

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EMPLOYEE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SERVER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const connection = { url: 'https://database.example.test', anonKey: 'public-test-key' }
const draft = { name: 'Finance', prompt: { role: 'Analyst', tasks: 'Use the supplied records', tone: 'Clear', rules: 'Approval required' }, status: 'draft', skills: ['data-analysis'], action_policy: 'approval_required' }
type Session = { user: { id: string }; access_token: string }

function authClient() {
  let current: Session | null = { user: { id: 'user-a' }, access_token: 'fixed-token-a' }
  const callbacks = new Set<(event: string, session: Session | null) => void>()
  const client: EmployeeAuthClient = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: current } })),
      onAuthStateChange: (callback) => { callbacks.add(callback); return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } } },
    },
  }
  return {
    client, callbacks,
    emit: (event: string, next: Session | null) => { current = next; for (const callback of [...callbacks]) callback(event, next) },
  }
}

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const profile = () => response([{ account_id: ACCOUNT_A, is_admin: false }])
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.doUnmock('../src/lib/supabase')
  vi.doUnmock('../src/lib/telemetry')
})

describe('bounded tenant-scoped employee persistence', () => {
  it.each([[], [{ account_id: null }], [{ account_id: 'demo' }]])('rejects missing or invalid live profiles: %j', async (records) => {
    const auth = authClient()
    const fetch = vi.fn(async () => response(records))
    await expect(persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch })).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(auth.callbacks.size).toBe(0)
  })

  it('rejects unauthenticated and profile-error states without an insert or demo fallback', async () => {
    const auth = authClient()
    auth.emit('SIGNED_OUT', null)
    const fetch = vi.fn(async () => response({ message: 'private backend detail' }, 500))
    await expect(persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(fetch).not.toHaveBeenCalled()
    auth.emit('SIGNED_IN', { user: { id: 'user-a' }, access_token: 'fixed-token-a' })
    await expect(resolveEmployeeAccount(auth.client, { connection, fetch })).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['session', 'fetch', 'body'])('bounds a stalled %s and releases its auth listener', async (stage) => {
    vi.useFakeTimers()
    const auth = authClient()
    const never = new Promise<never>(() => {})
    if (stage === 'session') vi.mocked(auth.client.auth.getSession).mockReturnValue(never)
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeDefined()
      if (stage === 'fetch') return never
      return { ok: true, status: 200, text: () => never } as unknown as Response
    })
    const operation = persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch, timeoutMs: 25 })
    const result = expect(operation).rejects.toMatchObject({ code: 'SAVE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(26)
    await result
    expect(auth.callbacks.size).toBe(0)
  })

  it('pins every request to the original JWT despite same-user token refresh', async () => {
    const auth = authClient()
    const authorization: string[] = []
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get('Authorization')!)
      if (String(input).includes('/users?')) {
        auth.emit('TOKEN_REFRESHED', { user: { id: 'user-a' }, access_token: 'new-token-a' })
        return profile()
      }
      return response([{ ...JSON.parse(String(init?.body)), channels: [] }], 201)
    })
    const result = await persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch })
    expect(result.row.id).toBe(EMPLOYEE_ID)
    expect(authorization).toEqual(['Bearer fixed-token-a', 'Bearer fixed-token-a'])
  })

  it('stops before any request when identity changes during session lookup', async () => {
    const auth = authClient()
    const session = deferred<Awaited<ReturnType<EmployeeAuthClient['auth']['getSession']>>>()
    vi.mocked(auth.client.auth.getSession).mockReturnValue(session.promise)
    const fetch = vi.fn()
    const operation = persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch })
    auth.emit('SIGNED_IN', { user: { id: 'user-b' }, access_token: 'token-b' })
    session.resolve({ data: { session: { user: { id: 'user-a' }, access_token: 'fixed-token-a' } } })
    await expect(operation).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not adopt the new user returned by a late session lookup', async () => {
    const auth = authClient()
    const session = deferred<Awaited<ReturnType<EmployeeAuthClient['auth']['getSession']>>>()
    vi.mocked(auth.client.auth.getSession).mockReturnValue(session.promise)
    const fetch = vi.fn()
    const operation = persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch })
    const newSession = { user: { id: 'user-b' }, access_token: 'token-b' }
    auth.emit('SIGNED_IN', newSession)
    session.resolve({ data: { session: newSession } })
    await expect(operation).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels pending insert on logout, ignores its late result and does not read it back', async () => {
    const auth = authClient()
    const insert = deferred<Response>()
    const started = deferred<AbortSignal>()
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') { started.resolve(init.signal!); return insert.promise }
      return profile()
    })
    const operation = persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch })
    const signal = await started.promise
    auth.emit('SIGNED_OUT', null)
    await expect(operation).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    expect(signal.aborted).toBe(true)
    insert.resolve(response([{ ...draft, id: EMPLOYEE_ID, account_id: ACCOUNT_A }], 201))
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('checks caller account scope again before an insert', async () => {
    const auth = authClient()
    let alive = true
    const fetch = vi.fn(async () => { alive = false; return profile() })
    await expect(persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch, alive: () => alive })).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['conflict', 'lost-response', 'before-insert-plan-trigger'])('recovers the same UUID and payload after %s without upsert', async (failure) => {
    const auth = authClient()
    let saved: Record<string, unknown> = {}
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/users?')) return profile()
      if (init?.method === 'POST') {
        saved = JSON.parse(String(init.body))
        expect(new Headers(init.headers).get('Prefer')).toBe('return=representation')
        if (failure === 'lost-response') throw new TypeError('Network reply lost')
        if (failure === 'before-insert-plan-trigger') return response({ code: 'P0001' }, 400)
        return response({ code: '23505' }, 409)
      }
      const url = new URL(String(input))
      expect(url.searchParams.get('id')).toBe(`eq.${EMPLOYEE_ID}`)
      expect(url.searchParams.get('account_id')).toBe(`eq.${ACCOUNT_A}`)
      return response([{ ...saved, channels: [] }])
    })
    const result = await persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch })
    expect(result.row.id).toBe(EMPLOYEE_ID)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('accepts only server strengthening of risk, on insert and exact UUID recovery', async () => {
    for (const conflict of [false, true]) {
      const auth = authClient()
      const guarded = { ...draft, risk_tier: 'standard', niche: 'Customer context nemo-risk:regulated' }
      const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes('/users?')) return profile()
        if (init?.method === 'POST' && conflict) return response({ code: '23505' }, 409)
        return response([{ ...guarded, id: EMPLOYEE_ID, account_id: ACCOUNT_A, risk_tier: 'regulated' }], init?.method === 'POST' ? 201 : 200)
      })
      const result = await persistEmployeeDraft(auth.client, EMPLOYEE_ID, guarded, { connection, fetch })
      expect(result.row.risk_tier).toBe('regulated')
    }
  })

  it('rejects safety weakening and other changes despite server risk strengthening', async () => {
    for (const patch of [{ risk_tier: 'standard' }, { risk_tier: 'regulated', name: 'changed' }]) {
      const auth = authClient()
      const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes('/users?')) return profile()
        if (init?.method === 'POST') return response({ code: '23505' }, 409)
        return response([{ ...draft, id: EMPLOYEE_ID, account_id: ACCOUNT_A, ...patch }])
      })
      await expect(persistEmployeeDraft(auth.client, EMPLOYEE_ID, { ...draft, risk_tier: 'regulated' }, { connection, fetch })).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' })
    }
  })

  it('does not recover privilege denial represented as SQLSTATE 42501', async () => {
    const auth = authClient()
    const fetch = vi.fn(async (input: unknown) => String(input).includes('/users?') ? profile() : response({ code: '42501' }, 400))
    await expect(persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch })).rejects.toMatchObject({ code: 'SAVE_FAILED' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([{ name: 'Someone else’s employee' }, { account_id: ACCOUNT_B }, { id: SERVER_ID }])('rejects readback of an unrelated row: %j', async (patch) => {
    const auth = authClient()
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/users?')) return profile()
      if (init?.method === 'POST') return response({ code: '23505' }, 409)
      return response([{ ...draft, id: EMPLOYEE_ID, account_id: ACCOUNT_A, ...patch }])
    })
    await expect(persistEmployeeDraft(auth.client, EMPLOYEE_ID, draft, { connection, fetch })).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' })
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('preserves server-generated IDs for legacy drafts and overrides a supplied tenant', async () => {
    const auth = authClient()
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/users?')) return profile()
      const payload = JSON.parse(String(init?.body))
      expect(payload).not.toHaveProperty('id')
      expect(payload.account_id).toBe(ACCOUNT_A)
      return response([{ ...payload, id: SERVER_ID }], 201)
    })
    const result = await persistEmployeeDraft(auth.client, 'ag_123', { ...draft, id: 'bad-id', account_id: ACCOUNT_B }, { connection, fetch })
    expect(result.row.id).toBe(SERVER_ID)
  })

  it('does not read back a definitive authorization rejection or a non-UUID unknown insert', async () => {
    for (const clientId of [EMPLOYEE_ID, 'ag_123']) {
      const auth = authClient()
      const fetch = vi.fn(async (input: unknown) => {
        if (String(input).includes('/users?')) return profile()
        if (clientId === 'ag_123') throw new TypeError('network')
        return response({ message: 'not allowed' }, 403)
      })
      await expect(persistEmployeeDraft(auth.client, clientId, draft, { connection, fetch })).rejects.toMatchObject({ code: 'SAVE_FAILED' })
      expect(fetch).toHaveBeenCalledTimes(2)
    }
  })

  it('snapshots the payload before async lookup so a retry draft cannot mutate in flight', async () => {
    const auth = authClient()
    const input = structuredClone(draft)
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/users?')) { input.prompt.tasks = 'mutated'; return profile() }
      const payload = JSON.parse(String(init?.body))
      expect(payload.prompt.tasks).toBe(draft.prompt.tasks)
      return response([{ ...payload }], 201)
    })
    await persistEmployeeDraft(auth.client, EMPLOYEE_ID, input, { connection, fetch })
  })
})

async function liveStore(auth: ReturnType<typeof authClient>) {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', connection.url)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', connection.anonKey)
  vi.doMock('../src/lib/supabase', () => ({ supabase: auth.client, isSupabaseEnabled: true }))
  vi.doMock('../src/lib/telemetry', () => ({ trackEvent: vi.fn() }))
  return import('../src/store/useAgentStore')
}

describe('live employee registry integration', () => {
  it('never creates a fake local success after a profile outage', async () => {
    const auth = authClient()
    const { useAgentStore, blankAgent } = await liveStore(auth)
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'backend offline' }, 503)))
    const employee = { ...blankAgent(), id: EMPLOYEE_ID, name: 'Employee' }
    const result = await useAgentStore.getState().addAgent(employee)
    expect(result).toEqual({ error: 'PROFILE_UNAVAILABLE' })
    expect(useAgentStore.getState().agents).toEqual([])
    expect(await useAgentStore.getState().ensureAccountId()).toBeNull()
    expect(useAgentStore.getState().accountId).toBeNull()
    expect(useAgentStore.getState().profileResolved).toBe(false)
  })

  it('publishes exactly one confirmed UUID row across repeat saves', async () => {
    const auth = authClient()
    const { useAgentStore, blankAgent } = await liveStore(auth)
    const saved = new Map<string, Record<string, unknown>>()
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/users?')) return profile()
      if (init?.method === 'POST') {
        const payload = JSON.parse(String(init.body))
        if (saved.has(payload.id)) return response({ code: '23505' }, 409)
        saved.set(payload.id, payload)
        return response([payload], 201)
      }
      return response([saved.get(EMPLOYEE_ID)])
    }))
    const employee = { ...blankAgent(), id: EMPLOYEE_ID, name: 'Employee' }
    expect(await useAgentStore.getState().addAgent(employee)).toEqual({ id: EMPLOYEE_ID })
    expect(await useAgentStore.getState().addAgent(employee)).toEqual({ id: EMPLOYEE_ID })
    expect(useAgentStore.getState().agents.map((agent) => agent.id)).toEqual([EMPLOYEE_ID])
    expect(useAgentStore.getState().accountId).toBe(ACCOUNT_A)
  })

  it('clears tenant cache on logout and ignores a completed insert from the old session', async () => {
    const auth = authClient()
    const { useAgentStore, blankAgent } = await liveStore(auth)
    auth.emit('INITIAL_SESSION', { user: { id: 'user-a' }, access_token: 'fixed-token-a' })
    useAgentStore.setState({ accountId: ACCOUNT_A, isAdmin: true, tokenBalance: 99, profileResolved: true, agents: [{ ...blankAgent(), name: 'Old tenant' }] })
    const insert = deferred<Response>()
    const started = deferred<void>()
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') { started.resolve(); return insert.promise }
      return profile()
    }))
    const pending = useAgentStore.getState().addAgent({ ...blankAgent(), id: EMPLOYEE_ID, name: 'Pending' })
    await started.promise
    expect(useAgentStore.getState().agents).toHaveLength(1)
    auth.emit('SIGNED_OUT', null)
    auth.emit('SIGNED_IN', { user: { id: 'user-b' }, access_token: 'token-b' })
    expect(await pending).toEqual({ error: 'SESSION_CHANGED' })
    insert.resolve(response([{ ...draft, id: EMPLOYEE_ID, account_id: ACCOUNT_A }], 201))
    await Promise.resolve()
    expect(useAgentStore.getState()).toMatchObject({ accountId: null, isAdmin: false, tokenBalance: 0, profileResolved: false, agents: [] })
  })

  it('does not hydrate demo data for an unauthenticated live client', async () => {
    const auth = authClient()
    const { useAgentStore } = await liveStore(auth)
    auth.emit('SIGNED_OUT', null)
    await useAgentStore.getState().hydrate({ forceProfile: true })
    expect(useAgentStore.getState()).toMatchObject({ agents: [], accountId: null, profileResolved: false })
  })

  it('does not restore a late hydration profile after signing out', async () => {
    const auth = authClient()
    const pendingProfile = deferred<{ data: { account_id: string }; error: null }>()
    const started = deferred<void>()
    const query = { select: () => query, eq: () => query, maybeSingle: () => { started.resolve(); return pendingProfile.promise } }
    const from = vi.fn(() => query)
    Object.assign(auth.client, { from })
    const { useAgentStore } = await liveStore(auth)
    auth.emit('INITIAL_SESSION', { user: { id: 'user-a' }, access_token: 'fixed-token-a' })
    const operation = useAgentStore.getState().hydrate({ forceProfile: true })
    await started.promise
    auth.emit('SIGNED_OUT', null)
    pendingProfile.resolve({ data: { account_id: ACCOUNT_A }, error: null })
    await operation
    expect(from).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState()).toMatchObject({ agents: [], accountId: null, isAdmin: false, profileResolved: false })
  })
})
