// Worker-side glue for the reminder kinds — extracted from the wrapper so the branch logic is
// offline-testable with fakes (the wrapper keeps only the secret gate and the kind allowlist).
//   • reminder-plan is BOUNDED: a hung planning RPC answers plan_failed within its own budget
//     instead of leaving the worker pending; thrown errors surface no raw details;
//   • reminder-drain wires the reviewed tick with the per-account external-action guard
//     (synthetic accounts never reach real Telegram) and a tenant-scoped telegram-typed
//     credential read; sends stay behind the default-OFF kill switch.
import {
  runReminderDeliveryTick,
  type FrozenSource, type ReminderDeliveryDeps, type ReminderSendResult, type ReminderTickResult,
} from './reminderDelivery.ts'
import { readBytesBounded } from './boundedBody.ts'
import { MONTHLY_XLSX_LIMITS, parseSourceXlsx } from './xlsxSource.ts'
import { monthlyReportPeriod } from './calendarPeriod.ts'
import { filterSourcePeriod } from './sourcePeriodFilter.ts'
import { DocumentSourceError } from './documentSourceError.ts'
import { computeProductMargin } from './productMargin.ts'
import { marginReportToXlsx } from './marginReportExport.ts'
export type DocumentFetch = (url: string, init: { method: 'POST'; body: FormData; signal: AbortSignal; redirect: 'error' }) => Promise<Response>

export interface ReminderWorkerDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase service-role client shape
  admin: any
  send: ReminderDeliveryDeps['send']
  blocksExternal: (accountId: string) => Promise<boolean>
  killSwitch: string
  /** product_report: streamed read of the retained upload; wired by the wrapper to the bucket. */
  getSourceFile?: ReminderDeliveryDeps['getSourceFile']
  /** product_report: real fetch for the document send; tests inject fakes. */
  fetchImpl?: DocumentFetch
  now?: () => number
}

/**
 * The monthly document, built PER OCCURRENCE in memory from the frozen snapshot — the shared
 * margin-reports artifact is deliberately NOT reused: this workbook carries its own declared
 * period, coverage, as-of moment and source sha INSIDE the file, so a later rename, registry
 * redeclaration or ordinary chat rerun cannot change what this document says about itself.
 */
export function buildProductReportDocument(
  bytes: Uint8Array,
  snapshot: FrozenSource & { occurrenceId: string; title: string; due_date: string },
): { ok: true; xlsx: Uint8Array } | { ok: false; reason: string } {
  const period = monthlyReportPeriod(snapshot.period_month, snapshot.due_date)
  if (!period) return { ok: false, reason: 'invalid_period' }
  try {
  const parsed = parseSourceXlsx(bytes, MONTHLY_XLSX_LIMITS)
  const selected = filterSourcePeriod({ id: 'S1', data: parsed }, period)
  if (selected.issues.length) return { ok: false, reason: 'needs_source_dates' }
  if (!selected.mapped) return { ok: false, reason: 'no_recognized_sheets' }
  if (!selected.included) return { ok: false, reason: 'no_rows_period' }
  const report = computeProductMargin({ sheets: selected.sheets, issues: [] }, {
    currency: snapshot.currency, fileName: snapshot.file_name, fileSha256: snapshot.file_sha256,
  })
  if (!report.ok) return { ok: false, reason: report.reason }
  return {
    ok: true,
    xlsx: marginReportToXlsx(report, [
      ['monthly_report', snapshot.title],
      ['reporting_period_declared', snapshot.period_month, 'coverage', 'not_verified'],
      ['date_filter_from', period.from, 'date_filter_to_inclusive', period.to],
      ['date_basis', 'source_calendar_days', 'excel_date_system', parsed.dateSystem],
      ['formula_values', 'saved_cache_not_recalculated', 'duplicates', 'not_removed'],
      ['uploaded_at', snapshot.uploaded_at, 'source_sha256', snapshot.file_sha256],
      ['occurrence', snapshot.occurrenceId],
    ], [
      { name: 'Date audit', rows: [
        ['source_sha256', snapshot.file_sha256],
        ['sheet', 'row', 'column', 'source_date', 'calendar_date', 'decision'],
        ...selected.audit.map((r) => [r.sheet, r.row ?? null, r.column ?? '', r.raw ?? '', r.date ?? '', r.decision]),
      ] },
      { name: 'Source data', rows: sourceWorkbookRows(parsed.sheets, snapshot.file_sha256) },
    ]),
  }
  } catch (error) {
    return { ok: false, reason: error instanceof DocumentSourceError ? `source_${error.code}` : 'source_unreadable' }
  }
}

/** Typed text with parts: long cells remain reconstructable without Excel's cell truncation. */
function sourceWorkbookRows(sheets: ReturnType<typeof parseSourceXlsx>['sheets'], sha: string): Array<Array<string | number | null>> {
  const rows: Array<Array<string | number | null>> = [['source_sha256', sha], ['sheet', 'row', 'part', 'parts', 'encoding', 'cells_json']]
  for (const sheet of sheets) for (const row of sheet.rows) {
    const parts: string[] = []
    let value = ''
    for (const char of JSON.stringify(row.cells)) { if (value.length + char.length > 32000) { parts.push(value); value = '' }; value += char }
    parts.push(value)
    for (const [index, part] of parts.entries()) rows.push([sheet.name, row.rowIndex, index + 1, parts.length, 'json-concatenate-parts', part])
  }
  return rows
}

/** Telegram sendDocument with the same definite/ambiguous semantics as the message sender. */
export function createTelegramDocumentSender(
  fetchImpl: DocumentFetch,
  options: { timeoutMs?: number; now?: () => number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const nowMs = options.now ?? (() => Date.now())
  return async (token: string, chatId: string, caption: string, fileName: string, bytes: Uint8Array): Promise<ReminderSendResult> => {
    // ONE absolute deadline covers the whole send, response body read included — never the
    // request budget plus a fresh allowance for the body
    const deadlineAt = nowMs() + timeoutMs
    const controller = new AbortController()
    let expire: (error: Error) => void = () => {}
    const expired = new Promise<never>((_resolve, reject) => { expire = reject })
    expired.catch(() => {})
    const timer = setTimeout(() => { controller.abort(); expire(new Error('SEND_TIMEOUT')) }, timeoutMs)
    try {
      const form = new FormData()
      form.append('chat_id', chatId)
      form.append('caption', caption.slice(0, 1024))
      form.append('document', new Blob(
        [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      ), fileName)
      const response = await Promise.race([
        fetchImpl(`https://api.telegram.org/bot${token}/sendDocument`, {
          method: 'POST', body: form, signal: controller.signal, redirect: 'error',
        }),
        expired,
      ])
      const read = await readBytesBounded(
        { headers: { get: () => null }, body: response.body },
        { maxBytes: 64 * 1024, deadlineAt, now: nowMs },
      )
      if (!read.ok) return { ok: false, kind: 'ambiguous' }
      const data = ((): { ok?: boolean; result?: { message_id?: number } } | null => {
        try { return JSON.parse(new TextDecoder().decode(read.bytes)) } catch { return null }
      })()
      // the clock can cross the deadline between the reader's pre-read check and here (busy
      // microtasks beat the timer macrotask): a completion we can no longer claim within the
      // bound is conservatively UNKNOWN — the message may well have been delivered
      if (nowMs() >= deadlineAt) return { ok: false, kind: 'ambiguous' }
      const messageId = data?.result?.message_id
      // a "success" without a plausible id is not a success we can record: message_id must be
      // a POSITIVE safe integer (Telegram never issues 0 or negatives)
      if (data?.ok === true && typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0) {
        return { ok: true, messageId }
      }
      if (data && data.ok === false) return { ok: false, kind: 'rejected' }
      return { ok: false, kind: 'ambiguous' }
    } catch {
      return { ok: false, kind: 'ambiguous' }
    } finally {
      clearTimeout(timer)
    }
  }
}

export type ReminderWorkerResult =
  | { status: number; body: { ok: false; kind: string; error: string } }
  | { status: 200; body: { ok: true; kind: 'reminder-plan'; planned: number } }
  | { status: 200; body: { ok: true; kind: 'reminder-drain'; tick: ReminderTickResult } }

export async function runReminderWorkerKind(
  deps: ReminderWorkerDeps,
  kind: 'reminder-plan' | 'reminder-drain',
  options: { todayTashkent: string; planBudgetMs?: number; drainBudgetMs?: number },
): Promise<ReminderWorkerResult> {
  const nowMs = deps.now ?? (() => Date.now())

  if (kind === 'reminder-plan') {
    // planning writes occurrences+tasks but sends nothing; still BOUNDED — a hung RPC must
    // answer, not hold the worker until the platform kills it
    const budgetMs = Math.max(1, options.planBudgetMs ?? 30_000)
    let expire: (error: Error) => void = () => {}
    const expired = new Promise<never>((_resolve, reject) => { expire = reject })
    expired.catch(() => {})
    const timer = setTimeout(() => expire(new Error('REMINDER_PLAN_TIMEOUT')), budgetMs)
    try {
      const inner = Promise.resolve(deps.admin.rpc('reminder_plan_occurrences', {
        p_today: options.todayTashkent, p_catchup_days: 3,
      })) as Promise<{ data?: unknown; error?: unknown }>
      inner.catch(() => {})
      const { data, error } = await Promise.race([inner, expired])
      if (error) return { status: 503, body: { ok: false, kind, error: 'plan_failed' } }
      return { status: 200, body: { ok: true, kind, planned: Number(data) || 0 } }
    } catch {
      // timeout or a thrown client error — same fixed slug, no raw details leave the worker
      return { status: 503, body: { ok: false, kind, error: 'plan_failed' } }
    } finally {
      clearTimeout(timer)
    }
  }

  const tick = await runReminderDeliveryTick({
    rpc: (name, args) => Promise.resolve(deps.admin.rpc(name, args)),
    // tenant-scoped, TYPE-pinned credential read: another account's channel id — or a
    // non-telegram channel — resolves to nothing
    getChannelToken: async (channelId, accountId) => {
      const { data, error } = await deps.admin.from('channels').select('credentials')
        .eq('id', channelId).eq('account_id', accountId).eq('type', 'telegram').maybeSingle()
      if (error) return null
      const token = data?.credentials?.bot_token
      return typeof token === 'string' && token ? token : null
    },
    send: deps.send,
    blocksExternal: deps.blocksExternal,
    getSourceFile: deps.getSourceFile,
    buildReport: buildProductReportDocument,
    sendDocument: deps.fetchImpl ? createTelegramDocumentSender(deps.fetchImpl) : undefined,
    now: nowMs,
  }, {
    budgetMs: Math.max(1, options.drainBudgetMs ?? 100_000),
    killSwitch: deps.killSwitch.toLowerCase(),
    todayTashkent: options.todayTashkent,
  })
  return { status: 200, body: { ok: true, kind: 'reminder-drain', tick } }
}
