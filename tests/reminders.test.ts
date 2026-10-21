// Monthly-reminder delivery tick — offline tests with scripted RPCs and a fake sender.
// No network, no Telegram, no model APIs; synthetic data only.
import { describe, expect, test } from 'vitest'
import {
  composeReminderMessage, composeReportCaption, runReminderDeliveryTick, tashkentDateOf,
  MAX_REPORT_DOCUMENT_BYTES,
  type ReminderClaimRow, type ReminderDeliveryDeps, type ReminderSendResult,
} from '../supabase/functions/_shared/reminderDelivery.ts'

const ROW: ReminderClaimRow = {
  id: 'occ-1', account_id: 'acc-1', schedule_id: 'sch-1',
  due_date: '2026-09-30', due_at: '2026-09-30T04:00:00Z',
  lease_token: 'lease-1', attempt_count: 1, title: 'Сдать отчёт по продукту',
}

const FROZEN = {
  ok: true, file_sha256: 'f'.repeat(64), file_name: 'март.xlsx',
  period_month: '2026-09', uploaded_at: '2026-09-10T10:00:00Z', currency: 'USD',
}

interface Script {
  recover?: { data?: unknown; error?: unknown }
  claim?: { data?: unknown; error?: unknown }
  mark?: { data?: unknown; error?: unknown } | 'HANG'
  finishResults?: Array<{ data?: unknown; error?: unknown }>
  token?: string | null
  send?: ReminderSendResult
  freeze?: { data?: unknown; error?: unknown }
  sourceBytes?: Uint8Array | null
  buildResult?: { ok: true; xlsx: Uint8Array } | { ok: false; reason: string }
  buildSideEffect?: () => void
  docSend?: ReminderSendResult
  hashResult?: string
  nowRef?: { value: number }
}

function makeDeps(script: Script) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const sends: Array<{ token: string; chatId: string; text: string }> = []
  const docSends: Array<{ chatId: string; caption: string; fileName: string; byteLength: number }> = []
  const buildCalls: Array<Record<string, unknown>> = []
  const sourceReads: Array<{ accountId: string; sha: string }> = []
  const deps: ReminderDeliveryDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      if (name === 'reminder_recover') return script.recover ?? { data: 0 }
      if (name === 'reminder_claim_due') return script.claim ?? { data: [] }
      if (name === 'reminder_freeze_source') return script.freeze ?? { data: FROZEN }
      if (name === 'reminder_mark_dispatch') {
        if (script.mark === 'HANG') return new Promise(() => {})
        return script.mark ?? { data: { ok: true, channel_id: 'ch-1', chat_id: '555' } }
      }
      if (name === 'reminder_finish') return (script.finishResults ?? []).shift() ?? { data: true }
      return { error: new Error(`unexpected rpc ${name}`) }
    },
    getChannelToken: async () => script.token === undefined ? 'bot-token' : script.token,
    send: async (token, chatId, text) => {
      sends.push({ token, chatId, text })
      return script.send ?? { ok: true, messageId: 42 }
    },
    getSourceFile: async (accountId, sha) => {
      sourceReads.push({ accountId, sha })
      return script.sourceBytes === null ? { error: 'not_found' } : { bytes: script.sourceBytes ?? new Uint8Array(64) }
    },
    buildReport: (_bytes, snapshot) => {
      buildCalls.push(snapshot as unknown as Record<string, unknown>)
      script.buildSideEffect?.()
      return script.buildResult ?? { ok: true, xlsx: new Uint8Array(128) }
    },
    sendDocument: async (_token, chatId, caption, fileName, bytes) => {
      docSends.push({ chatId, caption, fileName, byteLength: bytes.byteLength })
      return script.docSend ?? { ok: true, messageId: 77 }
    },
    hashBytes: async () => script.hashResult ?? FROZEN.file_sha256,
    ...(script.nowRef ? { now: () => script.nowRef!.value } : {}),
  }
  return { deps, calls, sends, docSends, buildCalls, sourceReads }
}

const finishesOf = (calls: Array<{ name: string; args: Record<string, unknown> }>) =>
  calls.filter((c) => c.name === 'reminder_finish').map((c) => ({ status: c.args.p_status, error: c.args.p_error }))

describe('composeReminderMessage', () => {
  test('deterministic bilingual frame around the user’s own title', () => {
    expect(composeReminderMessage('Сдать отчёт', '2026-09-30'))
      .toBe('🔔 Напоминание / Eslatma (30.09.2026)\nСдать отчёт')
  })
})

describe('runReminderDeliveryTick', () => {
  const OPTS = { budgetMs: 5_000, killSwitch: 'on', todayTashkent: '2026-09-30' }

  test('the kill switch is DEFAULT OFF: without an explicit "on" nothing is even queried', async () => {
    for (const killSwitch of ['', 'off', 'true', '1']) {
      const { deps, calls } = makeDeps({})
      const result = await runReminderDeliveryTick(deps, { ...OPTS, killSwitch })
      expect(result.disabled).toBe(true)
      expect(calls).toHaveLength(0)
    }
  })

  test('happy path: compose before marker, send to the SNAPSHOT, finish sent with the message id', async () => {
    const { deps, calls, sends } = makeDeps({ claim: { data: [ROW] } })
    const result = await runReminderDeliveryTick(deps, OPTS)
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0, unknown: 0, timedOut: false })
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ token: 'bot-token', chatId: '555' }) // the marker's snapshot chat
    expect(sends[0].text).toContain('Сдать отчёт по продукту')
    expect(sends[0].text).toContain('30.09.2026')
    const finish = calls.find((c) => c.name === 'reminder_finish')
    expect(finish?.args).toMatchObject({ p_status: 'sent', p_message_id: 42, p_occurrence_id: 'occ-1', p_lease_token: 'lease-1' })
  })

  test('a refused marker (consent/revision) closes the occurrence as skipped and never sends', async () => {
    const { deps, calls, sends } = makeDeps({
      claim: { data: [ROW] },
      mark: { data: { ok: false, reason: 'recipient_not_verified' } },
    })
    const result = await runReminderDeliveryTick(deps, OPTS)
    expect(result).toMatchObject({ claimed: 1, sent: 0, skipped: 1 })
    expect(sends).toHaveLength(0)
    expect(finishesOf(calls)).toEqual([{ status: 'skipped', error: 'recipient_not_verified' }])
  })

  test('a lost lease is left alone — no finish call rides a fence we no longer hold', async () => {
    const { deps, calls, sends } = makeDeps({
      claim: { data: [ROW] },
      mark: { data: { ok: false, reason: 'lease_lost' } },
    })
    const result = await runReminderDeliveryTick(deps, OPTS)
    expect(result).toMatchObject({ claimed: 1, skipped: 0 })
    expect(sends).toHaveLength(0)
    expect(finishesOf(calls)).toEqual([])
  })

  test('dispatched but no token: terminal failed, no send, never a resend path', async () => {
    const { deps, calls, sends } = makeDeps({ claim: { data: [ROW] }, token: null })
    const result = await runReminderDeliveryTick(deps, OPTS)
    expect(result).toMatchObject({ claimed: 1, failed: 1, sent: 0 })
    expect(sends).toHaveLength(0)
    expect(finishesOf(calls)).toEqual([{ status: 'failed', error: 'token_unavailable' }])
  })

  test('a definite Telegram rejection is failed; an ambiguous send is terminal UNKNOWN', async () => {
    const rejected = makeDeps({ claim: { data: [ROW] }, send: { ok: false, kind: 'rejected' } })
    expect(await runReminderDeliveryTick(rejected.deps, OPTS)).toMatchObject({ failed: 1 })
    expect(finishesOf(rejected.calls)).toEqual([{ status: 'failed', error: 'telegram_rejected' }])

    for (const kind of ['ambiguous', 'retriable'] as const) {
      const ambiguous = makeDeps({ claim: { data: [ROW] }, send: { ok: false, kind } })
      expect(await runReminderDeliveryTick(ambiguous.deps, OPTS)).toMatchObject({ unknown: 1, sent: 0 })
      expect(finishesOf(ambiguous.calls)).toEqual([{ status: 'unknown', error: 'send_ambiguous' }])
    }
  })

  test('a hung dependency returns at the budget with timedOut — and nothing dispatches afterwards', async () => {
    const { deps, calls, sends } = makeDeps({ claim: { data: [ROW] }, mark: 'HANG' })
    const started = Date.now()
    const result = await runReminderDeliveryTick(deps, { ...OPTS, budgetMs: 150 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
    await new Promise((resolve) => setTimeout(resolve, 60)) // let any abandoned branch try
    expect(sends).toHaveLength(0)
    expect(finishesOf(calls)).toEqual([]) // the lease simply expires; recovery closes it next tick
  })

  test('product report: prepare BEFORE the marker — freeze, read, verify, build, then dispatch and sendDocument', async () => {
    const REPORT_ROW: ReminderClaimRow = {
      ...ROW, id: 'occ-r', kind: 'product_report', report_currency: 'USD',
      lease_until: new Date(Date.now() + 300_000).toISOString(),
    }
    const { deps, calls, sends, docSends, buildCalls } = makeDeps({ claim: { data: [REPORT_ROW] } })
    const result = await runReminderDeliveryTick(deps, OPTS)
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0, unknown: 0 })
    expect(sends).toHaveLength(0) // a report is a DOCUMENT, not a message
    expect(docSends).toHaveLength(1)
    expect(docSends[0]).toMatchObject({ chatId: '555', fileName: 'report-2026-09.xlsx' })
    // facts only: user-declared period, labeled UPLOAD date — no completeness claim
    expect(docSends[0].caption).toContain('Заявленный период')
    expect(docSends[0].caption).toContain('2026-09')
    expect(docSends[0].caption).toContain('Загружено')
    expect(docSends[0].caption).not.toContain('по состоянию')
    expect(buildCalls[0]).toMatchObject({ file_sha256: FROZEN.file_sha256, occurrenceId: 'occ-r', title: ROW.title, due_date: ROW.due_date })
    const names = calls.map((c) => c.name)
    expect(names.indexOf('reminder_freeze_source')).toBeLessThan(names.indexOf('reminder_mark_dispatch'))
    expect(finishesOf(calls)).toEqual([{ status: 'sent', error: null }])
  })

  test('product report failures close BEFORE any dispatch: missing period, read, integrity, size', async () => {
    const REPORT_ROW: ReminderClaimRow = {
      ...ROW, id: 'occ-r', kind: 'product_report', report_currency: 'USD',
      lease_until: new Date(Date.now() + 300_000).toISOString(),
    }
    const cases: Array<[Script, string]> = [
      [{ claim: { data: [REPORT_ROW] }, freeze: { data: { ok: false, reason: 'source_missing_period' } } }, 'source_missing_period'],
      [{ claim: { data: [REPORT_ROW] }, sourceBytes: null }, 'source_read_failed'],
      [{ claim: { data: [REPORT_ROW] }, hashResult: '0'.repeat(64) }, 'source_integrity'],
      [{ claim: { data: [REPORT_ROW] }, buildResult: { ok: true, xlsx: new Uint8Array(MAX_REPORT_DOCUMENT_BYTES + 1) } }, 'document_too_large'],
      [{ claim: { data: [REPORT_ROW] }, buildResult: { ok: false, reason: 'no_recognized_sheets' } }, 'engine_no_recognized_sheets'],
    ]
    for (const [script, reason] of cases) {
      const { deps, calls, docSends } = makeDeps(script)
      const result = await runReminderDeliveryTick(deps, OPTS)
      expect(result).toMatchObject({ failed: 1, sent: 0 })
      expect(docSends).toHaveLength(0)
      expect(calls.map((c) => c.name)).not.toContain('reminder_mark_dispatch')
      expect(finishesOf(calls)).toEqual([{ status: 'failed', error: reason }])
    }
  })

  test('a lease exhausted by preparation ABANDONS the row: no marker, no finish, no send', async () => {
    const STALE_ROW: ReminderClaimRow = {
      ...ROW, id: 'occ-r', kind: 'product_report', report_currency: 'USD',
      lease_until: new Date(Date.now() - 1_000).toISOString(),
    }
    const { deps, calls, docSends } = makeDeps({ claim: { data: [STALE_ROW] } })
    const result = await runReminderDeliveryTick(deps, OPTS)
    expect(result).toMatchObject({ claimed: 1, sent: 0, failed: 0, skipped: 0 })
    expect(docSends).toHaveLength(0)
    const names = calls.map((c) => c.name)
    expect(names).not.toContain('reminder_mark_dispatch')
    expect(names).not.toContain('reminder_finish') // reclaim retries with a fresh lease
  })

  test('an ambiguous DOCUMENT send is terminal unknown — a file is never re-sent on a maybe', async () => {
    const REPORT_ROW: ReminderClaimRow = {
      ...ROW, id: 'occ-r', kind: 'product_report', report_currency: 'USD',
      lease_until: new Date(Date.now() + 300_000).toISOString(),
    }
    const { deps, calls } = makeDeps({ claim: { data: [REPORT_ROW] }, docSend: { ok: false, kind: 'ambiguous' } })
    expect(await runReminderDeliveryTick(deps, OPTS)).toMatchObject({ unknown: 1, sent: 0 })
    expect(finishesOf(calls)).toEqual([{ status: 'unknown', error: 'send_ambiguous' }])
  })

  test('a CPU-bound build that outruns the timer is caught by the post-build checkpoint — success and refusal alike', async () => {
    for (const buildResult of [undefined, { ok: false as const, reason: 'x' }]) {
      const nowRef = { value: 1_000_000 }
      const REPORT_ROW: ReminderClaimRow = {
        ...ROW, id: 'occ-r', kind: 'product_report', report_currency: 'USD',
        lease_until: new Date(Date.now() + 300_000).toISOString(),
      }
      const { deps, calls, docSends } = makeDeps({
        claim: { data: [REPORT_ROW] },
        nowRef,
        buildResult,
        buildSideEffect: () => { nowRef.value += 10_000 }, // the build ate the whole 5s budget
      })
      const result = await runReminderDeliveryTick(deps, OPTS)
      expect(result.timedOut).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 40))
      const names = calls.map((c) => c.name)
      expect(names).not.toContain('reminder_mark_dispatch')
      expect(names).not.toContain('reminder_finish')
      expect(docSends).toHaveLength(0)
    }
  })

  test('caption facts: Tashkent day for the upload stamp, declared-period wording', () => {
    expect(tashkentDateOf('2028-03-31T20:00:00Z')).toBe('2028-04-01') // +05:00 crosses midnight
    const caption = composeReportCaption('Отчёт', {
      file_sha256: 'f'.repeat(64), file_name: 'март.xlsx',
      period_month: '2028-03', uploaded_at: '2028-03-31T20:00:00Z', currency: 'USD',
    }, { from: '2028-03-01', to: '2028-03-30' })
    expect(caption).toContain('Заявленный период / E’lon qilingan davr: 2028-03, USD')
    expect(caption).toContain('Загружено / Yuklangan: 01.04.2028')
    expect(caption).toContain('Полнота периода не проверяется')
  })

  test('recover runs first; the claim carries the same lower bound', async () => {
    const { deps, calls } = makeDeps({ recover: { data: 3 }, claim: { data: [] } })
    expect(await runReminderDeliveryTick(deps, OPTS)).toMatchObject({ recovered: 3, claimed: 0 })
    expect(calls[0].name).toBe('reminder_recover')
    expect(calls[0].args.p_expire_before).toBe('2026-09-27') // today minus the 3-day catch-up window
    expect(calls[1].name).toBe('reminder_claim_due')
    expect(calls[1].args.p_min_due_date).toBe('2026-09-27') // stale rows structurally unclaimable
  })

  test('a FAILED recovery fails the tick CLOSED: nothing is claimed, nothing can send', async () => {
    const errored = makeDeps({ recover: { error: new Error('db') }, claim: { data: [ROW] } })
    expect(await runReminderDeliveryTick(errored.deps, OPTS)).toMatchObject({ recoverFailed: true, claimed: 0, sent: 0 })
    expect(errored.calls.map((c) => c.name)).toEqual(['reminder_recover']) // claim never dispatched
    expect(errored.sends).toHaveLength(0)

    const thrown = makeDeps({ claim: { data: [ROW] } })
    thrown.deps.rpc = async (name) => { if (name === 'reminder_recover') throw new Error('boom'); return { data: [] } }
    expect(await runReminderDeliveryTick(thrown.deps, OPTS)).toMatchObject({ recoverFailed: true, claimed: 0 })
    expect(thrown.sends).toHaveLength(0)
  })

  test('a finish that does not persist is reported as finishFailed, never as a completed transition', async () => {
    // the send happened, but the terminal write did not land — the row stays leased and the
    // lease expiry will close it; the tick must not claim a durable 'sent'
    const { deps, calls } = makeDeps({ claim: { data: [ROW] }, finishResults: [{ data: false }] })
    expect(await runReminderDeliveryTick(deps, OPTS)).toMatchObject({ sent: 0, finishFailed: 1 })
    expect(finishesOf(calls)).toEqual([{ status: 'sent', error: null }])

    const errored = makeDeps({ claim: { data: [ROW] }, finishResults: [{ error: new Error('db') }] })
    expect(await runReminderDeliveryTick(errored.deps, OPTS)).toMatchObject({ sent: 0, finishFailed: 1 })
  })
})
