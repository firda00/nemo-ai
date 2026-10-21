// Daily-briefing delivery engine — Step 2b. Pure and injected (db, fetch, sender, clock) so the
// whole state machine is testable offline. The worker function only wires real dependencies.
//
// Invariants (both Codex review rounds, encoded here and in the RPCs):
//   • ONE invocation deadline covers EVERYTHING — every RPC, settings/channel read, compose
//     source wait and the send itself race it, and claiming stops early enough to leave the
//     finish RPCs their reserve. A drain tick continues the queue; no invocation outlives the
//     edge runtime.
//   • preparation is gated on the Tashkent due time (08:30 / 20:00): a 00:10 drain recovers and
//     closes stale runs, it can NEVER invent or send today's briefings early.
//   • a send happens ONLY after briefing_mark_dispatch returned ok — the marker atomically
//     re-validates the CURRENT consent and snapshots channel/chat/revision; the send goes to the
//     SNAPSHOT, never to whatever the settings say a moment later.
//   • pre-dispatch infrastructure errors leave the row retriable (no finish, lease expiry
//     re-claims); definite refusals finish as 'skipped'; a definite Telegram rejection is
//     terminal 'failed' (no retry on an invalid recipient); an ambiguous send is terminal
//     'unknown' and is NEVER resent — recovery converts expired dispatched leases the same way.
import {
  CALENDAR_SOURCE,
  CBU_SOURCE,
  WEATHER_SOURCE,
  fetchCbuUsdRate,
  fetchNewsHeadlines,
  fetchOpenWeather,
  newsSection,
  tashkentDateString,
  type CalendarSection,
  type FetchLike,
  type UsdRateSection,
  type WeatherSection,
} from './dailyBriefingSources.ts'
import { composeEveningBriefing, composeMorningBriefing, type BriefingLang } from './dailyBriefing.ts'
import { buildEveningTasksSection, buildYesterdayOutcome } from './dailyBriefingHandler.ts'

export type SendOutcome =
  | { status: 'sent'; messageId: number }
  | { status: 'rejected'; detail: string }
  | { status: 'ambiguous' }

export interface DeliveryDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase service-role client shape
  admin: any
  fetchImpl: FetchLike
  openWeatherKey: string
  calendarSection: (accountId: string, date: string) => Promise<CalendarSection>
  sendMessage: (botToken: string, chatId: string, text: string) => Promise<SendOutcome>
  blocksExternal?: (accountId: string) => Promise<boolean>
  now?: () => Date
  /** Whole-invocation wall budget (default 100s, ≤120s); the drain tick picks up the rest. */
  budgetMs?: number
  batchSize?: number
}

export interface DeliverySummary {
  kind: string
  date: string
  prepared: number
  recovered: number
  claimed: number
  sent: number
  failed: number
  skipped: number
  unknown: number
  retriable: number
  stoppedByBudget: boolean
}

const MESSAGE_LIMIT = 3800
const FINISH_RESERVE_MS = 10_000
const MORNING_DUE_MINUTES = 8 * 60 + 30 // 08:30 Tashkent
const EVENING_DUE_MINUTES = 20 * 60 // 20:00 Tashkent

interface RunRow { id: string; account_id: string; kind: 'morning' | 'evening'; lease_token: string }

interface TickBudget {
  expired: Promise<never>
  finish: () => void
  remainingMs: () => number
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

function openTickBudget(timeoutMs: number): TickBudget {
  const deadlineAt = Date.now() + timeoutMs
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => expire(new Error('BRIEFING_TICK_TIMEOUT')), timeoutMs)
  return { expired, finish: () => clearTimeout(timer), remainingMs: () => deadlineAt - Date.now() }
}

/** Minutes since Tashkent midnight (fixed UTC+5). */
function tashkentMinutes(now: Date): number {
  const shifted = new Date(now.getTime() + 5 * 3_600_000)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

export function dueReached(kind: 'morning' | 'evening', now: Date): boolean {
  return tashkentMinutes(now) >= (kind === 'morning' ? MORNING_DUE_MINUTES : EVENING_DUE_MINUTES)
}

/** Constant-time string compare for the worker's cron secret. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bytesA = new TextEncoder().encode(a)
  const bytesB = new TextEncoder().encode(b)
  let diff = bytesA.length ^ bytesB.length
  const length = Math.max(bytesA.length, bytesB.length)
  for (let i = 0; i < length; i += 1) diff |= (bytesA[i % Math.max(1, bytesA.length)] ?? 0) ^ (bytesB[i % Math.max(1, bytesB.length)] ?? 0)
  return diff === 0
}

const MAX_SEND_BODY_BYTES = 64 * 1024

// Streamed, capped response read: an oversized or stalled Telegram body must neither be
// buffered whole nor outlive the sender deadline. Cleanup is fire-and-forget.
async function readBoundedBody(response: Response, expired: Promise<never>): Promise<string> {
  const body = response.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), expired])
        if (done) break
        total += value.byteLength
        if (total > MAX_SEND_BODY_BYTES) throw new Error('SEND_BODY_TOO_LARGE')
        chunks.push(value)
      }
    } catch (error) {
      void reader.cancel().catch(() => {})
      throw error
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(merged)
  }
  const text = await Promise.race([response.text(), expired])
  if (new TextEncoder().encode(text).byteLength > MAX_SEND_BODY_BYTES) throw new Error('SEND_BODY_TOO_LARGE')
  return text
}

/** Telegram sender with definite/ambiguous outcome semantics; one deadline covers body read. */
export function createTelegramSender(fetchImpl: FetchLike): DeliveryDeps['sendMessage'] {
  return async (botToken, chatId, text) => {
    const controller = new AbortController()
    let expire: (error: Error) => void = () => {}
    const expired = new Promise<never>((_resolve, reject) => { expire = reject })
    expired.catch(() => {})
    const timer = setTimeout(() => { controller.abort(); expire(new Error('SEND_TIMEOUT')) }, 10_000)
    try {
      const response = await Promise.race([
        fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: controller.signal,
          redirect: 'error',
        }),
        expired,
      ])
      const bodyText = await readBoundedBody(response, expired)
      const data = ((): { ok?: boolean; result?: { message_id?: number }; description?: string } | null => {
        try { return JSON.parse(bodyText) } catch { return null }
      })()
      if (data?.ok === true && typeof data.result?.message_id === 'number') {
        return { status: 'sent', messageId: data.result.message_id }
      }
      // a parseable refusal is DEFINITE: the message did not go out
      if (data && data.ok === false) return { status: 'rejected', detail: String(data.description ?? 'rejected').slice(0, 120) }
      return { status: 'ambiguous' }
    } catch {
      // network death after dispatch: the message may or may not have been delivered
      return { status: 'ambiguous' }
    } finally {
      clearTimeout(timer)
    }
  }
}

const LANGS = new Set<BriefingLang>(['uz', 'ru', 'en'])

async function rpc(deps: DeliveryDeps, budget: TickBudget, name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
  try {
    return await Promise.race([deps.admin.rpc(name, args), budget.expired])
  } catch (error) {
    return { data: null, error }
  }
}

async function composeForAccount(
  deps: DeliveryDeps,
  kind: 'morning' | 'evening',
  accountId: string,
  date: string,
  lang: BriefingLang,
  coords: { lat: number | null; lon: number | null },
): Promise<string> {
  const now = deps.now ?? (() => new Date())
  if (kind === 'evening') {
    const tasks = await buildEveningTasksSection(deps.admin, accountId, date, now)
    return composeEveningBriefing({ lang, dateLabel: date, tasks })
  }
  const unavailable = (source: string, detail: string) => ({ status: 'unavailable' as const, source, fetchedAt: now().toISOString(), detail })
  const [usd, weather, calendar, news, yesterdayOutcome] = await Promise.all([
    fetchCbuUsdRate(deps.fetchImpl, { date, now }).catch<UsdRateSection>(() => unavailable(CBU_SOURCE, 'network')),
    (async (): Promise<WeatherSection> => {
      if (coords.lat === null || coords.lon === null) return unavailable(WEATHER_SOURCE, 'no_coordinates')
      if (!deps.openWeatherKey) return unavailable(WEATHER_SOURCE, 'missing_key')
      return fetchOpenWeather(deps.fetchImpl, { lat: coords.lat, lon: coords.lon, apiKey: deps.openWeatherKey, lang, now })
        .catch<WeatherSection>(() => unavailable(WEATHER_SOURCE, 'network'))
    })(),
    deps.calendarSection(accountId, date).catch<CalendarSection>(() => unavailable(CALENDAR_SOURCE, 'network')),
    fetchNewsHeadlines(deps.fetchImpl, { now }).catch(() => newsSection(now)),
    buildYesterdayOutcome(deps.admin, accountId, date),
  ])
  return composeMorningBriefing({ lang, dateLabel: date, sections: { usd, weather, calendar, news }, yesterdayOutcome })
}

export async function runDeliveryTick(
  deps: DeliveryDeps,
  options: { kind: 'morning' | 'evening' | 'drain' },
): Promise<DeliverySummary[]> {
  // ONE budget for the whole invocation — a drain covering two kinds shares it, never 2×.
  const budget = openTickBudget(clampInt(deps.budgetMs, 100_000, 1, 120_000))
  try {
    const kinds: Array<'morning' | 'evening'> = options.kind === 'drain' ? ['morning', 'evening'] : [options.kind]
    const summaries: DeliverySummary[] = []
    for (const kind of kinds) summaries.push(await deliverKind(deps, kind, budget))
    return summaries
  } finally {
    budget.finish()
  }
}

async function deliverKind(
  deps: DeliveryDeps,
  kind: 'morning' | 'evening',
  budget: TickBudget,
): Promise<DeliverySummary> {
  const now = deps.now ?? (() => new Date())
  const date = tashkentDateString(now())
  const batchSize = clampInt(deps.batchSize, 10, 1, 25)
  // the finish reserve scales down with small budgets so a short tick still processes work
  const budgetMs = clampInt(deps.budgetMs, 100_000, 1, 120_000)
  const finishReserve = Math.min(FINISH_RESERVE_MS, Math.floor(budgetMs / 5))
  const summary: DeliverySummary = { kind, date, prepared: 0, recovered: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, unknown: 0, retriable: 0, stoppedByBudget: false }

  // recovery FIRST — it also closes prior-day strays, and runs regardless of the due gate
  const recovered = await rpc(deps, budget, 'briefing_recover_runs', { p_kind: kind, p_today: date })
  if (!recovered.error && typeof recovered.data === 'number') summary.recovered = recovered.data

  // the due gate: nothing for today exists — let alone is sent — before its Tashkent time.
  // Preparation is idempotent (INSERT … ON CONFLICT DO NOTHING), so behind the gate the drain
  // may run it too: a send tick that died before preparing must not lose the day.
  if (!dueReached(kind, now())) return summary
  const prepared = await rpc(deps, budget, 'briefing_prepare_runs', { p_kind: kind, p_run_date: date })
  if (prepared.error) return summary
  if (typeof prepared.data === 'number') summary.prepared = prepared.data

  for (;;) {
    if (budget.remainingMs() < finishReserve) { summary.stoppedByBudget = true; break }
    const claimed = await rpc(deps, budget, 'briefing_claim_runs', { p_kind: kind, p_run_date: date, p_limit: batchSize, p_lease_seconds: 120 })
    if (claimed.error || !Array.isArray(claimed.data) || claimed.data.length === 0) break
    for (const raw of claimed.data as RunRow[]) {
      if (budget.remainingMs() < finishReserve) { summary.stoppedByBudget = true; break }
      summary.claimed += 1
      await deliverOne(deps, budget, raw, date, summary)
    }
    if (summary.stoppedByBudget) break
  }
  return summary
}

async function deliverOne(deps: DeliveryDeps, budget: TickBudget, run: RunRow, date: string, summary: DeliverySummary): Promise<void> {
  const finish = async (status: 'sent' | 'failed' | 'skipped' | 'unknown', messageId: number | null, error: string | null) => {
    const result = await rpc(deps, budget, 'briefing_finish_run', {
      p_run_id: run.id, p_lease_token: run.lease_token, p_status: status, p_message_id: messageId, p_error: error,
    })
    // a failed finish is left to lease recovery — never a second send attempt from here
    if (!result.error && result.data === true) {
      if (status === 'sent') summary.sent += 1
      else if (status === 'failed') summary.failed += 1
      else if (status === 'skipped') summary.skipped += 1
      else summary.unknown += 1
    }
  }
  const retriable = () => { summary.retriable += 1 } // no finish: the lease expires and re-claims

  // compose inputs (coords, language). A DB error here is PRE-dispatch — leave the row retriable.
  let settingsData: { weather_lat?: unknown; weather_lon?: unknown } | null
  try {
    const { data: settings, error } = await Promise.race([
      deps.admin.from('briefing_settings').select('weather_lat, weather_lon').eq('account_id', run.account_id).maybeSingle(),
      budget.expired,
    ])
    if (error) { retriable(); return }
    settingsData = settings
  } catch { retriable(); return }
  const coords = {
    lat: settingsData?.weather_lat === null || settingsData?.weather_lat === undefined ? null : Number(settingsData.weather_lat),
    lon: settingsData?.weather_lon === null || settingsData?.weather_lon === undefined ? null : Number(settingsData.weather_lon),
  }
  if (deps.blocksExternal) {
    try {
      if (await Promise.race([deps.blocksExternal(run.account_id), budget.expired])) {
        await finish('skipped', null, 'external_actions_blocked'); return
      }
    } catch { retriable(); return }
  }
  let lang: BriefingLang = 'uz'
  try {
    const { data } = await Promise.race([
      deps.admin.from('business_profiles').select('report_lang').eq('account_id', run.account_id).maybeSingle(),
      budget.expired,
    ])
    const value = String(data?.report_lang ?? '').toLowerCase()
    if (LANGS.has(value as BriefingLang)) lang = value as BriefingLang
  } catch { /* language is cosmetic — default stands */ }

  // compose BEFORE the marker: up to ~10s of source waits must not sit between the consent
  // check and the send. The marker below re-validates consent atomically at the last moment.
  let text: string
  try {
    text = await Promise.race([composeForAccount(deps, run.kind, run.account_id, date, lang, coords), budget.expired])
  } catch { retriable(); return }
  if (text.length > MESSAGE_LIMIT) text = `${text.slice(0, MESSAGE_LIMIT - 2)}\n…`

  // Racing does not stop a NEW call from being issued after expiry — check the clock BEFORE
  // every side effect. Pre-marker this is retriable by construction.
  if (budget.remainingMs() <= 0) { retriable(); return }

  // CAS fence + atomic consent re-validation + recipient snapshot, all inside the RPC. Anything
  // but an explicit ok — lost lease, RPC error, unknown marker outcome — means NO send.
  const marked = await rpc(deps, budget, 'briefing_mark_dispatch', { p_run_id: run.id, p_lease_token: run.lease_token })
  if (marked.error) { retriable(); return }
  const marker = marked.data as { ok?: boolean; reason?: string; channel_id?: string; chat_id?: string } | null
  if (marker?.ok !== true) {
    if (marker?.reason && marker.reason !== 'lease_lost') await finish('skipped', null, marker.reason)
    return
  }

  // the bot token comes from the SNAPSHOT channel; nothing was sent yet, so failures here are
  // definite 'failed', and the dispatched row can never be resent anyway
  let channelRow: { credentials?: { bot_token?: unknown } } | null
  try {
    const { data: channel, error } = await Promise.race([
      deps.admin.from('channels').select('credentials').eq('id', marker.channel_id).eq('account_id', run.account_id).maybeSingle(),
      budget.expired,
    ])
    if (error || !channel?.credentials?.bot_token) { await finish('failed', null, 'channel_missing'); return }
    channelRow = channel
  } catch { await finish('failed', null, 'channel_lookup_failed'); return }
  const botToken = String(channelRow?.credentials?.bot_token ?? '')

  // expired between marker and send: do NOT start the send — the dispatched row resolves to
  // 'unknown' via lease recovery, which is the truthful record of this situation
  if (budget.remainingMs() <= 0) return

  try {
    const outcome = await Promise.race([deps.sendMessage(botToken, String(marker.chat_id), text), budget.expired])
    if (outcome.status === 'sent') { await finish('sent', outcome.messageId, null); return }
    if (outcome.status === 'rejected') { await finish('failed', null, outcome.detail.slice(0, 200)); return }
    await finish('unknown', null, 'send_ambiguous')
  } catch {
    // budget died while the send was in flight: the row is dispatched and lease recovery will
    // record it as 'unknown' — exactly the truth
  }
}
