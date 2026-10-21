// Reminders endpoint handler + worker glue — offline tests (fake db, fake sender, no network).
//   • the margin-style auth chain: DB failures 503, authz failures 403, blocked refused;
//   • STRICT save shapes: a malformed schedule_id can never become "create", coerced numbers
//     and stringly booleans are refused before any RPC; the creation cap refuses visibly;
//   • the authenticated account is the ONLY tenant source (a forged account_id is ignored) and
//     the SERVER clock is the only time source (a client p_now is never read);
//   • worker glue: bounded planning (hung/thrown RPC answers plan_failed within its budget),
//     kill-switch default OFF, telegram-typed tenant-scoped token read, external-action guard.
import { describe, expect, test } from 'vitest'
import { handleReminders, MAX_REMINDER_SCHEDULES, type ReminderHandlerDeps } from '../supabase/functions/_shared/reminderHandler.ts'
import { createTelegramDocumentSender, runReminderWorkerKind } from '../supabase/functions/_shared/reminderWorker.ts'

type QueueResult = { data?: unknown; error?: unknown; sideEffect?: () => void } | 'HANG'

function fakeAdmin(queue: Record<string, QueueResult[]>, rpcResult: QueueResult = { data: { ok: true, schedule: { id: 's1' } } }) {
  const ops: string[] = []
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const next = (table: string): QueueResult => {
    const q = queue[table]
    return q?.length ? q.shift()! : { data: null, error: null }
  }
  const resolve = (value: QueueResult) => {
    if (value === 'HANG') return new Promise(() => {})
    value.sideEffect?.() // e.g. advance the injected clock exactly as this read settles
    return Promise.resolve(value)
  }
  return {
    ops,
    rpcCalls,
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      return resolve(rpcResult)
    },
    from(table: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      for (const method of ['select', 'eq', 'order', 'limit']) chain[method] = () => chain
      chain.range = (from: number, to: number) => { ops.push(`${table}.range:${from}:${to}`); return chain }
      chain.maybeSingle = () => { ops.push(`${table}.maybeSingle`); return resolve(next(table)) }
      chain.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
        ops.push(`${table}.list`)
        return resolve(next(table)).then(onOk, onErr)
      }
      return chain
    },
  }
}

const OK_PROFILE: QueueResult = { data: { account_id: 'acc-1', role: 'owner', is_admin: false }, error: null }
const OK_ACCOUNT: QueueResult = { data: { blocked: false }, error: null }
const SERVER_NOW = 1_790_000_000_000

function makeDeps(overrides: { users?: QueueResult[]; accounts?: QueueResult[]; tables?: Record<string, QueueResult[]>; rpcResult?: QueueResult; getUser?: ReminderHandlerDeps['getUser']; now?: () => number } = {}) {
  const admin = fakeAdmin({
    users: overrides.users ?? [OK_PROFILE],
    accounts: overrides.accounts ?? [OK_ACCOUNT],
    ...(overrides.tables ?? {}),
  }, overrides.rpcResult)
  const deps: ReminderHandlerDeps = {
    admin,
    getUser: overrides.getUser ?? (async () => ({ id: 'u1' })),
    now: overrides.now ?? (() => SERVER_NOW),
  }
  return { deps, admin }
}

const post = (body: unknown, deadlineAt?: number) =>
  ({ method: 'POST', authorization: 'Bearer jwt', bodyText: JSON.stringify(body), deadlineAt })

const VALID_SAVE = { action: 'save', title: 'Отчёт', day_of_month: 30, send_minute: 540, enabled: false }

describe('reminders auth chain', () => {
  test('non-POST 405; missing user 401; DB failures 503; authz failures 403', async () => {
    const { deps } = makeDeps()
    expect((await handleReminders(deps, { method: 'GET', authorization: '', bodyText: '' })).status).toBe(405)
    const anon = makeDeps({ getUser: async () => null })
    expect((await handleReminders(anon.deps, post({ action: 'list' }))).status).toBe(401)
    const cases: Array<[QueueResult[], QueueResult[], number, string]> = [
      [[{ data: null, error: new Error('db') }], [OK_ACCOUNT], 503, 'profile_unavailable'],
      [[{ data: null, error: null }], [OK_ACCOUNT], 403, 'no_account'],
      [[{ data: { account_id: 'acc-1', role: 'operator', is_admin: false }, error: null }], [OK_ACCOUNT], 403, 'owner_required'],
      [[OK_PROFILE], [{ data: null, error: new Error('db') }], 503, 'account_unavailable'],
      [[OK_PROFILE], [{ data: { blocked: true }, error: null }], 403, 'blocked'],
    ]
    for (const [users, accounts, status, error] of cases) {
      const { deps: d } = makeDeps({ users, accounts })
      expect(await handleReminders(d, post({ action: 'list' }))).toMatchObject({ status, body: { error } })
    }
  })

  test('hung auth answers 503 timeout at the deadline — and no RPC dispatches afterwards', async () => {
    const { deps, admin } = makeDeps({ users: ['HANG'] })
    const started = Date.now()
    const result = await handleReminders(deps, post(VALID_SAVE, Date.now() + 120))
    expect(result).toMatchObject({ status: 503, body: { error: 'timeout' } })
    expect(Date.now() - started).toBeLessThan(5_000)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(admin.rpcCalls).toHaveLength(0)
  })
})

describe('reminders save — strict shapes and tenant/time sources', () => {
  test('a malformed schedule_id is refused, NEVER coerced into "create a new schedule"', async () => {
    for (const bad of [123, 'not-a-uuid', { id: 'x' }, true, '']) {
      const { deps, admin } = makeDeps()
      const result = await handleReminders(deps, post({ ...VALID_SAVE, schedule_id: bad }))
      expect(result).toMatchObject({ status: 400, body: { error: 'invalid_schedule_id' } })
      expect(admin.rpcCalls).toHaveLength(0)
    }
    const { deps, admin } = makeDeps()
    const uuid = '3aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    expect((await handleReminders(deps, post({ ...VALID_SAVE, schedule_id: uuid }))).status).toBe(200)
    expect(admin.rpcCalls[0].args.p_schedule_id).toBe(uuid)
  })

  test('coerced numbers, stringly booleans and array bodies are refused before any RPC', async () => {
    const bads: Array<Record<string, unknown>> = [
      { ...VALID_SAVE, day_of_month: null }, { ...VALID_SAVE, day_of_month: '30' }, { ...VALID_SAVE, day_of_month: 5.5 },
      { ...VALID_SAVE, send_minute: '' }, { ...VALID_SAVE, enabled: 'true' }, { ...VALID_SAVE, title: 7 },
    ]
    for (const body of bads) {
      const { deps, admin } = makeDeps()
      expect((await handleReminders(deps, post(body))).status).toBe(400)
      expect(admin.rpcCalls).toHaveLength(0)
    }
    const arr = makeDeps()
    expect(await handleReminders(arr.deps, post([VALID_SAVE]))).toMatchObject({ status: 400, body: { error: 'bad_json' } })
  })

  test('the authenticated account and the SERVER clock are the only sources — forged fields are ignored', async () => {
    const { deps, admin } = makeDeps()
    const result = await handleReminders(deps, post({
      ...VALID_SAVE, account_id: 'acc-EVIL', p_account_id: 'acc-EVIL', p_now: '1999-01-01T00:00:00Z', now: '1999-01-01',
    }))
    expect(result.status).toBe(200)
    expect(admin.rpcCalls[0].args).toMatchObject({
      p_account_id: 'acc-1',
      p_now: new Date(SERVER_NOW).toISOString(),
    })
  })

  test('the ATOMIC in-RPC creation cap refusal passes through visibly (no handler precheck race)', async () => {
    const { deps, admin } = makeDeps({ rpcResult: { data: { ok: false, reason: 'schedule_limit' } } })
    expect(await handleReminders(deps, post(VALID_SAVE)))
      .toMatchObject({ status: 200, body: { ok: false, error: 'schedule_limit' } })
    expect(admin.rpcCalls).toHaveLength(1) // the cap is the RPC's invariant, not a client count
    expect(MAX_REMINDER_SCHEDULES).toBe(30) // UI copy constant matches the SQL cap
  })

  test('kind and report_currency shapes are strict; both reach the RPC verbatim', async () => {
    for (const body of [{ ...VALID_SAVE, kind: 'weird' }, { ...VALID_SAVE, kind: 5 }, { ...VALID_SAVE, report_currency: 7 }]) {
      const { deps, admin } = makeDeps()
      expect((await handleReminders(deps, post(body))).status).toBe(400)
      expect(admin.rpcCalls).toHaveLength(0)
    }
    const { deps, admin } = makeDeps()
    expect((await handleReminders(deps, post({ ...VALID_SAVE, kind: 'product_report', report_currency: 'USD' }))).status).toBe(200)
    expect(admin.rpcCalls[0].args).toMatchObject({ p_kind: 'product_report', p_report_currency: 'USD' })
    const plain = makeDeps()
    await handleReminders(plain.deps, post(VALID_SAVE))
    expect(plain.admin.rpcCalls[0].args).toMatchObject({ p_kind: 'reminder', p_report_currency: null })
  })

  test('set-period validates sha and CALENDAR month before any RPC, then passes through', async () => {
    for (const body of [
      { action: 'set-period', file_sha256: '../evil', period_month: '2026-04' },
      { action: 'set-period', file_sha256: 'a'.repeat(64), period_month: '2026-13' },
      { action: 'set-period', file_sha256: 'a'.repeat(64), period_month: '2026-4' },
    ]) {
      const { deps, admin } = makeDeps()
      expect((await handleReminders(deps, post(body))).status).toBe(400)
      expect(admin.rpcCalls).toHaveLength(0)
    }
    const refused = makeDeps({ rpcResult: { data: { ok: false, reason: 'not_found' } } })
    expect(await handleReminders(refused.deps, post({ action: 'set-period', file_sha256: 'a'.repeat(64), period_month: '2026-04' })))
      .toMatchObject({ status: 200, body: { ok: false, error: 'not_found' } })
    const ok = makeDeps({ rpcResult: { data: { ok: true, source: { period_month: '2026-04' } } } })
    const result = await handleReminders(ok.deps, post({ action: 'set-period', file_sha256: 'a'.repeat(64), period_month: '2026-04' }))
    expect(result).toMatchObject({ status: 200, body: { ok: true, source: { period_month: '2026-04' } } })
    expect(ok.admin.rpcCalls[0]).toMatchObject({ name: 'margin_registry_set_period', args: { p_account_id: 'acc-1', p_period_month: '2026-04' } })
  })

  test('RPC refusals pass through verbatim; an RPC error is a 503', async () => {
    const refused = makeDeps({ rpcResult: { data: { ok: false, reason: 'recipient_not_verified' } } })
    expect(await handleReminders(refused.deps, post(VALID_SAVE)))
      .toMatchObject({ status: 200, body: { ok: false, error: 'recipient_not_verified' } })
    const broken = makeDeps({ rpcResult: { data: null, error: new Error('db') } })
    expect(await handleReminders(broken.deps, post(VALID_SAVE))).toMatchObject({ status: 503, body: { error: 'save_failed' } })
  })
})

describe('reminders list', () => {
  test('happy path returns schedules; auxiliary reads fail SOFT to null', async () => {
    const { deps } = makeDeps({
      tables: {
        reminder_schedules: [{ data: [{ id: 's1', title: 'Отчёт' }], error: null }],
        reminder_occurrences: [{ data: null, error: new Error('db') }],
        briefing_settings: [{ data: { recipient_verified_at: '2026-09-01T00:00:00Z', notify_channel_id: 'ch-1' }, error: null }],
        margin_upload_registry: [{ data: [{ file_sha256: 'a'.repeat(64), file_name: 'sales.xlsx', period_month: '2026-08' }], error: null }],
      },
    })
    const result = await handleReminders(deps, post({ action: 'list' }))
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      schedules: [{ id: 's1', title: 'Отчёт' }],
      occurrences: null, // failed read hides the block, never "no history"
      recipient: { verified: true, channel_bound: true },
      sources: [{ file_name: 'sales.xlsx', period_month: '2026-08' }],
    })
    const brokenMain = makeDeps({ tables: { reminder_schedules: [{ data: null, error: new Error('db') }] } })
    expect((await handleReminders(brokenMain.deps, post({ action: 'list' }))).status).toBe(503)
  })

  test('the source picker PAGINATES: older files stay reachable, bad pages refuse, errors are hard', async () => {
    const eleven = Array.from({ length: 11 }, (_v, index) => ({ file_sha256: String(index).padStart(64, '0'), file_name: `f${index}.xlsx` }))
    const listed = makeDeps({ tables: { margin_upload_registry: [{ data: eleven, error: null }] } })
    const listBody = (await handleReminders(listed.deps, post({ action: 'list' }))).body
    expect((listBody.sources as unknown[]).length).toBe(10) // page size, the 11th row only answers has_more
    expect(listBody.sources_has_more).toBe(true)

    const paged = makeDeps({ tables: { margin_upload_registry: [{ data: eleven, error: null }] } })
    const page = await handleReminders(paged.deps, post({ action: 'sources', page: 2 }))
    expect(page.body).toMatchObject({ ok: true, page: 2, has_more: true })
    expect((page.body.sources as unknown[]).length).toBe(10)
    expect(paged.admin.ops).toContain('margin_upload_registry.range:20:30') // a REAL deeper page

    for (const bad of [-1, 1.5, '1', 51, undefined]) {
      const { deps, admin } = makeDeps()
      expect((await handleReminders(deps, post({ action: 'sources', page: bad }))).status).toBe(400)
      expect(admin.ops.filter((op) => op.startsWith('margin_upload_registry'))).toEqual([])
    }
    const broken = makeDeps({ tables: { margin_upload_registry: [{ data: null, error: new Error('db') }] } })
    expect((await handleReminders(broken.deps, post({ action: 'sources', page: 0 }))).status).toBe(503)

    // end of the bounded range is EXPLICIT: never has_more=true and then a refusal
    const capped = makeDeps({ tables: { margin_upload_registry: [{ data: eleven, error: null }] } })
    const lastPage = await handleReminders(capped.deps, post({ action: 'sources', page: 50 }))
    expect(lastPage.body).toMatchObject({ ok: true, has_more: false, truncated: true })
  })

  test('the list stops at the CLOCK between reads even when the timer never fired', async () => {
    const nowRef = { value: SERVER_NOW }
    const { deps, admin } = makeDeps({
      now: () => nowRef.value,
      // the schedules read settles fine — but the clock has crossed the deadline as it does
      tables: { reminder_schedules: [{ data: [], error: null, sideEffect: () => { nowRef.value += 60_000 } }] },
    })
    const result = await handleReminders(deps, post({ action: 'list' }, nowRef.value + 20_000))
    expect(result).toMatchObject({ status: 503, body: { error: 'timeout' } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    // the NEXT read never even started
    expect(admin.ops.filter((op) => op.startsWith('reminder_occurrences'))).toEqual([])
  })
})

// ── worker glue ──────────────────────────────────────────────────────────────────────────────────

const CLAIM_ROW = {
  id: 'occ-1', account_id: 'acc-1', schedule_id: 'sch-1', due_date: '2026-09-30',
  due_at: '2026-09-30T04:00:00Z', lease_token: 'lease-1', attempt_count: 1, title: 'Отчёт',
}

function fakeWorkerAdmin(script: { plan?: QueueResult; claim?: unknown[] }) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const eqs: Array<[string, unknown]> = []
  return {
    rpcCalls,
    eqs,
    admin: {
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args })
        if (name === 'reminder_plan_occurrences') {
          return script.plan === 'HANG' ? new Promise(() => {}) : Promise.resolve(script.plan ?? { data: 2 })
        }
        if (name === 'reminder_recover') return Promise.resolve({ data: 0 })
        if (name === 'reminder_claim_due') return Promise.resolve({ data: script.claim ?? [] })
        if (name === 'reminder_mark_dispatch') return Promise.resolve({ data: { ok: true, channel_id: 'ch-1', chat_id: '555' } })
        if (name === 'reminder_finish') return Promise.resolve({ data: true })
        return Promise.resolve({ error: new Error('unexpected') })
      },
      from(_table: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {
          select: () => chain,
          eq: (column: string, value: unknown) => { eqs.push([column, value]); return chain },
          maybeSingle: async () => ({ data: { credentials: { bot_token: 'tok' } } }),
        }
        return chain
      },
    },
  }
}

describe('createTelegramDocumentSender', () => {
  const BYTES = new Uint8Array([1, 2, 3, 4])
  const okBody = (messageId: unknown) => JSON.stringify({ ok: true, result: { message_id: messageId } })

  function fakeFetch(bodies: string[], options: { hangMs?: number } = {}) {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const impl = async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      if (options.hangMs) await new Promise((resolve) => setTimeout(resolve, options.hangMs))
      return new Response(bodies.shift() ?? '', { status: 200 })
    }
    return { impl, requests }
  }

  test('happy path: real multipart fields, positive id accepted, exactly ONE request (no retries)', async () => {
    const { impl, requests } = fakeFetch([okBody(42)])
    const send = createTelegramDocumentSender(impl)
    expect(await send('tok', '555', 'подпись', 'report-2028-03.xlsx', BYTES)).toEqual({ ok: true, messageId: 42 })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://api.telegram.org/bottok/sendDocument')
    expect(requests[0].init.redirect).toBe('error')
    const form = requests[0].init.body as FormData
    expect(form.get('chat_id')).toBe('555')
    expect(form.get('caption')).toBe('подпись')
    const doc = form.get('document') as File
    expect(doc.name).toBe('report-2028-03.xlsx')
    expect(new Uint8Array(await doc.arrayBuffer())).toEqual(BYTES)
  })

  test('a "success" without a plausible message id is NOT a success: -1, 0, 1.5, missing → ambiguous', async () => {
    for (const bad of [-1, 0, 1.5, '7', null, undefined]) {
      const { impl } = fakeFetch([okBody(bad)])
      const send = createTelegramDocumentSender(impl)
      expect(await send('tok', '555', 'c', 'f.xlsx', BYTES)).toEqual({ ok: false, kind: 'ambiguous' })
    }
  })

  test('definite refusal is rejected; malformed and OVERSIZED bodies are ambiguous', async () => {
    const rejected = createTelegramDocumentSender(fakeFetch([JSON.stringify({ ok: false, description: 'nope' })]).impl)
    expect(await rejected('t', '5', 'c', 'f.xlsx', BYTES)).toEqual({ ok: false, kind: 'rejected' })
    const malformed = createTelegramDocumentSender(fakeFetch(['{not json']).impl)
    expect(await malformed('t', '5', 'c', 'f.xlsx', BYTES)).toEqual({ ok: false, kind: 'ambiguous' })
    const oversized = createTelegramDocumentSender(fakeFetch(['x'.repeat(65 * 1024)]).impl)
    expect(await oversized('t', '5', 'c', 'f.xlsx', BYTES)).toEqual({ ok: false, kind: 'ambiguous' })
  })

  test('ONE shared deadline: a hung transport aborts to ambiguous; ONE request only', async () => {
    const { impl, requests } = fakeFetch([okBody(42)], { hangMs: 500 })
    const send = createTelegramDocumentSender(impl, { timeoutMs: 100 })
    const started = Date.now()
    expect(await send('t', '5', 'c', 'f.xlsx', BYTES)).toEqual({ ok: false, kind: 'ambiguous' })
    expect(Date.now() - started).toBeLessThan(5_000)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(requests).toHaveLength(1) // never retried on a maybe
  })

  test('the clock crossing the deadline in the FINAL body read turns a late success into UNKNOWN', async () => {
    // root's reproduced boundary: read() returns done AFTER the pre-read clock check passed,
    // with the clock now beyond the deadline and the timer macrotask never fired — the
    // post-parse checkpoint must refuse to claim 'sent' for a completion outside the bound
    const nowRef = { value: 1_000_000 }
    const impl = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(okBody(42))) },
      pull(controller) { nowRef.value += 60_000; controller.close() }, // the budget dies on the last read
    }), { status: 200 })
    const send = createTelegramDocumentSender(impl, { timeoutMs: 30_000, now: () => nowRef.value })
    expect(await send('t', '5', 'c', 'f.xlsx', BYTES)).toEqual({ ok: false, kind: 'ambiguous' })
  })
})

describe('runReminderWorkerKind', () => {
  const OPTS = { todayTashkent: '2026-09-30', planBudgetMs: 150, drainBudgetMs: 5_000 }
  const sendOk = async () => ({ ok: true, messageId: 7 } as const)

  test('plan: happy count; RPC error, THROW and HANG all answer plan_failed within the budget', async () => {
    const happy = fakeWorkerAdmin({ plan: { data: 4 } })
    expect(await runReminderWorkerKind({ admin: happy.admin, send: sendOk, blocksExternal: async () => false, killSwitch: 'on' }, 'reminder-plan', OPTS))
      .toMatchObject({ status: 200, body: { ok: true, planned: 4 } })

    const errored = fakeWorkerAdmin({ plan: { data: null, error: new Error('db') } })
    expect((await runReminderWorkerKind({ admin: errored.admin, send: sendOk, blocksExternal: async () => false, killSwitch: 'on' }, 'reminder-plan', OPTS)).status).toBe(503)

    const throwing = fakeWorkerAdmin({})
    throwing.admin.rpc = () => { throw new Error('boom with internals') }
    const thrown = await runReminderWorkerKind({ admin: throwing.admin, send: sendOk, blocksExternal: async () => false, killSwitch: 'on' }, 'reminder-plan', OPTS)
    expect(thrown).toMatchObject({ status: 503, body: { error: 'plan_failed' } }) // fixed slug, no raw details

    const hung = fakeWorkerAdmin({ plan: 'HANG' })
    const started = Date.now()
    expect((await runReminderWorkerKind({ admin: hung.admin, send: sendOk, blocksExternal: async () => false, killSwitch: 'on' }, 'reminder-plan', OPTS)).status).toBe(503)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('drain: kill switch stays default OFF; when on, the token read is tenant-scoped AND telegram-typed', async () => {
    const off = fakeWorkerAdmin({ claim: [CLAIM_ROW] })
    const disabled = await runReminderWorkerKind({ admin: off.admin, send: sendOk, blocksExternal: async () => false, killSwitch: '' }, 'reminder-drain', OPTS)
    expect(disabled.body).toMatchObject({ ok: true, tick: { disabled: true } })
    expect(off.rpcCalls).toHaveLength(0)

    const on = fakeWorkerAdmin({ claim: [CLAIM_ROW] })
    const sends: string[] = []
    const result = await runReminderWorkerKind({
      admin: on.admin,
      send: async (_token, chatId) => { sends.push(chatId); return { ok: true, messageId: 7 } },
      blocksExternal: async () => false,
      killSwitch: 'ON', // case-insensitive
    }, 'reminder-drain', OPTS)
    expect(result.body).toMatchObject({ ok: true, tick: { sent: 1 } })
    expect(sends).toEqual(['555'])
    expect(on.eqs).toEqual([['id', 'ch-1'], ['account_id', 'acc-1'], ['type', 'telegram']])
  })

  test('drain: a guarded (synthetic/E2E) account never reaches dispatch or Telegram', async () => {
    const { admin, rpcCalls } = fakeWorkerAdmin({ claim: [CLAIM_ROW] })
    const sends: string[] = []
    const result = await runReminderWorkerKind({
      admin,
      send: async (_token, chatId) => { sends.push(chatId); return { ok: true, messageId: 7 } },
      blocksExternal: async () => true,
      killSwitch: 'on',
    }, 'reminder-drain', OPTS)
    expect(result.body).toMatchObject({ ok: true, tick: { skipped: 1, sent: 0 } })
    expect(sends).toHaveLength(0)
    expect(rpcCalls.map((c) => c.name)).not.toContain('reminder_mark_dispatch') // guard sits BEFORE the marker
    const finish = rpcCalls.find((c) => c.name === 'reminder_finish')
    expect(finish?.args).toMatchObject({ p_status: 'skipped', p_error: 'external_blocked' })
  })

  test('drain: a guard OUTAGE fails closed — treated as blocked, nothing sent', async () => {
    const { admin } = fakeWorkerAdmin({ claim: [CLAIM_ROW] })
    const sends: string[] = []
    const result = await runReminderWorkerKind({
      admin,
      send: async (_token, chatId) => { sends.push(chatId); return { ok: true, messageId: 7 } },
      blocksExternal: async () => { throw new Error('guard down') },
      killSwitch: 'on',
    }, 'reminder-drain', OPTS)
    expect(result.body).toMatchObject({ ok: true, tick: { skipped: 1, sent: 0 } })
    expect(sends).toHaveLength(0)
  })
})
