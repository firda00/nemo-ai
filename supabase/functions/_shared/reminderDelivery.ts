// Monthly-reminder delivery tick — the TS half of the reminders outbox (Plan B foundation).
// Injected and offline-testable; the worker wrapper (next stage, after review) wires the real
// admin client and createTelegramSender.
//
// Protocol invariants (mirrors the reviewed briefing delivery):
//   • the kill switch is DEFAULT OFF: no explicit REMINDER_DELIVERY=on, no sends at all;
//   • the SQL claim is the due gate — the tick never invents rows and never sends early;
//   • the message is composed BEFORE the dispatch marker; the send goes ONLY to the snapshot
//     the marker returned, with the token fetched after the marker;
//   • one wall-clock budget covers every await, with a checkpoint (flag AND clock — a busy
//     microtask chain can outrun the timer macrotask) before every side effect;
//   • after dispatched_at is set there is NO path back to planned: a definite local failure
//     (no token, Telegram rejected) finishes 'failed', an ambiguous send finishes 'unknown' —
//     never resent; pre-dispatch stalls simply let the lease expire for the next tick.
import { monthlyReportPeriod, type DocumentPeriod } from './calendarPeriod.ts'

export interface ReminderClaimRow {
  id: string
  account_id: string
  schedule_id: string
  due_date: string
  due_at: string
  lease_token: string
  lease_until?: string
  attempt_count: number
  title: string
  kind?: string
  report_currency?: string | null
  source_file_sha256?: string | null
}

/** The occurrence-frozen source snapshot the freeze RPC returns — never re-read from the registry. */
export interface FrozenSource {
  file_sha256: string
  file_name: string
  period_month: string
  uploaded_at: string
  currency: string
}

export type ReminderSendResult =
  | { ok: true; messageId: number }
  | { ok: false; kind: 'rejected' | 'retriable' | 'ambiguous' }

export interface ReminderDeliveryDeps {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data?: unknown; error?: unknown }>
  getChannelToken: (channelId: string, accountId: string) => Promise<string | null>
  send: (token: string, chatId: string, text: string) => Promise<ReminderSendResult>
  /**
   * Per-account external-action guard (production-E2E / synthetic accounts). Checked BEFORE the
   * dispatch marker; a guard failure counts as BLOCKED — a synthetic account must never reach
   * a real Telegram send on a guard outage.
   */
  blocksExternal?: (accountId: string) => Promise<boolean>
  /** product_report only: streamed read of the retained source upload (tenant-scoped path). */
  getSourceFile?: (accountId: string, fileSha256: string) => Promise<{ bytes?: Uint8Array; error?: string }>
  /** product_report only: deterministic engine run + workbook build with the FROZEN snapshot inside. */
  buildReport?: (bytes: Uint8Array, snapshot: FrozenSource & { occurrenceId: string; title: string; due_date: string }) =>
    { ok: true; xlsx: Uint8Array } | { ok: false; reason: string }
  /** product_report only: bounded multipart document send. */
  sendDocument?: (token: string, chatId: string, caption: string, fileName: string, bytes: Uint8Array) => Promise<ReminderSendResult>
  /** injected for tests; defaults to WebCrypto sha256 */
  hashBytes?: (bytes: Uint8Array) => Promise<string>
  now?: () => number
}

export interface ReminderTickResult {
  disabled?: boolean
  /** recovery did not run to completion — the tick fails CLOSED and claims nothing */
  recoverFailed?: boolean
  timedOut: boolean
  recovered: number
  claimed: number
  sent: number
  failed: number
  skipped: number
  unknown: number
  /** finish transitions that did NOT durably persist (lease expiry will close those rows) */
  finishFailed: number
}

const DEADLINE_ERR = 'REMINDER_TICK_TIMEOUT'
const CLAIM_LIMIT = 10
const LEASE_SECONDS = 120
/** Well inside Telegram's 50MB bot document limit; our sources are ≤15MB anyway. */
export const MAX_REPORT_DOCUMENT_BYTES = 20 * 1024 * 1024
/** Do not START marking/sending with less than this much lease left — prepare may have eaten it. */
const LEASE_SAFETY_MS = 2_000

/** Deterministic bilingual message: the title is the user's own text; the date is factual. */
export function composeReminderMessage(title: string, dueDate: string): string {
  const [year, month, day] = dueDate.split('-')
  const stamp = `${day}.${month}.${year}`
  return `🔔 Напоминание / Eslatma (${stamp})\n${title}`
}

const dot = (isoDate: string) => {
  const [year, month, day] = isoDate.slice(0, 10).split('-')
  return `${day}.${month}.${year}`
}

/** The Tashkent calendar day of a timestamp (fixed +05:00, no DST). */
export const tashkentDateOf = (iso: string): string =>
  new Date(Date.parse(iso) + 5 * 3600 * 1000).toISOString().slice(0, 10)

/**
 * Document caption: only FACTS. The period is the USER'S declaration, the timestamp is when
 * the file was UPLOADED (Tashkent day) — data completeness is never inferred from either: an
 * old partial workbook can be uploaded after month end, so no full-month claim is ever made.
 */
export function composeReportCaption(title: string, source: FrozenSource, period: DocumentPeriod): string {
  return [
    `📊 ${title}`,
    `Файл / Fayl: ${source.file_name}`,
    `Заявленный период / E’lon qilingan davr: ${source.period_month}, ${source.currency}`,
    `Отбор дат / Sana filtri: ${period.from} — ${period.to} (включительно / ikkala sana ham).`,
    `Загружено / Yuklangan: ${dot(tashkentDateOf(source.uploaded_at))}. Полнота периода не проверяется — данные как в файле / Davr to‘liqligi tekshirilmaydi.`,
  ].join('\n')
}

export async function runReminderDeliveryTick(
  deps: ReminderDeliveryDeps,
  options: { budgetMs: number; killSwitch: string; todayTashkent: string },
): Promise<ReminderTickResult> {
  const result: ReminderTickResult = { timedOut: false, recovered: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, unknown: 0, finishFailed: 0 }
  // default OFF: an unset or mistyped switch means NO sends — never "probably on"
  if (options.killSwitch !== 'on') return { ...result, disabled: true }

  const nowMs = deps.now ?? (() => Date.now())
  const deadlineAt = nowMs() + Math.max(1, options.budgetMs)
  const state = { expired: false }
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => { state.expired = true; expire(new Error(DEADLINE_ERR)) }, Math.max(0, deadlineAt - nowMs()))
  const checkpoint = () => {
    if (state.expired || nowMs() >= deadlineAt) { state.expired = true; throw new Error(DEADLINE_ERR) }
  }
  const race = <T>(inner: Promise<T>): Promise<T> => {
    inner.catch(() => {}) // the loser must never surface as unhandled
    return Promise.race([inner, expired])
  }

  // durable-or-counted: a finish whose row did not persist must not be reported as a
  // completed transition — the lease expiry closes such rows on a later tick
  const finish = async (row: ReminderClaimRow, status: string, messageId: number | null, error: string | null): Promise<boolean> => {
    const outcome = await race(deps.rpc('reminder_finish', {
      p_occurrence_id: row.id, p_lease_token: row.lease_token,
      p_status: status, p_message_id: messageId, p_error: error,
    }).catch((thrown) => ({ data: undefined, error: thrown })))
    if (outcome.error || outcome.data !== true) { result.finishFailed += 1; return false }
    return true
  }

  try {
    // recovery first — and FAIL CLOSED on its failure: without recovery, stale rows have not
    // been retired, so claiming would be able to pick candidates recovery meant to close
    const expireBefore = shiftDate(options.todayTashkent, -3)
    const recovered = await race(deps.rpc('reminder_recover', {
      p_now: new Date(nowMs()).toISOString(), p_expire_before: expireBefore,
    }).catch((thrown) => ({ data: undefined, error: thrown })))
    if (recovered.error) return { ...result, recoverFailed: true }
    result.recovered = Number(recovered.data) || 0
    checkpoint()

    // the claim carries its own lower bound too: even if a future edit dropped the fail-closed
    // rule above, rows older than the catch-up window stay structurally unclaimable
    const claimed = await race(deps.rpc('reminder_claim_due', {
      p_now: new Date(nowMs()).toISOString(), p_min_due_date: expireBefore,
      p_limit: CLAIM_LIMIT, p_lease_seconds: LEASE_SECONDS,
    }))
    checkpoint()
    if (claimed.error || !Array.isArray(claimed.data)) return result
    const rows = claimed.data as ReminderClaimRow[]
    result.claimed = rows.length

    for (const row of rows) {
      checkpoint()
      // external-action guard BEFORE the marker: a synthetic/test account must never send to
      // real Telegram, and its occurrence closes visibly instead of retrying forever
      if (deps.blocksExternal) {
        const blocked = await race(deps.blocksExternal(row.account_id).catch(() => true))
        checkpoint()
        if (blocked) {
          if (await finish(row, 'skipped', null, 'external_blocked')) result.skipped += 1
          continue
        }
      }
      // PREPARE everything BEFORE the marker: after dispatched_at is set, every remaining step
      // is send-only. For a product_report that includes freezing the source snapshot, reading
      // and verifying the file, and building the workbook — a doomed report fails here, visibly,
      // without spending a dispatch.
      let payload:
        | { type: 'message'; text: string }
        | { type: 'document'; caption: string; fileName: string; bytes: Uint8Array }
      if (row.kind === 'product_report') {
        const frozenCall = await race(deps.rpc('reminder_freeze_source', {
          p_occurrence_id: row.id, p_lease_token: row.lease_token,
        }))
        checkpoint()
        const frozen = (frozenCall.data ?? null) as ({ ok?: boolean; reason?: string } & Partial<FrozenSource>) | null
        if (frozenCall.error || !frozen || frozen.ok !== true) {
          const reason = frozen?.reason ?? 'freeze_failed'
          if (reason === 'lease_lost' || frozenCall.error) continue // no fence we still hold
          if (reason === 'source_missing_period') {
            // the visible failure the review demanded: no file declared for THIS month
            if (await finish(row, 'failed', null, 'source_missing_period')) result.failed += 1
          } else if (await finish(row, 'skipped', null, reason)) result.skipped += 1
          continue
        }
        const snapshot = frozen as FrozenSource
        const period = monthlyReportPeriod(snapshot.period_month, row.due_date)
        if (!period) {
          if (await finish(row, 'failed', null, 'engine_invalid_period')) result.failed += 1
          continue
        }
        if (!deps.getSourceFile || !deps.buildReport || !deps.sendDocument) {
          if (await finish(row, 'failed', null, 'report_unsupported')) result.failed += 1
          continue
        }
        const file = await race(deps.getSourceFile(row.account_id, snapshot.file_sha256))
        checkpoint()
        if (file.error || !file.bytes) {
          if (await finish(row, 'failed', null, 'source_read_failed')) result.failed += 1
          continue
        }
        const hash = await race((deps.hashBytes ?? defaultHashBytes)(file.bytes))
        checkpoint()
        if (hash !== snapshot.file_sha256) {
          if (await finish(row, 'failed', null, 'source_integrity')) result.failed += 1
          continue
        }
        const built = deps.buildReport(file.bytes, { ...snapshot, occurrenceId: row.id, title: row.title, due_date: row.due_date })
        // the build is CPU-bound and synchronous: the wall clock may have crossed the deadline
        // while the timer callback never got to run — checkpoint BEFORE any finish/mark side
        // effect, success and refusal alike
        checkpoint()
        if (!built.ok) {
          if (await finish(row, 'failed', null, `engine_${built.reason}`.slice(0, 60))) result.failed += 1
          continue
        }
        if (built.xlsx.byteLength > MAX_REPORT_DOCUMENT_BYTES) {
          if (await finish(row, 'failed', null, 'document_too_large')) result.failed += 1
          continue
        }
        payload = {
          type: 'document',
          caption: composeReportCaption(row.title, snapshot, period),
          fileName: `report-${snapshot.period_month}.xlsx`,
          bytes: built.xlsx,
        }
      } else {
        payload = { type: 'message', text: composeReminderMessage(row.title, row.due_date) }
      }
      // if preparation ate the lease, do NOT start the marker — the reclaim path retries with a
      // fresh lease instead of dispatching on a fence about to vanish
      if (row.lease_until && nowMs() >= new Date(row.lease_until).getTime() - LEASE_SAFETY_MS) continue
      const marked = await race(deps.rpc('reminder_mark_dispatch', {
        p_occurrence_id: row.id, p_lease_token: row.lease_token,
      }))
      checkpoint()
      const marker = (marked.data ?? null) as { ok?: boolean; reason?: string; channel_id?: string; chat_id?: string } | null
      if (marked.error || !marker || marker.ok !== true) {
        // consent/revision/lease said no — close THIS occurrence honestly and move on
        const reason = marker?.reason ?? 'mark_failed'
        if (!marked.error && marker && marker.reason && marker.reason !== 'lease_lost') {
          if (await finish(row, 'skipped', null, reason)) result.skipped += 1
        }
        continue
      }
      // token AFTER the marker, send ONLY to the snapshot the marker returned
      const token = await race(deps.getChannelToken(String(marker.channel_id), row.account_id))
      checkpoint()
      if (!token) {
        // dispatched but definitely NOT sent — terminal failure, never a resend
        if (await finish(row, 'failed', null, 'token_unavailable')) result.failed += 1
        continue
      }
      const sendResult = payload.type === 'document'
        ? await race(deps.sendDocument!(token, String(marker.chat_id), payload.caption, payload.fileName, payload.bytes))
        : await race(deps.send(token, String(marker.chat_id), payload.text))
      checkpoint()
      if (sendResult.ok) {
        if (await finish(row, 'sent', sendResult.messageId, null)) result.sent += 1
      } else if (sendResult.kind === 'rejected') {
        if (await finish(row, 'failed', null, 'telegram_rejected')) result.failed += 1
      } else {
        // retriable-or-ambiguous AFTER dispatch is the same thing: the outcome is unknown and
        // the reminder must never be sent twice on a maybe
        if (await finish(row, 'unknown', null, 'send_ambiguous')) result.unknown += 1
      }
    }
    return result
  } catch (error) {
    if (error instanceof Error && error.message === DEADLINE_ERR) {
      // unfinished claims simply let their lease expire; recovery closes them next tick
      return { ...result, timedOut: true }
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

function shiftDate(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

async function defaultHashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
