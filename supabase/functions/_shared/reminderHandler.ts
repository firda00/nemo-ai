// Authenticated monthly-reminders endpoint — Plan B wrapper stage. Pure and injected so every
// branch is testable offline.
//
// Contract (pre-review conditions):
//   • the account comes from the AUTHENTICATED user (users row) with the same
//     owner/is_admin + blocked-account chain as the margin/briefing handlers; DB lookup
//     failures answer 503, never 403;
//   • time is the SERVER's alone: reminder_save_schedule receives new Date() from here —
//     a client-supplied p_now/now field is never even read, so consent floors (enabled_at)
//     cannot be forged backwards;
//   • one deadline covers every await with checkpoints; the wrapper streams the small JSON
//     body under the same absolute deadline;
//   • the handler only reads and calls the reviewed RPCs — every write goes through
//     reminder_save_schedule, which enforces validation, verification and revision rules.
export interface ReminderHandlerDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase service-role client shape
  admin: any
  getUser: (authorization: string) => Promise<{ id: string } | null>
  now?: () => number
}

export interface ReminderHandlerInput {
  method: string
  authorization: string
  bodyText: string
  /** Absolute ms timestamp shared with the wrapper's body read; defaults to now + 20s. */
  deadlineAt?: number
}

export interface ReminderHandlerResult { status: number; body: Record<string, unknown> }

const DEFAULT_TIMEOUT_MS = 20_000
const DEADLINE_ERR = 'REMINDER_REQUEST_TIMEOUT'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// the creation cap is enforced ATOMICALLY inside reminder_save_schedule (account row lock);
// this constant only feeds UI copy, and the list below reads more than the cap so every
// schedule stays manageable (and disableable) at the limit
export const MAX_REMINDER_SCHEDULES = 30
/** page size of the monthly-source picker; pagination keeps OLDER files reachable */
export const SOURCES_PAGE = 10
const MAX_SOURCES_PAGES = 50

interface DeadlineCtx {
  checkpoint: () => void
  race: <T>(inner: Promise<T>) => Promise<T>
}

export async function handleReminders(deps: ReminderHandlerDeps, input: ReminderHandlerInput): Promise<ReminderHandlerResult> {
  if (input.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
  const nowMs = deps.now ?? (() => Date.now())
  const deadlineAt = input.deadlineAt ?? nowMs() + DEFAULT_TIMEOUT_MS
  const state = { expired: false }
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => { state.expired = true; expire(new Error(DEADLINE_ERR)) }, Math.max(0, deadlineAt - nowMs()))
  const ctx: DeadlineCtx = {
    // the timer macrotask can lose to a busy microtask chain — the clock is the authority
    checkpoint: () => {
      if (state.expired || nowMs() >= deadlineAt) { state.expired = true; throw new Error(DEADLINE_ERR) }
    },
    race: (inner) => {
      inner.catch(() => {}) // the loser must never surface as unhandled
      return Promise.race([inner, expired])
    },
  }
  const inner = handleInner(deps, input, ctx, nowMs)
  inner.catch(() => {}) // the abandoned branch may reject at its next checkpoint — never unhandled
  try {
    return await Promise.race([inner, expired])
  } catch (error) {
    const timedOut = error instanceof Error && error.message === DEADLINE_ERR
    return { status: 503, body: { ok: false, error: timedOut ? 'timeout' : 'internal' } }
  } finally {
    clearTimeout(timer)
  }
}

async function handleInner(
  deps: ReminderHandlerDeps, input: ReminderHandlerInput, ctx: DeadlineCtx, nowMs: () => number,
): Promise<ReminderHandlerResult> {
  const user = await ctx.race(deps.getUser(input.authorization).catch(() => null))
  ctx.checkpoint()
  if (!user) return { status: 401, body: { ok: false, error: 'unauthorized' } }
  const { data: profile, error: profileError } = await ctx.race(Promise.resolve(deps.admin
    .from('users').select('account_id, role, is_admin').eq('id', user.id).maybeSingle()))
  ctx.checkpoint()
  if (profileError) return { status: 503, body: { ok: false, error: 'profile_unavailable' } }
  if (!profile?.account_id) return { status: 403, body: { ok: false, error: 'no_account' } }
  if (profile.role !== 'owner' && profile.is_admin !== true) return { status: 403, body: { ok: false, error: 'owner_required' } }
  const accountId = String(profile.account_id)
  const { data: account, error: accountError } = await ctx.race(Promise.resolve(deps.admin
    .from('accounts').select('blocked').eq('id', accountId).maybeSingle()))
  ctx.checkpoint()
  if (accountError) return { status: 503, body: { ok: false, error: 'account_unavailable' } }
  if (!account) return { status: 403, body: { ok: false, error: 'no_account' } }
  if (account.blocked) return { status: 403, body: { ok: false, error: 'blocked' } }

  const payload = ((): Record<string, unknown> | null => {
    try { return JSON.parse(input.bodyText || '{}') } catch { return null }
  })()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { status: 400, body: { ok: false, error: 'bad_json' } }
  const action = typeof payload.action === 'string' ? payload.action : ''

  if (action === 'set-period') {
    // the ONLY way a file's reporting period changes; already-frozen occurrences are immune
    if (typeof payload.file_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.file_sha256)) {
      return { status: 400, body: { ok: false, error: 'invalid_sha' } }
    }
    if (typeof payload.period_month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(payload.period_month)) {
      return { status: 400, body: { ok: false, error: 'invalid_period' } }
    }
    const { data, error } = await ctx.race(Promise.resolve(deps.admin.rpc('margin_registry_set_period', {
      p_account_id: accountId,
      p_file_sha256: payload.file_sha256,
      p_period_month: payload.period_month,
    })))
    ctx.checkpoint()
    if (error) return { status: 503, body: { ok: false, error: 'save_failed' } }
    const outcome = (data ?? null) as { ok?: boolean; reason?: string; source?: unknown } | null
    if (!outcome || outcome.ok !== true) return { status: 200, body: { ok: false, error: outcome?.reason ?? 'save_failed' } }
    return { status: 200, body: { ok: true, source: outcome.source ?? null } }
  }

  if (action === 'list') {
    // a checkpoint sits BETWEEN the reads: with the clock past the deadline but the timer
    // macrotask not yet fired, the next DB query must not even start
    const schedules = await ctx.race(Promise.resolve(deps.admin
      .from('reminder_schedules')
      .select('id, title, day_of_month, send_minute, enabled, schedule_revision, kind, report_currency')
      .eq('account_id', accountId).order('created_at', { ascending: false }).limit(50)))
    ctx.checkpoint()
    const occurrences = await ctx.race(Promise.resolve(deps.admin
      .from('reminder_occurrences')
      .select('schedule_id, month_key, due_date, status, error, telegram_message_id')
      .eq('account_id', accountId).order('due_date', { ascending: false }).limit(30)))
    ctx.checkpoint()
    const settings = await ctx.race(Promise.resolve(deps.admin
      .from('briefing_settings')
      .select('recipient_verified_at, notify_channel_id')
      .eq('account_id', accountId).maybeSingle()))
    ctx.checkpoint()
    // one page + one extra row: the extra only answers "is there more?"
    const sources = await ctx.race(Promise.resolve(deps.admin
      .from('margin_upload_registry')
      .select('file_sha256, file_name, uploaded_at, period_month')
      .eq('account_id', accountId).order('uploaded_at', { ascending: false })
      .order('file_sha256', { ascending: true }).limit(SOURCES_PAGE + 1)))
    ctx.checkpoint()
    if (schedules.error) return { status: 503, body: { ok: false, error: 'list_unavailable' } }
    const sourceRows = sources.error ? null : (sources.data ?? []) as unknown[]
    return {
      status: 200,
      body: {
        ok: true,
        schedules: schedules.data ?? [],
        // auxiliary lists fail SOFT to null (never rendered as "no history"), like the briefing UI
        occurrences: occurrences.error ? null : occurrences.data ?? [],
        recipient: settings.error
          ? null
          : {
            verified: Boolean(settings.data?.recipient_verified_at),
            channel_bound: Boolean(settings.data?.notify_channel_id),
          },
        sources: sourceRows === null ? null : sourceRows.slice(0, SOURCES_PAGE),
        sources_has_more: sourceRows === null ? false : sourceRows.length > SOURCES_PAGE,
      },
    }
  }

  if (action === 'sources') {
    // bounded pagination for the monthly-source picker: an OLDER valid file must stay
    // reachable and declarable after many newer uploads — never a silently truncated list
    if (typeof payload.page !== 'number' || !Number.isInteger(payload.page)
      || payload.page < 0 || payload.page > MAX_SOURCES_PAGES) {
      return { status: 400, body: { ok: false, error: 'bad_request' } }
    }
    const from = payload.page * SOURCES_PAGE
    const { data, error } = await ctx.race(Promise.resolve(deps.admin
      .from('margin_upload_registry')
      .select('file_sha256, file_name, uploaded_at, period_month')
      .eq('account_id', accountId).order('uploaded_at', { ascending: false })
      .order('file_sha256', { ascending: true }).range(from, from + SOURCES_PAGE)))
    ctx.checkpoint()
    // a dedicated page request fails HARD — the UI shows an explicit retry, not an empty list
    if (error) return { status: 503, body: { ok: false, error: 'list_unavailable' } }
    const rows = (data ?? []) as unknown[]
    const moreExists = rows.length > SOURCES_PAGE
    const atCap = payload.page >= MAX_SOURCES_PAGES
    return {
      status: 200,
      body: {
        ok: true,
        page: payload.page,
        sources: rows.slice(0, SOURCES_PAGE),
        // NEVER has_more=true followed by an unconditional refusal: at the bound the answer is
        // has_more=false plus an explicit truncated flag the UI must surface
        has_more: moreExists && !atCap,
        truncated: moreExists && atCap,
      },
    }
  }

  if (action === 'save') {
    // STRICT shapes: a malformed edit must be refused, never coerced — above all a broken
    // schedule_id must not quietly become "create a new schedule"
    const hasId = payload.schedule_id !== undefined && payload.schedule_id !== null
    if (hasId && (typeof payload.schedule_id !== 'string' || !UUID_RE.test(payload.schedule_id))) {
      return { status: 400, body: { ok: false, error: 'invalid_schedule_id' } }
    }
    const scheduleId = hasId ? String(payload.schedule_id) : null
    if (typeof payload.title !== 'string'
      || typeof payload.day_of_month !== 'number' || !Number.isInteger(payload.day_of_month)
      || typeof payload.send_minute !== 'number' || !Number.isInteger(payload.send_minute)
      || typeof payload.enabled !== 'boolean') {
      return { status: 400, body: { ok: false, error: 'bad_request' } }
    }
    if (payload.kind !== undefined && payload.kind !== 'reminder' && payload.kind !== 'product_report') {
      return { status: 400, body: { ok: false, error: 'bad_request' } }
    }
    if (payload.report_currency !== undefined && payload.report_currency !== null && typeof payload.report_currency !== 'string') {
      return { status: 400, body: { ok: false, error: 'bad_request' } }
    }
    // the creation cap lives ATOMICALLY inside reminder_save_schedule (account row lock) —
    // its 'schedule_limit' refusal passes through below like every other typed reason
    // the SERVER clock is the only time source: whatever the client put in the body
    // (p_now, now, enabled_at …) is never read
    const { data, error } = await ctx.race(Promise.resolve(deps.admin.rpc('reminder_save_schedule', {
      p_account_id: accountId,
      p_schedule_id: scheduleId,
      p_title: payload.title,
      p_day_of_month: payload.day_of_month,
      p_send_minute: payload.send_minute,
      p_enabled: payload.enabled,
      p_now: new Date(nowMs()).toISOString(),
      p_kind: payload.kind ?? 'reminder',
      p_report_currency: typeof payload.report_currency === 'string' ? payload.report_currency : null,
    })))
    ctx.checkpoint()
    if (error) return { status: 503, body: { ok: false, error: 'save_failed' } }
    const outcome = (data ?? null) as { ok?: boolean; reason?: string; schedule?: unknown } | null
    if (!outcome || outcome.ok !== true) {
      // the RPC's typed refusal passes through verbatim — the UI phrases it
      return { status: 200, body: { ok: false, error: outcome?.reason ?? 'save_failed' } }
    }
    return { status: 200, body: { ok: true, schedule: outcome.schedule ?? null } }
  }

  return { status: 400, body: { ok: false, error: 'unknown_action' } }
}
