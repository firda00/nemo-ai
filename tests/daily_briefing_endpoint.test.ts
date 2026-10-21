// Daily-briefing Step 2a — offline tests for the injected handler and the Google calendar
// module. Fake db + scripted fetch only; no network, no real credentials, no Telegram send
// exists anywhere in the tested surface.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { buildYesterdayOutcome, handleDailyBriefing, readRequestBodyBounded, type DailyBriefingDeps } from '../supabase/functions/_shared/dailyBriefingHandler.ts'
import { fetchOwnerCalendarSection, type GoogleCalendarDeps } from '../supabase/functions/_shared/dailyBriefingGoogle.ts'
import { type CalendarSection, type FetchLike } from '../supabase/functions/_shared/dailyBriefingSources.ts'

const NOW = () => new Date('2026-09-05T02:59:00Z') // 07:59 Tashkent
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type QueueResult = { data?: unknown; error?: unknown; count?: number | null }

// Minimal chainable Supabase fake: per-table result queues, every op recorded. There is
// deliberately NO .delete() method — code under test must not even be able to express one.
function fakeDb(queue: Record<string, QueueResult[]>) {
  const ops: string[] = []
  const upserts: Array<{ table: string; row: Record<string, unknown> }> = []
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const next = (table: string): QueueResult => {
    const q = queue[table]
    return q && q.length ? q.shift()! : { data: null, error: null, count: null }
  }
  return {
    ops,
    upserts,
    rpcCalls,
    rpc(name: string, args: Record<string, unknown>) {
      ops.push(`rpc.${name}`)
      rpcCalls.push({ name, args })
      return Promise.resolve(next(`rpc:${name}`))
    },
    from(table: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      for (const method of ['select', 'eq', 'neq', 'gte', 'lt', 'not', 'order', 'limit', 'or', 'is']) {
        chain[method] = (...args: unknown[]) => { ops.push(`${table}.${method}${method === 'or' ? `:${String(args[0])}` : ''}`); return chain }
      }
      chain.upsert = (row: Record<string, unknown>) => { ops.push(`${table}.upsert`); upserts.push({ table, row }); return chain }
      chain.maybeSingle = () => { ops.push(`${table}.maybeSingle`); return Promise.resolve(next(table)) }
      chain.then = (onFulfilled: (v: QueueResult) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(next(table)).then(onFulfilled, onRejected)
      return chain
    },
  }
}

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

function scriptedFetch(handlers: Array<(url: string, init: Parameters<FetchLike>[1]) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return handlers[Math.min(calls.length - 1, handlers.length - 1)](url, init)
  }
  return { impl, calls }
}

const readyCalendar: CalendarSection = {
  status: 'ready', source: 'www.googleapis.com/calendar', fetchedAt: NOW().toISOString(),
  data: { events: [], truncated: false },
}

// ── Google calendar module ───────────────────────────────────────────────────────────────────────

describe('fetchOwnerCalendarSection', () => {
  const CBU_UNUSED: Array<(url: string, init: Parameters<FetchLike>[1]) => Response> = [() => jsonResponse({})]
  const baseDeps = (db: ReturnType<typeof fakeDb>, impl: FetchLike): GoogleCalendarDeps => ({
    db, fetchImpl: impl,
    decrypt: async (sealed) => `plain-${sealed}`,
    envApp: { id: 'env-id', secret: 'env-secret' },
    now: NOW,
  })
  const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
  const accountRow = (scopes: unknown) => ({ data: { refresh_token: 'sealed-rt', scopes }, error: null })

  test('no connection and no scope refuse before any spend — zero fetches', async () => {
    for (const [row, detail] of [
      [{ data: null, error: null }, 'not_connected'],
      [accountRow('https://www.googleapis.com/auth/calendar.settings.readonly https://www.googleapis.com/auth/calendar.freebusy'), 'no_scope'],
    ] as const) {
      const db = fakeDb({ google_accounts: [row as QueueResult] })
      const { impl, calls } = scriptedFetch(CBU_UNUSED)
      const section = await fetchOwnerCalendarSection(baseDeps(db, impl), { accountId: 'acc-1', date: '2026-09-05' })
      expect(section).toMatchObject({ status: 'unavailable', detail })
      expect(calls).toHaveLength(0)
    }
  })

  test('a DB error never falls back to the env app — and neither does a malformed app row', async () => {
    const cases: Array<[QueueResult[], QueueResult[], string]> = [
      [[{ data: null, error: { code: '57014' } }], [], 'db_error'], // google_accounts read failed
      [[accountRow(CAL_SCOPE)], [{ data: null, error: { code: '57014' } }], 'db_error'], // apps read failed
      [[accountRow(CAL_SCOPE)], [{ data: { client_id: '', client_secret: 'sealed' }, error: null }], 'no_app'], // present but malformed
    ]
    for (const [accounts, apps, detail] of cases) {
      const db = fakeDb({ google_accounts: accounts, google_oauth_apps: apps })
      const { impl, calls } = scriptedFetch(CBU_UNUSED)
      const section = await fetchOwnerCalendarSection(baseDeps(db, impl), { accountId: 'acc-1', date: '2026-09-05' })
      expect(section).toMatchObject({ status: 'unavailable', detail })
      expect(calls).toHaveLength(0)
    }
  })

  test('absent app row uses the env app; success reaches the calendar with the fresh token', async () => {
    const db = fakeDb({ google_accounts: [accountRow(CAL_SCOPE)], google_oauth_apps: [{ data: null, error: null }] })
    const { impl, calls } = scriptedFetch([
      () => jsonResponse({ access_token: 'fresh-token' }),
      () => jsonResponse({ items: [] }),
    ])
    const section = await fetchOwnerCalendarSection(baseDeps(db, impl), { accountId: 'acc-1', date: '2026-09-05' })
    expect(section.status).toBe('ready')
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[0].init.body).toContain('client_id=env-id')
    expect(calls[0].init.body).toContain('refresh_token=plain-sealed-rt')
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[1].init.headers?.Authorization).toBe('Bearer fresh-token')
    expect(JSON.stringify(section)).not.toContain('fresh-token')
    expect(JSON.stringify(section)).not.toContain('sealed-rt')
    expect(JSON.stringify(section)).not.toContain('env-secret')
    expect(db.ops.some((op) => op.includes('delete'))).toBe(false)
  })

  test('invalid_client is auth — and NOTHING is deleted, unlike the legacy shared helper', async () => {
    const db = fakeDb({ google_accounts: [accountRow(CAL_SCOPE)], google_oauth_apps: [{ data: null, error: null }] })
    const { impl, calls } = scriptedFetch([() => jsonResponse({ error: 'invalid_client' }, 401)])
    const section = await fetchOwnerCalendarSection(baseDeps(db, impl), { accountId: 'acc-1', date: '2026-09-05' })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'auth' })
    expect(calls).toHaveLength(1)
    expect(db.ops.some((op) => op.includes('delete') || op.includes('upsert'))).toBe(false)
  })

  test('a token is only accepted from an HTTP-success response', async () => {
    for (const [status, detail] of [[500, 'network'], [403, 'auth']] as const) {
      const db = fakeDb({ google_accounts: [accountRow(CAL_SCOPE)], google_oauth_apps: [{ data: null, error: null }] })
      const { impl } = scriptedFetch([() => jsonResponse({ access_token: 'sneaky' }, status)])
      const section = await fetchOwnerCalendarSection(baseDeps(db, impl), { accountId: 'acc-1', date: '2026-09-05' })
      expect(section).toMatchObject({ status: 'unavailable', detail })
    }
  })

  test('a hung refresh ends at the shared deadline', async () => {
    const db = fakeDb({ google_accounts: [accountRow(CAL_SCOPE)], google_oauth_apps: [{ data: null, error: null }] })
    const { impl } = scriptedFetch([() => new Promise<Response>(() => {})])
    const section = await fetchOwnerCalendarSection(baseDeps(db, impl), { accountId: 'acc-1', date: '2026-09-05', timeoutMs: 25 })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'timeout' })
  })

  test('an endless token body stops at the 64KB cap, not at the deadline', async () => {
    const db = fakeDb({ google_accounts: [accountRow(CAL_SCOPE)], google_oauth_apps: [{ data: null, error: null }] })
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(8_192)) },
    }))
    const { impl } = scriptedFetch([endless])
    const started = Date.now()
    const section = await fetchOwnerCalendarSection(baseDeps(db, impl), { accountId: 'acc-1', date: '2026-09-05', timeoutMs: 5_000 })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'network' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('a hung google_accounts read ends at the deadline as an envelope, not an exception', async () => {
    const db = {
      ops: [] as string[],
      from() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = { select: () => chain, eq: () => chain, maybeSingle: () => new Promise(() => {}) }
        return chain
      },
    }
    const { impl, calls } = scriptedFetch([() => jsonResponse({})])
    const section = await fetchOwnerCalendarSection(
      { db, fetchImpl: impl, decrypt: async (s) => s, envApp: { id: 'x', secret: 'y' }, now: NOW },
      { accountId: 'acc-1', date: '2026-09-05', timeoutMs: 25 },
    )
    expect(section).toMatchObject({ status: 'unavailable', detail: 'timeout' })
    expect(calls).toHaveLength(0)
  })
})

// ── Client-side bounded calls (BriefingPanel's exact waits) ──────────────────────────────────────

describe('boundedBriefingCall helpers', async () => {
  const { callBoundedFunction, queryBounded } = await import('../src/lib/boundedBriefingCall')

  test('a hung invoke resolves not-reached at the deadline — busy state can always release', async () => {
    const started = Date.now()
    const result = await callBoundedFunction(() => new Promise(() => {}), 25)
    expect(result).toEqual({ ok: false, reached: false, payload: null })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('a hung ERROR-response body is under the same deadline as the invoke itself', async () => {
    const stalledBody = new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}) } }))
    const started = Date.now()
    const result = await callBoundedFunction(async () => ({ data: null, error: { context: stalledBody } }), 25)
    expect(result).toEqual({ ok: false, reached: false, payload: null })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('a parseable error body is reached (server answered); success passes through', async () => {
    const errorBody = new Response(JSON.stringify({ ok: false, error: 'save_outcome_unknown' }))
    const failed = await callBoundedFunction(async () => ({ data: null, error: { context: errorBody } }), 500)
    expect(failed.reached).toBe(true)
    expect(failed.payload.error).toBe('save_outcome_unknown')
    const success = await callBoundedFunction(async () => ({ data: { ok: true }, error: null }), 500)
    expect(success).toMatchObject({ ok: true, reached: true, payload: { ok: true } })
  })

  test('a hung channels query resolves to an explicit timedOut with the signal aborted', async () => {
    let observedSignal: AbortSignal | null = null
    const started = Date.now()
    const result = await queryBounded((signal) => { observedSignal = signal; return new Promise(() => {}) }, 25)
    expect(result).toEqual({ timedOut: true })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(observedSignal!.aborted).toBe(true)
  })

  test('a fast query is returned as-is', async () => {
    const result = await queryBounded(async () => ({ data: [{ id: 'ch1' }], error: null }), 500)
    expect(result).toEqual({ timedOut: false, result: { data: [{ id: 'ch1' }], error: null } })
  })
})

// ── Wrapper body read ────────────────────────────────────────────────────────────────────────────

describe('readRequestBodyBounded', () => {
  const request = (body: ReadableStream<Uint8Array> | null, contentLength?: string) => ({
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? contentLength ?? null : null) },
    body,
  })
  const streamOf = (...parts: string[]) => new ReadableStream<Uint8Array>({
    start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close() },
  })

  test('a normal chunked body decodes; a missing body is an empty text', async () => {
    expect(await readRequestBodyBounded(request(streamOf('{"action":', '"preview"}')))).toEqual({ ok: true, text: '{"action":"preview"}' })
    expect(await readRequestBodyBounded(request(null))).toEqual({ ok: true, text: '' })
  })

  test('a declared oversized content-length is refused WITHOUT reading the stream', async () => {
    let read = false
    const spyBody = { getReader: () => { read = true; throw new Error('must not read') } } as unknown as ReadableStream<Uint8Array>
    const result = await readRequestBodyBounded(request(spyBody, String(9_000)))
    expect(result).toEqual({ ok: false, reason: 'too_large' })
    expect(read).toBe(false)
  })

  test('an undeclared oversized stream is refused AT the cap, not after buffering it', async () => {
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(4_096)) } })
    const started = Date.now()
    const result = await readRequestBodyBounded(request(endless))
    expect(result).toEqual({ ok: false, reason: 'too_large' })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('a stalled sender fails after the read deadline, not never', async () => {
    const stalled = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}) } })
    const result = await readRequestBodyBounded(request(stalled), { timeoutMs: 25 })
    expect(result).toEqual({ ok: false, reason: 'read_failed' })
  })
})

// ── Panel offline contracts (the full gate does not render the panel — pin its invariants) ──────

describe('briefing panel offline contracts', () => {
  const panel = readFileSync(new URL('../src/components/settings/BriefingPanel.tsx', import.meta.url), 'utf8')
  const settingsPage = readFileSync(new URL('../src/pages/app/SettingsPage.tsx', import.meta.url), 'utf8')
  const i18n = readFileSync(new URL('../src/i18n/extra.ts', import.meta.url), 'utf8')

  test('the panel is mounted in the settings profile tab', () => {
    expect(settingsPage).toContain('<BriefingPanel />')
  })

  test('every panel wait goes through the bounded helpers — no raw invoke, no bare query', () => {
    expect(panel).toContain('callBoundedFunction(')
    expect(panel).toContain('queryBounded(')
    expect(panel).toContain('.abortSignal(signal)')
    expect((panel.match(/functions\.invoke\(/g) ?? []).length).toBe(1) // only inside the bounded wrapper
    expect(panel).toContain('busyRef.current')
  })

  test('role gating is server-driven and the recipient is never called verified', () => {
    expect(panel).toContain("'owner_required'")
    expect(panel).toContain('if (forbidden) return null')
    expect(panel).toContain('briefingRecipientConfigured')
    expect(panel).not.toMatch(/verified:\s*true/i)
  })

  test('delivery copy is truthful and flag-aware in all three languages', () => {
    // unverified: delivery starts only after verification
    expect(i18n).toContain('tasdiqlangach boshlanadi')
    expect(i18n).toContain('после подтверждения получателя')
    expect(i18n).toContain('after the recipient is verified')
    // the panel derives the line from SAVED flags: none / one / both — never a blanket claim
    for (const key of ['briefingDeliveryNone', 'briefingDeliveryActiveMorning', 'briefingDeliveryActiveEvening', 'briefingDeliveryActiveBoth', 'briefingDeliveryOff']) {
      expect(panel).toContain(key)
      expect((i18n.match(new RegExp(`"${key}"`, 'g')) ?? []).length).toBe(3) // present in uz+ru+en
    }
    expect(panel).toContain('savedMorning')
    expect(panel).toContain('savedEvening')
  })

  test('the verify flow is wired: action call, link invalidation on save, verified badge', () => {
    expect(panel).toContain("action: 'verify-recipient'")
    expect(panel).toContain('setVerifyInfo(null)') // cleared on save AND once verified
    expect(panel).toContain('briefingVerified')
    expect(panel).toContain('start_payload')
  })

  test('the unknown-save branch reconciles and reports the reload result honestly', () => {
    expect(panel).toContain("'save_outcome_unknown'")
    expect(panel).toContain('briefingSaveUnknownReloaded')
    expect(panel).toContain('briefingSaveUnknownReloadFailed')
  })
})

// ── Migration + deploy contracts (static text invariants) ────────────────────────────────────────

describe('daily briefing settings migration', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260905190000_daily_briefing_settings.sql', import.meta.url), 'utf8')
  const deploy = readFileSync(new URL('../deploy.ps1', import.meta.url), 'utf8')

  test('RLS is enabled, browser writes are revoked, reads are owner/is_admin only', () => {
    expect(sql).toContain('enable row level security')
    expect(sql).toContain('revoke all on table public.briefing_settings from public, anon')
    expect(sql).toContain('revoke insert, update, delete on table public.briefing_settings from authenticated')
    expect(sql).toContain('account_id = public.current_account_id()')
    expect(sql).toContain("u.role = 'owner' or u.is_admin = true")
  })

  test('the recipient binding is physically tenant-scoped and consent requires a destination', () => {
    expect(sql).toContain('foreign key (notify_channel_id) references public.channels (id)')
    expect(sql).toContain('briefing_settings_channel_account_guard')
    // the chat id is pending until verification discovers it — only the bot binding is required
    expect(sql).toContain('(not morning_enabled and not evening_enabled) or (notify_channel_id is not null)')
    expect(sql).toContain("notify_chat_id ~ '^-?[0-9]{1,20}$'")
    expect(sql).toContain('(weather_lat is null) = (weather_lon is null)')
    expect(sql).toContain('recipient_verified_at timestamptz')
  })

  test('the migration is additive Step 2a: no cron or delivery objects, and it is registered for deploy', () => {
    expect(sql).not.toMatch(/cron\.schedule|briefing_runs|net\.http_post/)
    expect(deploy).toContain('20260905190000_daily_briefing_settings.sql')
  })

  test('the function ships with the migration: manifest lists it as authenticated with JWT on', () => {
    // deployment iterates the manifest — a missing entry would deploy the migration and UI
    // while silently leaving the endpoint behind
    const manifest = JSON.parse(readFileSync(new URL('../supabase/functions/deployment-manifest.json', import.meta.url), 'utf8')) as { public: string[]; authenticated: string[] }
    expect(manifest.authenticated).toContain('daily-briefing')
    expect(manifest.public).not.toContain('daily-briefing')
    const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8')
    expect(config).toMatch(/\[functions\.daily-briefing\]\r?\nverify_jwt = true/)
  })
})

// ── HTTP handler ─────────────────────────────────────────────────────────────────────────────────

describe('handleDailyBriefing', () => {
  const OWNER = { data: { account_id: 'acc-1', role: 'owner', is_admin: false }, error: null }
  const GOOD_ACCOUNT = { data: { blocked: false }, error: null }
  const CBU_ROW = { Ccy: 'USD', Nominal: '1', Rate: '12650.44', Date: '05.09.2026' }

  function makeDeps(queues: Record<string, QueueResult[]>, overrides: Partial<DailyBriefingDeps> = {}) {
    const db = fakeDb(queues)
    const { impl } = scriptedFetch([() => jsonResponse([CBU_ROW])])
    const deps: DailyBriefingDeps = {
      admin: db,
      getUser: async () => ({ id: 'user-1' }),
      fetchImpl: impl,
      openWeatherKey: '',
      calendarSection: async () => readyCalendar,
      now: NOW,
      ...overrides,
    }
    return { deps, db }
  }
  const post = (body: unknown) => ({ method: 'POST', authorization: 'Bearer jwt', bodyText: JSON.stringify(body) })

  test('method, body size, JSON shape and action are screened first', async () => {
    const { deps } = makeDeps({})
    expect((await handleDailyBriefing(deps, { method: 'GET', authorization: '', bodyText: '' })).status).toBe(405)
    expect((await handleDailyBriefing(deps, { method: 'POST', authorization: '', bodyText: 'x'.repeat(9_000) })).status).toBe(413)
    expect((await handleDailyBriefing(deps, { method: 'POST', authorization: '', bodyText: '{broken' })).status).toBe(400)
    expect((await handleDailyBriefing(deps, { method: 'POST', authorization: '', bodyText: '[1]' })).status).toBe(400)
    expect((await handleDailyBriefing(deps, post({ action: 'run' }))).status).toBe(400) // no cron action exists in 2a
  })

  test('auth chain: 401 without user, 503 on lookup failure (never 403), explicit role gate', async () => {
    const noUser = makeDeps({}, { getUser: async () => null })
    expect((await handleDailyBriefing(noUser.deps, post({ action: 'settings-get' }))).status).toBe(401)
    const throwing = makeDeps({}, { getUser: async () => { throw new Error('idp down') } })
    expect((await handleDailyBriefing(throwing.deps, post({ action: 'settings-get' }))).status).toBe(401)

    const dbError = makeDeps({ users: [{ data: null, error: { code: '57014' } }] })
    const failed = await handleDailyBriefing(dbError.deps, post({ action: 'settings-get' }))
    expect(failed.status).toBe(503) // "could not check" must never read as "no account"
    expect(failed.body.error).toBe('profile_unavailable')

    const noAccount = makeDeps({ users: [{ data: null, error: null }] })
    expect((await handleDailyBriefing(noAccount.deps, post({ action: 'settings-get' }))).body.error).toBe('no_account')

    const operator = makeDeps({ users: [{ data: { account_id: 'acc-1', role: 'operator', is_admin: false }, error: null }] })
    expect((await handleDailyBriefing(operator.deps, post({ action: 'settings-get' }))).body.error).toBe('owner_required')

    const adminOperator = makeDeps({
      users: [{ data: { account_id: 'acc-1', role: 'operator', is_admin: true }, error: null }],
      accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }],
    })
    expect((await handleDailyBriefing(adminOperator.deps, post({ action: 'settings-get' }))).status).toBe(200)
  })

  test('blocked-account denial is explicit and a MISSING accounts row fails closed', async () => {
    const blocked = makeDeps({ users: [OWNER], accounts: [{ data: { blocked: true }, error: null }] })
    expect((await handleDailyBriefing(blocked.deps, post({ action: 'settings-get' }))).body.error).toBe('blocked')
    const missing = makeDeps({ users: [OWNER], accounts: [{ data: null, error: null }] })
    expect((await handleDailyBriefing(missing.deps, post({ action: 'settings-get' }))).body.error).toBe('no_account')
    const lookupFailed = makeDeps({ users: [OWNER], accounts: [{ data: null, error: { code: '57014' } }] })
    expect((await handleDailyBriefing(lookupFailed.deps, post({ action: 'settings-get' }))).status).toBe(503)
  })

  test('settings-get returns explicit defaults with a not-configured, unverified recipient', async () => {
    const { deps } = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }] })
    const result = await handleDailyBriefing(deps, post({ action: 'settings-get' }))
    expect(result.body.settings).toMatchObject({
      morning_enabled: false, evening_enabled: false,
      recipient_status: 'not_configured', recipient_verified: false,
    })
  })

  test('settings-set validation refuses every malformed shape without touching the table', async () => {
    const channel = '11111111-2222-4333-8444-555555555555'
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'settings-set', morning_enabled: 'yes', evening_enabled: false }, 'invalid_settings'],
      [{ action: 'settings-set', morning_enabled: false, evening_enabled: false, weather_lat: 41.3 }, 'invalid_coordinates'],
      [{ action: 'settings-set', morning_enabled: false, evening_enabled: false, weather_lat: 141.3, weather_lon: 69.2 }, 'invalid_coordinates'],
      [{ action: 'settings-set', morning_enabled: true, evening_enabled: false }, 'recipient_required'],
      [{ action: 'settings-set', morning_enabled: true, evening_enabled: false, notify_channel_id: channel, notify_chat_id: 'not-a-chat' }, 'invalid_recipient'],
      [{ action: 'settings-set', morning_enabled: true, evening_enabled: false, notify_channel_id: 'not-a-uuid', notify_chat_id: '12345' }, 'invalid_recipient'],
      [{ action: 'settings-set', morning_enabled: false, evening_enabled: false, notify_chat_id: '12345' }, 'invalid_recipient'], // a chat without a bot
    ]
    for (const [body, error] of cases) {
      const { deps, db } = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT] })
      const result = await handleDailyBriefing(deps, post(body))
      expect(result.status).toBe(400)
      expect(result.body.error).toBe(error)
      expect(db.rpcCalls.filter((call) => call.name === 'briefing_save_settings')).toHaveLength(0)
    }
  })

  test('the bound channel must exist on THIS account and be Telegram — never a fallback bot', async () => {
    const channel = '11111111-2222-4333-8444-555555555555'
    const body = { action: 'settings-set', morning_enabled: true, evening_enabled: false, notify_channel_id: channel, notify_chat_id: '12345' }
    const notFound = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT], channels: [{ data: null, error: null }] })
    expect((await handleDailyBriefing(notFound.deps, post(body))).body.error).toBe('channel_not_found')
    const wrongType = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT], channels: [{ data: { id: channel, type: 'widget' }, error: null }] })
    expect((await handleDailyBriefing(wrongType.deps, post(body))).body.error).toBe('channel_not_telegram')
    const lookupFailed = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT], channels: [{ data: null, error: { code: '57014' } }] })
    expect((await handleDailyBriefing(lookupFailed.deps, post(body))).status).toBe(503)
  })

  test('a valid save goes through the atomic RPC (revision bump + claim reset live in SQL)', async () => {
    const channel = '11111111-2222-4333-8444-555555555555'
    const savedRow = {
      account_id: 'acc-1', morning_enabled: true, evening_enabled: true,
      weather_lat: 41.311, weather_lon: 69.28, notify_channel_id: channel, notify_chat_id: '12345',
      recipient_verified_at: null, settings_revision: 4, current_claim_id: null,
    }
    const { deps, db } = makeDeps({
      users: [OWNER], accounts: [GOOD_ACCOUNT],
      channels: [{ data: { id: channel, type: 'telegram' }, error: null }],
      'rpc:briefing_save_settings': [{ data: savedRow, error: null }],
    })
    const result = await handleDailyBriefing(deps, post({
      action: 'settings-set', morning_enabled: true, evening_enabled: true,
      weather_lat: 41.311, weather_lon: 69.28, notify_channel_id: channel, notify_chat_id: ' 12345 ',
    }))
    expect(result.status).toBe(200)
    expect(db.upserts).toHaveLength(0) // no direct table write can express the revision bump
    const call = db.rpcCalls.find((c) => c.name === 'briefing_save_settings')
    expect(call?.args).toMatchObject({ p_account: 'acc-1', p_chat: '12345', p_updated_by: 'user-1', p_morning: true })
    expect(result.body.settings).toMatchObject({ recipient_status: 'configured', recipient_verified: false })
  })

  test('pending binding: enabling with a bot but NO chat id saves — verification discovers it', async () => {
    const channel = '11111111-2222-4333-8444-555555555555'
    const { deps, db } = makeDeps({
      users: [OWNER], accounts: [GOOD_ACCOUNT],
      channels: [{ data: { id: channel, type: 'telegram' }, error: null }],
      'rpc:briefing_save_settings': [{ data: { account_id: 'acc-1', morning_enabled: true, notify_channel_id: channel, notify_chat_id: null, recipient_verified_at: null }, error: null }],
    })
    const result = await handleDailyBriefing(deps, post({ action: 'settings-set', morning_enabled: true, evening_enabled: false, notify_channel_id: channel }))
    expect(result.status).toBe(200)
    expect(db.rpcCalls.find((c) => c.name === 'briefing_save_settings')?.args).toMatchObject({ p_channel: channel, p_chat: null })
    expect(result.body.settings).toMatchObject({ recipient_status: 'configured', recipient_verified: false })
  })

  test('settings-get reports the delivery switch truthfully', async () => {
    const on = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }] })
    expect((await handleDailyBriefing(on.deps, post({ action: 'settings-get' }))).body.delivery).toEqual({ implemented: true, enabled: true })
    const off = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }] }, { deliverySwitch: 'off' })
    expect((await handleDailyBriefing(off.deps, post({ action: 'settings-get' }))).body.delivery).toEqual({ implemented: true, enabled: false })
  })

  test('verify-recipient issues a hashed claim and never returns a verified recipient', async () => {
    const channel = '11111111-2222-4333-8444-555555555555'
    const noBinding = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }] })
    expect((await handleDailyBriefing(noBinding.deps, post({ action: 'verify-recipient' }))).body.error).toBe('recipient_required')

    const { deps, db } = makeDeps(
      {
        users: [OWNER], accounts: [GOOD_ACCOUNT],
        briefing_settings: [{ data: { notify_channel_id: channel }, error: null }],
        'rpc:briefing_issue_claim': [{ data: { ok: true }, error: null }],
      },
      { getBotUsername: async (_channelId, accountId) => (accountId === 'acc-1' ? 'NemoBriefingBot' : null) },
    )
    const result = await handleDailyBriefing(deps, post({ action: 'verify-recipient' }))
    expect(result.status).toBe(200)
    const body = result.body as { start_payload: string; deep_link: string; recipient_verified: boolean }
    expect(body.start_payload).toMatch(/^brf_[0-9a-f]{48}$/)
    expect(body.deep_link).toBe(`https://t.me/NemoBriefingBot?start=${body.start_payload}`)
    expect(body.recipient_verified).toBe(false)
    const issue = db.rpcCalls.find((c) => c.name === 'briefing_issue_claim')
    expect(String(issue?.args.p_token_hash)).toMatch(/^[0-9a-f]{64}$/) // only the hash reaches the DB
    expect(JSON.stringify(issue?.args)).not.toContain(body.start_payload.slice(4))

    const refused = makeDeps({
      users: [OWNER], accounts: [GOOD_ACCOUNT],
      briefing_settings: [{ data: { notify_channel_id: channel }, error: null }],
      'rpc:briefing_issue_claim': [{ data: { ok: false, reason: 'blocked' }, error: null }],
    })
    expect((await handleDailyBriefing(refused.deps, post({ action: 'verify-recipient' }))).body.error).toBe('blocked')
  })

  test('morning preview composes explicit envelopes and leaks no credentials', async () => {
    const { deps } = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }] })
    const result = await handleDailyBriefing(deps, post({ action: 'preview', kind: 'morning', lang: 'ru' }))
    expect(result.status).toBe(200)
    const body = result.body as { text: string; sections: { weather: { detail?: string }; news: { status: string } } }
    expect(body.sections.weather.detail).toBe('no_coordinates')
    expect(body.sections.news.status).toBe('unavailable')
    expect(body.text).toContain('Курс USD (ЦБ РУз)')
    expect(JSON.stringify(result.body)).not.toContain('Bearer')
    const bad = await handleDailyBriefing(makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT] }).deps, post({ action: 'preview', kind: 'nightly' }))
    expect(bad.body.error).toBe('unknown_kind')
  })

  test("morning preview quotes yesterday's outcome — exact prior Tashkent date, tri-state", async () => {
    const quoted = makeDeps({
      users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }],
      briefing_outcomes: [{ data: { run_date: '2026-09-04', text: 'Сдали отчёт' }, error: null }],
    })
    const result = await handleDailyBriefing(quoted.deps, post({ action: 'preview', kind: 'morning', lang: 'ru' }))
    expect((result.body as { text: string }).text).toContain('«Сдали отчёт» (2026-09-04)')
    expect(quoted.db.ops.filter((op) => op === 'briefing_outcomes.eq')).toHaveLength(2) // account AND run_date

    const none = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }], briefing_outcomes: [{ data: null, error: null }] })
    expect(((await handleDailyBriefing(none.deps, post({ action: 'preview', kind: 'morning', lang: 'ru' }))).body as { text: string }).text).not.toContain('🗒')

    const failed = makeDeps({ users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }], briefing_outcomes: [{ data: null, error: { code: '57014' } }] })
    const failedText = ((await handleDailyBriefing(failed.deps, post({ action: 'preview', kind: 'morning', lang: 'ru' }))).body as { text: string }).text
    expect(failedText).toContain('🗒 Ваш вчерашний итог: недоступно')
  })

  test('yesterday helper: exact prior date incl. YEAR rollover; missing vs DB error distinguished', async () => {
    const eqArgs: unknown[][] = []
    const mk = (result: QueueResult) => ({
      from: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = { select: () => chain, eq: (...args: unknown[]) => { eqArgs.push(args); return chain }, maybeSingle: () => Promise.resolve(result) }
        return chain
      },
    })
    const rollover = await buildYesterdayOutcome(mk({ data: { run_date: '2026-12-31', text: 'итог года' }, error: null }), 'acc-1', '2027-01-01')
    expect(rollover).toEqual({ status: 'ready', runDate: '2026-12-31', text: 'итог года' })
    expect(eqArgs).toContainEqual(['run_date', '2026-12-31']) // Jan 1 asks for Dec 31, account-scoped
    expect(eqArgs).toContainEqual(['account_id', 'acc-1'])
    expect(await buildYesterdayOutcome(mk({ data: null, error: null }), 'acc-1', '2026-09-05')).toBeNull() // missing = silence
    expect(await buildYesterdayOutcome(mk({ data: null, error: { code: '57014' } }), 'acc-1', '2026-09-05')).toEqual({ status: 'unavailable' })
  })

  test('a hung outcomes read cannot outlive the request deadline', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin: any = {
      rpc: () => Promise.resolve({ data: null, error: null }),
      from(table: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {}
        for (const method of ['select', 'eq', 'neq', 'gte', 'lt', 'not', 'order', 'limit', 'or', 'is']) chain[method] = () => chain
        chain.maybeSingle = () => table === 'briefing_outcomes'
          ? new Promise(() => {}) // hung
          : Promise.resolve(table === 'users' ? OWNER : table === 'accounts' ? GOOD_ACCOUNT : { data: null, error: null })
        return chain
      },
    }
    const { deps } = makeDeps({}, { admin, requestTimeoutMs: 40 })
    const started = Date.now()
    const result = await handleDailyBriefing(deps, post({ action: 'preview', kind: 'morning' }))
    expect(result).toEqual({ status: 503, body: { ok: false, error: 'timeout' } })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('independent morning sources run in parallel — one budget, not the sum', async () => {
    const routed: FetchLike = async (url, init) => {
      await delay(40)
      if (url.includes('cbu.uz')) return jsonResponse([CBU_ROW])
      if (url.includes('openweathermap')) return jsonResponse({ main: { temp: 21 }, dt: Math.floor(NOW().getTime() / 1000) - 60 })
      throw Object.assign(new Error('unexpected host'), { init })
    }
    const { deps } = makeDeps(
      {
        users: [OWNER], accounts: [GOOD_ACCOUNT],
        briefing_settings: [{ data: { weather_lat: 41.311, weather_lon: 69.28 }, error: null }],
      },
      { fetchImpl: routed, openWeatherKey: 'K', calendarSection: async () => { await delay(40); return readyCalendar } },
    )
    const started = Date.now()
    const result = await handleDailyBriefing(deps, post({ action: 'preview', kind: 'morning' }))
    expect(result.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(110) // three sequential 40ms waits would exceed this
    expect(JSON.stringify(result.body)).not.toContain('"K"')
  })

  test('the whole request runs under one deadline: a hung dependency yields a fixed envelope', async () => {
    const { deps } = makeDeps(
      { users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }] },
      { calendarSection: () => new Promise<CalendarSection>(() => {}), requestTimeoutMs: 30 },
    )
    const result = await handleDailyBriefing(deps, post({ action: 'preview', kind: 'morning' }))
    expect(result).toEqual({ status: 503, body: { ok: false, error: 'timeout' } })
  })

  test('a timeout during auth never lets LATER db calls or writes happen', async () => {
    const { deps, db } = makeDeps(
      { users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }] },
      { getUser: async () => { await delay(30); return { id: 'user-1' } }, requestTimeoutMs: 5 },
    )
    const result = await handleDailyBriefing(deps, post({ action: 'settings-set', morning_enabled: false, evening_enabled: false }))
    expect(result).toEqual({ status: 503, body: { ok: false, error: 'timeout' } })
    await delay(60) // give the abandoned continuation every chance to (incorrectly) keep going
    expect(db.upserts).toHaveLength(0)
    expect(db.ops).toHaveLength(0) // not even a read is dispatched after the deadline
  })

  test('a timeout while the write is IN FLIGHT reports save_outcome_unknown, never "not saved"', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin: any = {
      // the consent write is the briefing_save_settings RPC: dispatched, never settles
      rpc: () => ({ then: () => { /* pending forever */ } }),
      from(table: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {}
        for (const method of ['select', 'eq', 'neq', 'gte', 'lt', 'not', 'order', 'limit']) chain[method] = () => chain
        chain.maybeSingle = () => Promise.resolve(
          table === 'users' ? OWNER : table === 'accounts' ? GOOD_ACCOUNT : { data: null, error: null },
        )
        return chain
      },
    }
    const { deps } = makeDeps({}, { admin, requestTimeoutMs: 40 })
    const result = await handleDailyBriefing(deps, post({ action: 'settings-set', morning_enabled: false, evening_enabled: false }))
    expect(result.status).toBe(503)
    expect(result.body.error).toBe('save_outcome_unknown')
    expect(result.body.hint).toBe('reload_settings')
  })

  test('an escaped rejection becomes a fixed internal envelope, never an exception', async () => {
    const { deps } = makeDeps({}, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      admin: { from: () => { throw new Error('driver exploded') } } as any,
    })
    const result = await handleDailyBriefing(deps, post({ action: 'settings-get' }))
    expect(result).toEqual({ status: 503, body: { ok: false, error: 'internal' } })
  })

  test('evening preview: completed_at window, Tashkent due labels, honest remainder and question', async () => {
    const { deps, db } = makeDeps({
      users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }],
      tasks: [
        { count: 2, error: null }, // done today (completed_at within the Tashkent day)
        { count: 7, error: null }, // open
        { count: 1, error: null }, // overdue (due_at OR date-only deadline past its Tashkent day)
        { data: [{ title: 'Оплатить аренду', due_at: '2026-09-05T20:30:00Z' }], error: null },
        { data: [{ title: 'Сдать отчёт', deadline: '2026-09-05' }], error: null }, // date-only fallback
      ],
    })
    const result = await handleDailyBriefing(deps, post({ action: 'preview', kind: 'evening', lang: 'ru' }))
    expect(result.status).toBe(200)
    const text = (result.body as { text: string }).text
    expect(text).toContain('Выполнено сегодня: 2')
    // 20:30Z is 01:30 NEXT day in Tashkent — the label must say 2026-09-06, not the UTC slice
    expect(text).toContain('2026-09-06')
    // the date-only deadline task appears with its own (Tashkent-local) date, sorted first
    expect(text).toContain('Сдать отчёт — срок 2026-09-05')
    expect(text.indexOf('Сдать отчёт')).toBeLessThan(text.indexOf('Оплатить аренду'))
    expect(text).toContain('…и ещё 5') // open 7 − 2 shown
    expect(text.endsWith('Как прошёл ваш день? Напишите коротко: что удалось и что переносим.')).toBe(true)
    expect(db.ops.filter((op) => op === 'tasks.gte')).toHaveLength(1) // completed_at lower bound
    // overdue must include the deadline fallback with TASHKENT end-of-day semantics
    const orOp = db.ops.find((op) => op.startsWith('tasks.or:'))
    expect(orOp).toContain('deadline.lt.2026-09-05')
    expect(orOp).toContain('due_at.is.null')
  })

  test('evening preview: a null count or DB error is unavailable — never three zeros', async () => {
    for (const tasks of [
      [{ count: null, error: null }, { count: 7, error: null }, { count: 1, error: null }, { data: [], error: null }],
      [{ count: 2, error: null }, { count: 7, error: null }, { count: 1, error: null }, { data: null, error: { code: '42703' } }],
    ]) {
      const { deps } = makeDeps({
        users: [OWNER], accounts: [GOOD_ACCOUNT], briefing_settings: [{ data: null, error: null }],
        tasks: tasks as QueueResult[],
      })
      const result = await handleDailyBriefing(deps, post({ action: 'preview', kind: 'evening', lang: 'ru' }))
      expect(result.status).toBe(200)
      const text = (result.body as { text: string }).text
      expect(text).toContain('Задачи: недоступно (nemo-db')
      expect(text).not.toContain(': 0')
      expect(text.endsWith('Как прошёл ваш день? Напишите коротко: что удалось и что переносим.')).toBe(true)
    }
  })
})
