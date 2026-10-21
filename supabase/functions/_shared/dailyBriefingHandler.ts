// Daily-briefing HTTP handler — Step 2a only: settings + authenticated READ-ONLY preview.
// No cron entry, no delivery, no Telegram send exists in this module at all.
//
// Pure and injected (db client, auth lookup, fetch, calendar section, clock) so every branch is
// testable offline. The Deno.serve wrapper in ../daily-briefing/index.ts only wires real deps.
//
// Authorization chain (service role bypasses RLS, so each link is explicit here):
//   JWT → users row (account_id derived from the caller, NEVER from the body)
//       → role gate: role === 'owner' OR is_admin === true (roles are owner|operator; admin is
//         the is_admin flag, not a role value)
//       → accounts row must EXIST and not be blocked (public.current_account_id() excludes
//         blocked accounts for RLS readers — 20260723121000 — but service-role reads would not;
//         a missing accounts row fails closed, it does not pass).
// A failed lookup is 503, never 403: "we could not check" must not read as "you have no account".
//
// The WHOLE request runs under one deadline: a hung dependency (auth, DB, source) resolves to a
// fixed-error envelope, never an escaped rejection or an open-ended await. Independent morning
// sources are fetched in PARALLEL so worst case is one source budget, not their sum.
//
// Recipient truthfulness: settings carry a CONFIGURED binding (exact channel + chat). The legacy
// telegram-webhook binding does not validate private chats, so nothing here may call a recipient
// "verified" — recipient_verified_at is reported as-is (null in 2a) and every settings write
// resets it, because changing the binding invalidates any future verification.
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
import {
  composeEveningBriefing,
  composeMorningBriefing,
  type BriefingLang,
  type EveningTasksSection,
} from './dailyBriefing.ts'

const MAX_BODY_BYTES = 8 * 1024
const MAX_REQUEST_TIMEOUT_MS = 25_000
const ACTIONS = new Set(['settings-get', 'settings-set', 'preview', 'verify-recipient'])
const LANGS = new Set<BriefingLang>(['uz', 'ru', 'en'])

export interface DailyBriefingDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase service-role client shape
  admin: any
  getUser: (authorization: string) => Promise<{ id: string } | null>
  fetchImpl: FetchLike
  /** OpenWeather key from server env; '' renders the weather section honestly unavailable. */
  openWeatherKey: string
  calendarSection: (accountId: string, date: string) => Promise<CalendarSection>
  /** Resolves the bot username for the deep verification link; null renders manual instructions. */
  getBotUsername?: (channelId: string, accountId: string) => Promise<string | null>
  /** DAILY_BRIEFING_DELIVERY env value — settings-get reports delivery status truthfully. */
  deliverySwitch?: string
  /** Whole-request deadline; clamped to ≤25s. Injected small in tests. */
  requestTimeoutMs?: number
  now?: () => Date
}

export interface HandlerResult { status: number; body: Record<string, unknown> }

interface SettingsRow {
  morning_enabled?: boolean
  evening_enabled?: boolean
  weather_lat?: number | string | null
  weather_lon?: number | string | null
  notify_channel_id?: string | null
  notify_chat_id?: string | null
  recipient_verified_at?: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHAT_ID_RE = /^-?\d{1,20}$/

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

function nextIsoDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day) + 86_400_000).toISOString().slice(0, 10)
}

function settingsView(row: SettingsRow | null) {
  return {
    morning_enabled: row?.morning_enabled === true,
    evening_enabled: row?.evening_enabled === true,
    weather_lat: row?.weather_lat === null || row?.weather_lat === undefined ? null : Number(row.weather_lat),
    weather_lon: row?.weather_lon === null || row?.weather_lon === undefined ? null : Number(row.weather_lon),
    notify_channel_id: row?.notify_channel_id ?? null,
    notify_chat_id: row?.notify_chat_id ?? null,
    // configured = a bot is bound; the chat id may still be pending (verification discovers it).
    // Configured is NOT verified: verification only ever comes from the consume-claim flow.
    recipient_status: row?.notify_channel_id ? 'configured' : 'not_configured',
    recipient_verified: Boolean(row?.recipient_verified_at),
  }
}

/**
 * Deadline context threaded through the request. Promise.race alone does NOT cancel the losing
 * branch: without checkpoints, a slow auth answer let the abandoned continuation run its upsert
 * AFTER the caller was already told "timeout". Every await is followed by a checkpoint BEFORE any
 * further dependency call, so nothing new — above all no write — starts past the deadline.
 */
interface DeadlineCtx {
  checkpoint: () => void
  beginWrite: () => void
  endWrite: () => void
}

export async function handleDailyBriefing(
  deps: DailyBriefingDeps,
  input: { method: string; authorization: string; bodyText: string },
): Promise<HandlerResult> {
  // One deadline over the whole request: hung deps resolve to a fixed envelope, and any escaped
  // rejection becomes a fixed 'internal' — the wrapper never sees an exception.
  const timeoutMs = clampInt(deps.requestTimeoutMs, 20_000, 1, MAX_REQUEST_TIMEOUT_MS)
  const state = { expired: false, writeDispatched: false, writeSettled: false }
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => { state.expired = true; expire(new Error('BRIEFING_REQUEST_TIMEOUT')) }, timeoutMs)
  const ctx: DeadlineCtx = {
    checkpoint: () => { if (state.expired) throw new Error('BRIEFING_REQUEST_TIMEOUT') },
    beginWrite: () => { state.writeDispatched = true },
    endWrite: () => { state.writeSettled = true },
  }
  const inner = handleInner(deps, input, ctx)
  inner.catch(() => {}) // the abandoned branch may reject at its next checkpoint — never unhandled
  try {
    return await Promise.race([inner, expired])
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'BRIEFING_REQUEST_TIMEOUT'
    if (timedOut && state.writeDispatched && !state.writeSettled) {
      // The write was already on the wire when the deadline fired: its outcome is UNKNOWN.
      // Saying "timeout" would imply not-saved; retrying blindly could double-apply. The UI
      // must reload the settings and reconcile.
      return { status: 503, body: { ok: false, error: 'save_outcome_unknown', hint: 'reload_settings' } }
    }
    return { status: 503, body: { ok: false, error: timedOut ? 'timeout' : 'internal' } }
  } finally {
    clearTimeout(timer)
  }
}

async function handleInner(
  deps: DailyBriefingDeps,
  input: { method: string; authorization: string; bodyText: string },
  ctx: DeadlineCtx,
): Promise<HandlerResult> {
  const now = deps.now ?? (() => new Date())
  if (input.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
  // Defense in depth — the wrapper already refuses oversized bodies while streaming.
  if (new TextEncoder().encode(input.bodyText).byteLength > MAX_BODY_BYTES) {
    return { status: 413, body: { ok: false, error: 'body_too_large' } }
  }
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(input.bodyText || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    body = parsed as Record<string, unknown>
  } catch { return { status: 400, body: { ok: false, error: 'bad_json' } } }
  const action = String(body.action ?? '')
  if (!ACTIONS.has(action)) return { status: 400, body: { ok: false, error: 'unknown_action' } }

  const user = await deps.getUser(input.authorization).catch(() => null)
  ctx.checkpoint() // a late auth answer must not start DB work after the deadline
  if (!user) return { status: 401, body: { ok: false, error: 'unauthorized' } }

  const { data: profile, error: profileError } = await deps.admin
    .from('users').select('account_id, role, is_admin').eq('id', user.id).maybeSingle()
  ctx.checkpoint()
  if (profileError) return { status: 503, body: { ok: false, error: 'profile_unavailable' } }
  if (!profile?.account_id) return { status: 403, body: { ok: false, error: 'no_account' } }
  if (profile.role !== 'owner' && profile.is_admin !== true) {
    return { status: 403, body: { ok: false, error: 'owner_required' } }
  }
  const accountId = String(profile.account_id)

  const { data: account, error: accountError } = await deps.admin
    .from('accounts').select('blocked').eq('id', accountId).maybeSingle()
  ctx.checkpoint()
  if (accountError) return { status: 503, body: { ok: false, error: 'account_unavailable' } }
  // fail closed: an account row that does not exist is not an account in good standing
  if (!account) return { status: 403, body: { ok: false, error: 'no_account' } }
  if (account.blocked) return { status: 403, body: { ok: false, error: 'blocked' } }

  if (action === 'settings-get') {
    const { data: row, error } = await deps.admin
      .from('briefing_settings').select('*').eq('account_id', accountId).maybeSingle()
    ctx.checkpoint()
    if (error) return { status: 503, body: { ok: false, error: 'settings_unavailable' } }
    return {
      status: 200,
      body: {
        ok: true,
        settings: settingsView(row as SettingsRow | null),
        // truthful delivery status: the code ships, the switch decides. The UI must never claim
        // "not active yet" when it is, nor "active" while the operator has it off.
        delivery: { implemented: true, enabled: (deps.deliverySwitch ?? '').toLowerCase() !== 'off' },
      },
    }
  }

  if (action === 'settings-set') {
    // Full replacement of the consent row — explicit values only, no merge ambiguity.
    if (typeof body.morning_enabled !== 'boolean' || typeof body.evening_enabled !== 'boolean') {
      return { status: 400, body: { ok: false, error: 'invalid_settings' } }
    }
    const latRaw = body.weather_lat
    const lonRaw = body.weather_lon
    const hasLat = latRaw !== null && latRaw !== undefined
    const hasLon = lonRaw !== null && lonRaw !== undefined
    if (hasLat !== hasLon) return { status: 400, body: { ok: false, error: 'invalid_coordinates' } }
    if (hasLat && (typeof latRaw !== 'number' || typeof lonRaw !== 'number'
      || !Number.isFinite(latRaw) || !Number.isFinite(lonRaw) || Math.abs(latRaw) > 90 || Math.abs(lonRaw) > 180)) {
      return { status: 400, body: { ok: false, error: 'invalid_coordinates' } }
    }
    const channelRaw = body.notify_channel_id
    const chatRaw = body.notify_chat_id
    const hasBinding = Boolean(channelRaw)
    const hasChat = chatRaw !== null && chatRaw !== undefined && chatRaw !== ''
    // the chat id is OPTIONAL — verification discovers the real one; but a chat without a bot,
    // or a malformed value, is never accepted
    if (hasBinding && (typeof channelRaw !== 'string' || !UUID_RE.test(channelRaw))) {
      return { status: 400, body: { ok: false, error: 'invalid_recipient' } }
    }
    if (hasChat && (!hasBinding || typeof chatRaw !== 'string' || !CHAT_ID_RE.test(chatRaw.trim()))) {
      return { status: 400, body: { ok: false, error: 'invalid_recipient' } }
    }
    if ((body.morning_enabled || body.evening_enabled) && !hasBinding) {
      return { status: 400, body: { ok: false, error: 'recipient_required' } }
    }
    if (hasBinding) {
      // The channel must belong to THIS account and be a Telegram bot. No row means no consent
      // target — the request fails; it never falls back to some other bot of the account.
      const { data: channel, error: channelError } = await deps.admin
        .from('channels').select('id, type').eq('id', channelRaw).eq('account_id', accountId).maybeSingle()
      ctx.checkpoint()
      if (channelError) return { status: 503, body: { ok: false, error: 'channel_lookup_failed' } }
      if (!channel) return { status: 400, body: { ok: false, error: 'channel_not_found' } }
      if (channel.type !== 'telegram') return { status: 400, body: { ok: false, error: 'channel_not_telegram' } }
    }
    // The consent write goes through ONE atomic RPC: it bumps settings_revision and clears
    // recipient_verified_at + current_claim_id on the same row version, which a PostgREST
    // upsert cannot express. Guarded on both sides: never dispatched past the deadline, and if
    // the deadline fires while it is in flight the caller gets save_outcome_unknown.
    ctx.checkpoint()
    ctx.beginWrite()
    const { data: saved, error: saveError } = await deps.admin.rpc('briefing_save_settings', {
      p_account: accountId,
      p_morning: body.morning_enabled,
      p_evening: body.evening_enabled,
      p_lat: hasLat ? latRaw : null,
      p_lon: hasLat ? lonRaw : null,
      p_channel: hasBinding ? channelRaw : null,
      p_chat: hasChat ? String(chatRaw).trim() : null,
      p_updated_by: user.id,
    })
    ctx.endWrite()
    if (saveError || !saved) return { status: 503, body: { ok: false, error: 'save_failed' } }
    return { status: 200, body: { ok: true, settings: settingsView(saved as SettingsRow) } }
  }

  if (action === 'verify-recipient') {
    const { data: row, error } = await deps.admin
      .from('briefing_settings').select('notify_channel_id').eq('account_id', accountId).maybeSingle()
    ctx.checkpoint()
    if (error) return { status: 503, body: { ok: false, error: 'settings_unavailable' } }
    if (!row?.notify_channel_id) return { status: 400, body: { ok: false, error: 'recipient_required' } }
    // 24 random bytes → 48 hex chars: 'brf_' + 48 stays inside Telegram's 64-char start payload.
    // Only the SHA-256 of the token is stored; the raw token exists solely in this response.
    const tokenBytes = new Uint8Array(24)
    crypto.getRandomValues(tokenBytes)
    const token = [...tokenBytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    const tokenHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    ctx.checkpoint()
    ctx.beginWrite()
    const { data: issued, error: issueError } = await deps.admin
      .rpc('briefing_issue_claim', { p_account: accountId, p_token_hash: tokenHash })
    ctx.endWrite()
    if (issueError) return { status: 503, body: { ok: false, error: 'issue_failed' } }
    const result = issued as { ok?: boolean; reason?: string } | null
    if (result?.ok !== true) return { status: 400, body: { ok: false, error: result?.reason ?? 'issue_refused' } }
    let username: string | null = null
    if (deps.getBotUsername) {
      // a stalled getMe must not lose the successful claim: on any failure the manual payload
      // still goes out — deep link is a convenience, never the mechanism
      try { username = await deps.getBotUsername(String(row.notify_channel_id), accountId) } catch { username = null }
    }
    ctx.checkpoint()
    return {
      status: 200,
      body: {
        ok: true,
        start_payload: `brf_${token}`,
        deep_link: username ? `https://t.me/${username}?start=brf_${token}` : null,
        expires_in_seconds: 900,
        recipient_verified: false,
      },
    }
  }

  // action === 'preview' — read-only: composes live sections, never sends, never writes.
  const kind = String(body.kind ?? 'morning')
  if (kind !== 'morning' && kind !== 'evening') return { status: 400, body: { ok: false, error: 'unknown_kind' } }
  const lang = (LANGS.has(body.lang as BriefingLang) ? body.lang : 'uz') as BriefingLang
  const date = tashkentDateString(now())

  const { data: row, error: settingsError } = await deps.admin
    .from('briefing_settings').select('*').eq('account_id', accountId).maybeSingle()
  ctx.checkpoint()
  if (settingsError) return { status: 503, body: { ok: false, error: 'settings_unavailable' } }
  const settings = settingsView(row as SettingsRow | null)

  if (kind === 'evening') {
    ctx.checkpoint()
    const tasks = await buildEveningTasksSection(deps.admin, accountId, date, now)
    return {
      status: 200,
      body: { ok: true, kind, lang, date, settings, text: composeEveningBriefing({ lang, dateLabel: date, tasks }), sections: { tasks } },
    }
  }

  const unavailable = (source: string, detail: string) => ({ status: 'unavailable' as const, source, fetchedAt: now().toISOString(), detail })
  ctx.checkpoint() // no source spend may start past the deadline
  // Independent sources in PARALLEL: worst case is one source budget, not the sum of four.
  const [usd, weather, calendar, news, yesterdayOutcome] = await Promise.all([
    fetchCbuUsdRate(deps.fetchImpl, { date, now }).catch<UsdRateSection>(() => unavailable(CBU_SOURCE, 'network')),
    (async (): Promise<WeatherSection> => {
      if (settings.weather_lat === null || settings.weather_lon === null) return unavailable(WEATHER_SOURCE, 'no_coordinates')
      if (!deps.openWeatherKey) return unavailable(WEATHER_SOURCE, 'missing_key')
      return fetchOpenWeather(deps.fetchImpl, { lat: settings.weather_lat, lon: settings.weather_lon, apiKey: deps.openWeatherKey, lang, now })
        .catch<WeatherSection>(() => unavailable(WEATHER_SOURCE, 'network'))
    })(),
    deps.calendarSection(accountId, date).catch<CalendarSection>(() => unavailable(CALENDAR_SOURCE, 'network')),
    fetchNewsHeadlines(deps.fetchImpl, { now }).catch(() => newsSection(now)),
    buildYesterdayOutcome(deps.admin, accountId, date),
  ])
  const sections = { usd, weather, calendar, news }
  return {
    status: 200,
    body: { ok: true, kind, lang, date, settings, text: composeMorningBriefing({ lang, dateLabel: date, sections, yesterdayOutcome }), sections, yesterday_outcome: yesterdayOutcome },
  }
}

/**
 * Streamed, capped request-body read for the wrapper: refuses an oversized body WHILE it arrives
 * instead of allocating it first, and never waits on a slow sender beyond its own deadline.
 * Structurally typed so tests drive it with a plain fake request.
 */
export async function readRequestBodyBounded(
  req: { headers: { get: (name: string) => string | null }; body: ReadableStream<Uint8Array> | null },
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ ok: true; text: string } | { ok: false; reason: 'too_large' | 'read_failed' }> {
  const maxBytes = clampInt(options.maxBytes, MAX_BODY_BYTES, 1, 1024 * 1024)
  const timeoutMs = clampInt(options.timeoutMs, 10_000, 1, MAX_REQUEST_TIMEOUT_MS)
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' }
  const body = req.body
  if (!body) return { ok: true, text: '' }
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => expire(new Error('BODY_READ_TIMEOUT')), timeoutMs)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired])
      if (done) break
      total += value.byteLength
      if (total > maxBytes) { void reader.cancel().catch(() => {}); return { ok: false, reason: 'too_large' } }
      chunks.push(value)
    }
  } catch {
    void reader.cancel().catch(() => {})
    return { ok: false, reason: 'read_failed' }
  } finally {
    clearTimeout(timer)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return { ok: true, text: new TextDecoder().decode(merged) }
}

export type YesterdayOutcome =
  | { status: 'ready'; runDate: string; text: string }
  | { status: 'unavailable' }
  | null

/**
 * Yesterday's recorded outcome for the morning brief — EXACT prior Tashkent date, account-scoped.
 * Tri-state: null = nothing recorded (honest silence); 'unavailable' = the read failed and must
 * not masquerade as silence. Display-only: no task state is ever inferred from it.
 */
export async function buildYesterdayOutcome(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase service-role client shape
  admin: any,
  accountId: string,
  todayDate: string,
): Promise<YesterdayOutcome> {
  const [year, month, day] = todayDate.split('-').map(Number)
  const yesterday = new Date(Date.UTC(year, month - 1, day) - 86_400_000).toISOString().slice(0, 10)
  try {
    const { data, error } = await admin
      .from('briefing_outcomes').select('run_date, text')
      .eq('account_id', accountId).eq('run_date', yesterday).maybeSingle()
    if (error) return { status: 'unavailable' }
    if (!data || typeof data.text !== 'string' || !data.text) return null
    return { status: 'ready', runDate: yesterday, text: data.text }
  } catch {
    return { status: 'unavailable' }
  }
}

/** Bounded task rollup for the evening preview. Any DB error is an honest unavailable envelope. */
export async function buildEveningTasksSection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase service-role client shape
  admin: any,
  accountId: string,
  date: string,
  now: () => Date,
): Promise<EveningTasksSection> {
  const fetchedAt = now().toISOString()
  const dayStart = `${date}T00:00:00+05:00`
  const dayEnd = `${nextIsoDate(date)}T00:00:00+05:00`
  const failed: EveningTasksSection = { status: 'unavailable', source: 'nemo-db', fetchedAt, detail: 'db_error' }
  let done, open, overdue, topDue, topDeadline
  try {
    // completed_at (20260707230000_planerka.sql) bounded to [dayStart, dayEnd): counting
    // updated_at would count today's EDITS of long-finished tasks as today's completions.
    // Due semantics mirror task-reminders' dual columns, but with TASHKENT end-of-day for the
    // date-only `deadline` (not its 23:59 UTC fallback): a deadline is overdue only once its
    // Tashkent day has fully passed, i.e. deadline < today's Tashkent date.
    ;[done, open, overdue, topDue, topDeadline] = await Promise.all([
      admin.from('tasks').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'done').gte('completed_at', dayStart).lt('completed_at', dayEnd),
      admin.from('tasks').select('id', { count: 'exact', head: true }).eq('account_id', accountId).neq('status', 'done'),
      admin.from('tasks').select('id', { count: 'exact', head: true }).eq('account_id', accountId).neq('status', 'done')
        .or(`due_at.lt.${now().toISOString()},and(due_at.is.null,deadline.lt.${date})`),
      admin.from('tasks').select('title, due_at').eq('account_id', accountId).neq('status', 'done').not('due_at', 'is', null).order('due_at', { ascending: true }).limit(5),
      admin.from('tasks').select('title, deadline').eq('account_id', accountId).neq('status', 'done').is('due_at', null).not('deadline', 'is', null).order('deadline', { ascending: true }).limit(5),
    ])
  } catch { return failed }
  if (done.error || open.error || overdue.error || topDue.error || topDeadline.error) return failed
  // a null count is "the database did not answer", not zero completed tasks
  if (typeof done.count !== 'number' || typeof open.count !== 'number' || typeof overdue.count !== 'number') return failed
  const dueTasks = ((topDue.data ?? []) as Array<{ title?: unknown; due_at?: unknown }>).map((task) => {
    const dueMs = typeof task.due_at === 'string' ? Date.parse(task.due_at) : Number.NaN
    return {
      title: String(task.title ?? ''),
      // the label must be the TASHKENT date: near-midnight UTC slices land on the wrong day
      dueLabel: Number.isFinite(dueMs) ? tashkentDateString(new Date(dueMs)) : undefined,
    }
  })
  const deadlineTasks = ((topDeadline.data ?? []) as Array<{ title?: unknown; deadline?: unknown }>).map((task) => ({
    title: String(task.title ?? ''),
    // date-only deadline IS a Tashkent-local date — no conversion, no invented time
    dueLabel: typeof task.deadline === 'string' ? task.deadline.slice(0, 10) : undefined,
  }))
  // merge the two due sources by their (Tashkent) date label, earliest first, keep 5
  const topTasks = [...dueTasks, ...deadlineTasks]
    .sort((a, b) => (a.dueLabel ?? '9999').localeCompare(b.dueLabel ?? '9999'))
    .slice(0, 5)
  return {
    status: 'ready',
    source: 'nemo-db',
    fetchedAt,
    data: {
      doneToday: done.count,
      open: open.count,
      overdue: overdue.count,
      topTasks,
      moreCount: Math.max(0, open.count - topTasks.length),
    },
  }
}
