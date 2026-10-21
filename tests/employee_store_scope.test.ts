import { afterEach, expect, it, vi } from 'vitest'

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EMPLOYEE_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EMPLOYEE_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
type Session = { user: { id: string }; access_token: string } | null
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

async function setup() {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://database.example.invalid')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'mock-public-key')
  const handlers = new Set<(event: string, session: Session) => void>()
  let session: Session = { user: { id: 'user-a' }, access_token: 'mock-token-a' }
  const getSession = vi.fn(async () => ({ data: { session } }))
  const client = { auth: { getSession,
    onAuthStateChange: (callback: (event: string, session: Session) => void) => { handlers.add(callback); return { data: { subscription: { unsubscribe: () => handlers.delete(callback) } } } } } }
  const emit = (event: string, next: Session) => { session = next; for (const handler of [...handlers]) handler(event, next) }
  vi.doMock('../src/lib/supabase', () => ({ supabase: client, isSupabaseEnabled: true }))
  vi.doMock('../src/lib/telemetry', () => ({ trackEvent: vi.fn() }))
  const { useAgentStore: store, blankAgent } = await import('../src/store/useAgentStore')
  emit('INITIAL_SESSION', session)
  const employeeA = { ...blankAgent(), id: EMPLOYEE_A, name: 'Tenant A private role', status: 'active' as const }
  const employeeB = { ...blankAgent(), id: EMPLOYEE_B, name: 'Other role' }
  store.setState({ accountId: ACCOUNT_A, agents: [employeeA], profileResolved: true })
  const switchTenant = () => {
    emit('SIGNED_OUT', null); emit('SIGNED_IN', { user: { id: 'user-b' }, access_token: 'mock-token-b' })
    store.setState({ accountId: ACCOUNT_B, agents: [employeeB], profileResolved: true })
  }
  const pending = deferred<Response>()
  const started = deferred<RequestInit>()
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input).includes('/users?')) return response([{ account_id: ACCOUNT_A, is_admin: false }])
    started.resolve(init!); return pending.promise
  })
  vi.stubGlobal('fetch', fetch)
  return { store, emit, getSession, handlers, employeeA, employeeB, switchTenant, pending, started, fetch }
}

afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules()
  vi.doUnmock('../src/lib/supabase'); vi.doUnmock('../src/lib/telemetry')
})

for (const method of ['deleteAgent', 'toggleAgent', 'updateAgent', 'duplicateAgent'] as const) {
  it(`${method}: logout aborts the original request; late success/failure cannot publish into another tenant`, async () => {
    const h = await setup()
    const operation = method === 'updateAgent' ? h.store.getState().updateAgent(EMPLOYEE_A, { name: 'Edited' }) : h.store.getState()[method](EMPLOYEE_A)
    const init = await h.started.promise
    h.switchTenant()
    expect(await operation).toEqual({ error: 'SESSION_CHANGED' })
    expect(init.signal?.aborted).toBe(true)
    h.pending.resolve(response({ message: 'late private provider error' }, 500))
    await Promise.resolve()
    expect(h.store.getState().accountId).toBe(ACCOUNT_B)
    expect(h.store.getState().agents).toEqual([h.employeeB])
    expect(h.handlers.size).toBe(1)
  })
}

for (const method of ['deleteAgent', 'toggleAgent'] as const) {
  it(`${method}: a same-session failure preserves unrelated newly added rows`, async () => {
    const h = await setup()
    const operation = h.store.getState()[method](EMPLOYEE_A)
    await h.started.promise
    h.store.setState(state => ({ agents: [...state.agents, h.employeeB] }))
    h.pending.resolve(response({ message: 'failed' }, 500))
    expect(await operation).toEqual({ error: 'SAVE_FAILED' })
    expect(h.store.getState().agents.find(row => row.id === EMPLOYEE_A)).toEqual(h.employeeA)
    expect(h.store.getState().agents.find(row => row.id === EMPLOYEE_B)).toEqual(h.employeeB)
  })
}

it('every mutation query retains the original JWT and explicit account/id despite token refresh', async () => {
  const h = await setup()
  h.fetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer mock-token-a')
    const url = new URL(String(input))
    if (url.pathname.endsWith('/users')) {
      h.emit('TOKEN_REFRESHED', { user: { id: 'user-a' }, access_token: 'replacement-token-a' })
      return response([{ account_id: ACCOUNT_A }])
    }
    expect(url.searchParams.get('id')).toBe(`eq.${EMPLOYEE_A}`)
    expect(url.searchParams.get('account_id')).toBe(`eq.${ACCOUNT_A}`)
    return response([{ id: EMPLOYEE_A, account_id: ACCOUNT_A, ...JSON.parse(String(init?.body)), channels: [] }])
  })
  expect(await h.store.getState().updateAgent(EMPLOYEE_A, { name: 'Confirmed' })).toEqual({})
  expect(h.store.getState().agents[0].name).toBe('Confirmed')
})

it('identity replacement during getSession never starts a profile or write request', async () => {
  const h = await setup()
  const pendingSession = deferred<{ data: { session: Session } }>()
  h.getSession.mockReturnValue(pendingSession.promise)
  const operation = h.store.getState().deleteAgent(EMPLOYEE_A)
  h.switchTenant()
  expect(await operation).toEqual({ error: 'SESSION_CHANGED' })
  pendingSession.resolve({ data: { session: { user: { id: 'user-b' }, access_token: 'new-user-token' } } })
  await Promise.resolve()
  expect(h.fetch).not.toHaveBeenCalled()
  expect(h.store.getState().agents).toEqual([h.employeeB])
})

it('a changed profile account refuses the mutation even when the auth user is unchanged', async () => {
  const h = await setup()
  h.fetch.mockResolvedValue(response([{ account_id: ACCOUNT_B }]))
  expect(await h.store.getState().updateAgent(EMPLOYEE_A, { name: 'Rejected' })).toEqual({ error: 'SESSION_CHANGED' })
  expect(h.fetch).toHaveBeenCalledTimes(1)
})

it('an older same-row failure cannot roll back a newer confirmed edit', async () => {
  const h = await setup()
  const older = h.store.getState().updateAgent(EMPLOYEE_A, { name: 'Older edit' })
  await h.started.promise
  h.fetch.mockImplementation(async (input: unknown, init?: RequestInit) => String(input).includes('/users?')
    ? response([{ account_id: ACCOUNT_A }])
    : response([{ ...JSON.parse(String(init?.body)), id: EMPLOYEE_A, account_id: ACCOUNT_A, channels: [] }]))
  const newer = h.store.getState().updateAgent(EMPLOYEE_A, { name: 'Newer edit' })
  await Promise.resolve()
  // The later PATCH is queued; its optimistic edit remains visible.
  expect(h.fetch).toHaveBeenCalledTimes(2)
  h.pending.resolve(response({ message: 'older error' }, 500))
  expect(await older).toEqual({ error: 'SAVE_FAILED' })
  expect(await newer).toEqual({})
  expect(h.store.getState().agents[0].name).toBe('Newer edit')
})

it('two failed queued edits restore the last confirmed row, not an earlier failed optimistic value', async () => {
  const h = await setup()
  const older = h.store.getState().updateAgent(EMPLOYEE_A, { name: 'First failed edit' })
  await h.started.promise
  h.fetch.mockImplementation(async (input: unknown) => String(input).includes('/users?')
    ? response([{ account_id: ACCOUNT_A }]) : response({ message: 'second failed edit' }, 500))
  const newer = h.store.getState().updateAgent(EMPLOYEE_A, { name: 'Second failed edit' })
  h.pending.resolve(response({ message: 'first failed edit' }, 500))
  await Promise.all([older, newer])
  expect(h.store.getState().agents[0]).toEqual(h.employeeA)
})

it('duplicate is absent until its UUID row is confirmed; connections and publication evidence are not copied', async () => {
  const h = await setup()
  h.store.setState({ agents: [{ ...h.employeeA, channels: ['telegram'], publishedRevision: 9, latestEvalRunId: EMPLOYEE_B }] })
  const operation = h.store.getState().duplicateAgent(EMPLOYEE_A)
  const init = await h.started.promise
  expect(h.store.getState().agents).toHaveLength(1)
  const payload = JSON.parse(String(init.body))
  expect(payload.id).not.toBe(EMPLOYEE_A)
  expect(payload.status).toBe('draft')
  expect(payload).not.toHaveProperty('channels')
  h.pending.resolve(response([{ ...payload, channels: [], config_revision: 1, published_revision: null, latest_eval_run_id: null }], 201))
  expect(await operation).toEqual({ id: payload.id })
  expect(h.store.getState().agents[0]).toMatchObject({ channels: [], status: 'draft', publishedRevision: null, latestEvalRunId: null })
})

for (const stage of ['fetch', 'body'] as const) {
  it(`mutation deadline bounds an unresponsive ${stage} and removes its auth listener`, async () => {
    const h = await setup()
    vi.useFakeTimers()
    if (stage === 'body') h.pending.resolve({ ok: true, text: () => new Promise<string>(() => {}) } as Response)
    const operation = h.store.getState().toggleAgent(EMPLOYEE_A)
    const waiting = expect(operation).resolves.toEqual({ error: 'SAVE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(15_001)
    await waiting
    expect(h.handlers.size).toBe(1)
    expect(h.store.getState().agents[0].status).toBe('active')
  })
}
