// Step 2b delivery engine + webhook recipient branch — offline tests. Fake db/sender only.
import { describe, expect, test } from 'vitest'
import {
  constantTimeEquals,
  createTelegramSender,
  dueReached,
  runDeliveryTick,
  type DeliveryDeps,
  type SendOutcome,
} from '../supabase/functions/_shared/dailyBriefingDelivery.ts'
import { handleBriefingTelegramUpdate } from '../supabase/functions/_shared/briefingRecipient.ts'
import { type FetchLike } from '../supabase/functions/_shared/dailyBriefingSources.ts'

const MORNING_NOW = () => new Date('2026-09-05T04:00:00Z') // 09:00 Tashkent — morning due
const EARLY_NOW = () => new Date('2026-09-05T01:00:00Z') // 06:00 Tashkent — nothing due

type QueueResult = { data?: unknown; error?: unknown; count?: number | null; hang?: boolean }

function fakeDb(queue: Record<string, QueueResult[]>) {
  const ops: string[] = []
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const next = (key: string): QueueResult => {
    const q = queue[key]
    return q && q.length ? q.shift()! : { data: null, error: null, count: null }
  }
  return {
    ops,
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
        chain[method] = () => { ops.push(`${table}.${method}`); return chain }
      }
      chain.maybeSingle = () => {
        ops.push(`${table}.maybeSingle`)
        const result = next(table)
        return result.hang ? new Promise(() => {}) : Promise.resolve(result)
      }
      chain.then = (onFulfilled: (v: QueueResult) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(next(table)).then(onFulfilled, onRejected)
      return chain
    },
  }
}

const CBU_ROW = { Ccy: 'USD', Nominal: '1', Rate: '12650.44', Date: '05.09.2026' }
const RUN = { id: 'run-1', account_id: 'acc-1', kind: 'morning' as const, lease_token: 'lease-1' }
const MARK_OK = { data: { ok: true, channel_id: 'ch-1', chat_id: '555' }, error: null }

function makeDelivery(queues: Record<string, QueueResult[]>, overrides: Partial<DeliveryDeps> = {}) {
  const db = fakeDb({
    briefing_settings: [{ data: { weather_lat: null, weather_lon: null }, error: null }],
    business_profiles: [{ data: { report_lang: 'ru' }, error: null }],
    channels: [{ data: { credentials: { bot_token: 'BOT-TOKEN' } }, error: null }],
    ...queues,
  })
  const sends: Array<{ botToken: string; chatId: string; text: string }> = []
  const fetchImpl: FetchLike = async () => new Response(JSON.stringify([CBU_ROW]))
  const deps: DeliveryDeps = {
    admin: db,
    fetchImpl,
    openWeatherKey: '',
    calendarSection: async () => ({ status: 'ready', source: 'www.googleapis.com/calendar', fetchedAt: MORNING_NOW().toISOString(), data: { events: [], truncated: false } }),
    sendMessage: async (botToken, chatId, text) => {
      db.ops.push('send.telegram')
      sends.push({ botToken, chatId, text })
      return { status: 'sent', messageId: 4242 }
    },
    now: MORNING_NOW,
    ...overrides,
  }
  return { deps, db, sends }
}

describe('runDeliveryTick', () => {
  const claimOnce = (row = RUN) => ({ 'rpc:briefing_claim_runs': [{ data: [row], error: null }, { data: [], error: null }] })

  test('happy path: recover → prepare → claim → mark → send to the SNAPSHOT → finish sent', async () => {
    const { deps, db, sends } = makeDelivery({
      ...claimOnce(),
      'rpc:briefing_recover_runs': [{ data: 0, error: null }],
      'rpc:briefing_prepare_runs': [{ data: 1, error: null }],
      'rpc:briefing_mark_dispatch': [MARK_OK],
      'rpc:briefing_finish_run': [{ data: true, error: null }],
    })
    const [summary] = await runDeliveryTick(deps, { kind: 'morning' })
    expect(summary).toMatchObject({ kind: 'morning', prepared: 1, claimed: 1, sent: 1, failed: 0, unknown: 0 })
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ botToken: 'BOT-TOKEN', chatId: '555' })
    expect(sends[0].text).toContain('Утренний брифинг')
    expect(db.ops.indexOf('rpc.briefing_mark_dispatch')).toBeLessThan(db.ops.indexOf('send.telegram'))
    const finish = db.rpcCalls.find((c) => c.name === 'briefing_finish_run')
    expect(finish?.args).toMatchObject({ p_status: 'sent', p_message_id: 4242, p_lease_token: 'lease-1' })
  })

  test("the WORKER's sent morning text carries yesterday's outcome quote", async () => {
    const { deps, sends } = makeDelivery({
      ...claimOnce(),
      briefing_outcomes: [{ data: { run_date: '2026-09-04', text: 'Сдали отчёт' }, error: null }],
      'rpc:briefing_mark_dispatch': [MARK_OK],
      'rpc:briefing_finish_run': [{ data: true, error: null }],
    })
    const [summary] = await runDeliveryTick(deps, { kind: 'morning' })
    expect(summary.sent).toBe(1)
    expect(sends[0].text).toContain('«Сдали отчёт» (2026-09-04)')
  })

  test('a hung outcomes read in the worker is bounded: pre-dispatch retriable, no send', async () => {
    const { deps, db, sends } = makeDelivery(
      { ...claimOnce(), briefing_outcomes: [{ hang: true }] },
      { budgetMs: 300 },
    )
    const started = Date.now()
    const [summary] = await runDeliveryTick(deps, { kind: 'morning' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(summary.retriable).toBe(1)
    expect(sends).toHaveLength(0)
    expect(db.rpcCalls.some((c) => c.name === 'briefing_mark_dispatch')).toBe(false)
  })

  test('the Tashkent due gate: before 08:30 nothing is prepared or claimed — only recovery runs', async () => {
    const { deps, db, sends } = makeDelivery({}, { now: EARLY_NOW })
    const [summary] = await runDeliveryTick(deps, { kind: 'morning' })
    expect(summary).toMatchObject({ prepared: 0, claimed: 0, sent: 0 })
    expect(db.rpcCalls.map((c) => c.name)).toEqual(['briefing_recover_runs'])
    expect(sends).toHaveLength(0)
  })

  test('an early drain recovers BOTH kinds and invents no runs', async () => {
    const { deps, db, sends } = makeDelivery({}, { now: EARLY_NOW })
    const summaries = await runDeliveryTick(deps, { kind: 'drain' })
    expect(summaries).toHaveLength(2)
    expect(db.rpcCalls.map((c) => c.name)).toEqual(['briefing_recover_runs', 'briefing_recover_runs'])
    expect(sends).toHaveLength(0)
  })

  test('a refused dispatch marker means NO send; a definite reason finishes as skipped', async () => {
    const { deps, db, sends } = makeDelivery({
      ...claimOnce(),
      'rpc:briefing_mark_dispatch': [{ data: { ok: false, reason: 'recipient_not_verified' }, error: null }],
      'rpc:briefing_finish_run': [{ data: true, error: null }],
    })
    const [summary] = await runDeliveryTick(deps, { kind: 'morning' })
    expect(sends).toHaveLength(0)
    expect(summary.skipped).toBe(1)
    expect(db.rpcCalls.find((c) => c.name === 'briefing_finish_run')?.args).toMatchObject({ p_status: 'skipped', p_error: 'recipient_not_verified' })
  })

  test('a lost lease neither sends nor finishes; a marker RPC error leaves the row retriable', async () => {
    for (const markResult of [
      { data: { ok: false, reason: 'lease_lost' }, error: null },
      { data: null, error: new Error('db down') },
    ]) {
      const { deps, db, sends } = makeDelivery({ ...claimOnce(), 'rpc:briefing_mark_dispatch': [markResult] })
      const [summary] = await runDeliveryTick(deps, { kind: 'morning' })
      expect(sends).toHaveLength(0)
      expect(db.rpcCalls.some((c) => c.name === 'briefing_finish_run')).toBe(false)
      if (markResult.error) expect(summary.retriable).toBe(1)
    }
  })

  test('an ambiguous send is terminal unknown — the sender is never called twice', async () => {
    const { deps, db, sends } = makeDelivery(
      { ...claimOnce(), 'rpc:briefing_mark_dispatch': [MARK_OK], 'rpc:briefing_finish_run': [{ data: true, error: null }] },
      { sendMessage: async (): Promise<SendOutcome> => ({ status: 'ambiguous' }) },
    )
    const [summary] = await runDeliveryTick(deps, { kind: 'morning' })
    expect(summary.unknown).toBe(1)
    expect(sends).toHaveLength(0) // override sender records nothing — assert via finish args
    expect(db.rpcCalls.find((c) => c.name === 'briefing_finish_run')?.args).toMatchObject({ p_status: 'unknown', p_error: 'send_ambiguous' })
  })

  test('a definite Telegram rejection is terminal failed with NO retry', async () => {
    let sendCount = 0
    const { deps, db } = makeDelivery(
      { ...claimOnce(), 'rpc:briefing_mark_dispatch': [MARK_OK], 'rpc:briefing_finish_run': [{ data: true, error: null }] },
      { sendMessage: async (): Promise<SendOutcome> => { sendCount += 1; return { status: 'rejected', detail: 'chat not found' } } },
    )
    const [summary] = await runDeliveryTick(deps, { kind: 'morning' })
    expect(summary.failed).toBe(1)
    expect(sendCount).toBe(1)
    expect(db.rpcCalls.find((c) => c.name === 'briefing_finish_run')?.args).toMatchObject({ p_status: 'failed', p_error: 'chat not found' })
  })

  test('a pre-dispatch settings read error leaves the row retriable — no finish, no send', async () => {
    const { deps, db, sends } = makeDelivery({
      ...claimOnce(),
      briefing_settings: [{ data: null, error: { code: '57014' } }],
    })
    const [summary] = await runDeliveryTick(deps, { kind: 'morning' })
    expect(summary.retriable).toBe(1)
    expect(sends).toHaveLength(0)
    expect(db.rpcCalls.some((c) => c.name === 'briefing_finish_run')).toBe(false)
    expect(db.rpcCalls.some((c) => c.name === 'briefing_mark_dispatch')).toBe(false)
  })

  test('a missing bot token AFTER dispatch is definite failed (nothing was sent)', async () => {
    const { deps, db, sends } = makeDelivery({
      ...claimOnce(),
      channels: [{ data: { credentials: {} }, error: null }],
      'rpc:briefing_mark_dispatch': [MARK_OK],
      'rpc:briefing_finish_run': [{ data: true, error: null }],
    })
    await runDeliveryTick(deps, { kind: 'morning' })
    expect(sends).toHaveLength(0)
    expect(db.rpcCalls.find((c) => c.name === 'briefing_finish_run')?.args).toMatchObject({ p_status: 'failed', p_error: 'channel_missing' })
  })

  test('an exhausted budget stops mid-batch: no marker, no send, later rows never start', async () => {
    const { deps, db, sends } = makeDelivery(
      {
        'rpc:briefing_claim_runs': [{ data: [RUN, { ...RUN, id: 'run-2', account_id: 'acc-2' }], error: null }],
        business_profiles: [{ hang: true }], // the first row stalls until the budget expires
      },
      { budgetMs: 200 },
    )
    const started = Date.now()
    const [summary] = await runDeliveryTick(deps, { kind: 'morning' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(summary.stoppedByBudget).toBe(true)
    expect(summary.claimed).toBe(1) // the second claimed row is never even started
    expect(summary.retriable).toBe(1)
    expect(sends).toHaveLength(0)
    expect(db.rpcCalls.some((c) => c.name === 'briefing_mark_dispatch')).toBe(false)
  })

  test('dueReached boundaries follow Tashkent time exactly', () => {
    expect(dueReached('morning', new Date('2026-09-05T03:29:00Z'))).toBe(false) // 08:29
    expect(dueReached('morning', new Date('2026-09-05T03:30:00Z'))).toBe(true) // 08:30
    expect(dueReached('evening', new Date('2026-09-05T14:59:00Z'))).toBe(false) // 19:59
    expect(dueReached('evening', new Date('2026-09-05T15:00:00Z'))).toBe(true) // 20:00
  })
})

describe('createTelegramSender', () => {
  const sender = (handler: (url: string, init: Parameters<FetchLike>[1]) => Response | Promise<Response>) =>
    createTelegramSender(async (url, init) => handler(url, init))

  test('definite success carries the message id; definite refusal is rejected', async () => {
    const ok = await sender(() => new Response(JSON.stringify({ ok: true, result: { message_id: 77 } })))('B', '5', 'hi')
    expect(ok).toEqual({ status: 'sent', messageId: 77 })
    const refused = await sender(() => new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }), { status: 403 }))('B', '5', 'hi')
    expect(refused).toMatchObject({ status: 'rejected', detail: expect.stringContaining('blocked') })
  })

  test('network death and an endless response body are ambiguous — bounded, not buffered', async () => {
    expect(await sender(() => { throw new Error('reset') })('B', '5', 'hi')).toEqual({ status: 'ambiguous' })
    const endless = () => new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(8_192)) } }))
    const started = Date.now()
    expect(await sender(endless)('B', '5', 'hi')).toEqual({ status: 'ambiguous' })
    expect(Date.now() - started).toBeLessThan(2_000) // stopped by the 64KB cap, not the 10s deadline
  })

  test('constantTimeEquals compares without shortcuts', () => {
    expect(constantTimeEquals('secret', 'secret')).toBe(true)
    expect(constantTimeEquals('secret', 'secreT')).toBe(false)
    expect(constantTimeEquals('secret', '')).toBe(false)
  })
})

describe('handleBriefingTelegramUpdate', () => {
  const CH = 'ch-1'
  const privateMsg = (text: string, extra: Record<string, unknown> = {}) => ({
    text, chat: { id: 777, type: 'private' }, from: { id: 777 }, ...extra,
  })
  function makeRecipient(queues: Record<string, QueueResult[]> = {}, timeoutMs?: number) {
    const db = fakeDb(queues)
    const replies: string[] = []
    return {
      db,
      replies,
      run: (message: Record<string, unknown>, updateId = 1) => handleBriefingTelegramUpdate(
        { db, sendReply: async (_chat, text) => { replies.push(text) }, timeoutMs },
        { channelId: CH, message, updateId },
      ),
    }
  }
  const TOKEN = 'a'.repeat(48)

  test('/start brf_ in a group or forwarded shape refuses without touching the DB', async () => {
    const { db, replies, run } = makeRecipient()
    const group = await run({ text: `/start brf_${TOKEN}`, chat: { id: -100, type: 'group' }, from: { id: 777 } })
    expect(group.handled).toBe(true)
    const impersonated = await run({ text: `/start brf_${TOKEN}`, chat: { id: 777, type: 'private' }, from: { id: 888 } })
    expect(impersonated.handled).toBe(true)
    expect(db.rpcCalls).toHaveLength(0)
    expect(replies).toHaveLength(2)
  })

  test('a valid /start consumes the HASH of the token in one RPC', async () => {
    const { db, replies, run } = makeRecipient({ 'rpc:briefing_consume_claim': [{ data: { ok: true }, error: null }] })
    const result = await run(privateMsg(`/start brf_${TOKEN}`))
    expect(result.handled).toBe(true)
    const call = db.rpcCalls[0]
    expect(call.name).toBe('briefing_consume_claim')
    expect(String(call.args.p_token_hash)).toMatch(/^[0-9a-f]{64}$/)
    expect(call.args.p_token_hash).not.toContain(TOKEN)
    expect(call.args).toMatchObject({ p_chat_id: '777', p_channel_id: CH })
    expect(replies[0]).toContain('подтверждён')
  })

  test('stale/superseded/wrong-channel verdicts get the reissue reply; errors get failed', async () => {
    for (const [result, fragment] of [
      [{ data: { ok: false, reason: 'stale' }, error: null }, 'изменились'],
      [{ data: { ok: false, reason: 'superseded' }, error: null }, 'изменились'],
      [{ data: { ok: false, reason: 'invalid' }, error: null }, 'недействительна'],
      [{ data: null, error: new Error('db down') }, 'Не удалось'],
    ] as const) {
      const { replies, run } = makeRecipient({ 'rpc:briefing_consume_claim': [result as QueueResult] })
      await run(privateMsg(`/start brf_${TOKEN}`))
      expect(replies[0]).toContain(fragment)
    }
  })

  test('a hung DB is bounded: /start resolves quickly and ordinary replies fall through fast', async () => {
    const hungDb = {
      rpcCalls: [] as unknown[],
      rpc: () => new Promise(() => {}),
      from: () => ({}),
    }
    const replies: string[] = []
    const started = Date.now()
    const start = await handleBriefingTelegramUpdate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: hungDb as any, sendReply: async (_c, t) => { replies.push(t) }, timeoutMs: 25 },
      { channelId: CH, message: privateMsg(`/start brf_${TOKEN}`), updateId: 1 },
    )
    expect(start.handled).toBe(true)
    const reply = await handleBriefingTelegramUpdate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: hungDb as any, sendReply: async () => {}, timeoutMs: 25 },
      { channelId: CH, message: privateMsg('обычный ответ', { reply_to_message: { message_id: 500 } }), updateId: 2 },
    )
    expect(reply.handled).toBe(false) // ordinary traffic is stalled by at most the bound
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('after the deadline nothing new is dispatched — not even the failure reply', async () => {
    const replies: string[] = []
    const hungDb = { rpc: () => new Promise(() => {}), from: () => ({}) }
    const result = await handleBriefingTelegramUpdate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { db: hungDb as any, sendReply: async (_c, t) => { replies.push(t) }, timeoutMs: 20 },
      { channelId: CH, message: privateMsg('/day_result итог дня'), updateId: 3 },
    )
    expect(result.handled).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40)) // give a late dispatch every chance
    expect(replies).toHaveLength(0) // Promise.race must not evaluate sendReply after expiry
  })

  test('a reply becomes an outcome ONLY on a dispatch-snapshot match; no_match falls through', async () => {
    const matched = makeRecipient({ 'rpc:briefing_capture_outcome': [{ data: { ok: true }, error: null }] })
    const ok = await matched.run(privateMsg('Сделали 4 задачи', { reply_to_message: { message_id: 500 } }), 42)
    expect(ok.handled).toBe(true)
    expect(matched.db.rpcCalls[0].args).toMatchObject({ p_reply_message_id: 500, p_update_id: 42, p_via: 'reply' })
    expect(matched.replies[0]).toContain('записан')

    const unmatched = makeRecipient({ 'rpc:briefing_capture_outcome': [{ data: { ok: false, reason: 'no_match' }, error: null }] })
    const through = await unmatched.run(privateMsg('обычный чат', { reply_to_message: { message_id: 9 } }))
    expect(through.handled).toBe(false)
    expect(unmatched.replies).toHaveLength(0)
  })

  test('a reply not authored by the chat owner is never offered as an outcome', async () => {
    const { db, run } = makeRecipient()
    const result = await run({ text: 'x', chat: { id: 777, type: 'private' }, from: { id: 888 }, reply_to_message: { message_id: 5 } })
    expect(result.handled).toBe(false)
    expect(db.rpcCalls).toHaveLength(0)
  })

  test('/day_result: usage hint when empty, explicit capture when not, refusal reported', async () => {
    const empty = makeRecipient()
    await empty.run(privateMsg('/day_result'))
    expect(empty.replies[0]).toContain('/day_result')
    expect(empty.db.rpcCalls).toHaveLength(0)

    const saved = makeRecipient({ 'rpc:briefing_capture_outcome': [{ data: { ok: true }, error: null }] })
    await saved.run(privateMsg('/day_result всё сделано'), 55)
    expect(saved.db.rpcCalls[0].args).toMatchObject({ p_via: 'command', p_update_id: 55, p_reply_message_id: null })
    expect(saved.replies[0]).toContain('записан')

    const refused = makeRecipient({ 'rpc:briefing_capture_outcome': [{ data: { ok: false, reason: 'not_verified' }, error: null }] })
    await refused.run(privateMsg('/day_result итог'))
    expect(refused.replies[0]).toContain('не подтверждён')
  })

  test('unrelated messages never touch the briefing path', async () => {
    const { db, run } = makeRecipient()
    expect((await run(privateMsg('привет, как дела?'))).handled).toBe(false)
    expect((await run({ text: '/start commerce_123', chat: { id: 1, type: 'private' }, from: { id: 1 } })).handled).toBe(false)
    expect(db.rpcCalls).toHaveLength(0)
  })
})
