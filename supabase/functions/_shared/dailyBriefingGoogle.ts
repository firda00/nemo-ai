// Google Calendar access for the daily briefing — token refresh kept OUT of the pure sources
// module, with everything injected (db, fetch, decrypt) so it is testable offline.
//
// Rules agreed with Codex (incl. the first Step-2a diff review):
//   • ONE budget (≤10s) bounds the WHOLE flow — lookups, refresh AND calendar; the calendar call
//     gets only the remaining time, and NO failure path escapes as an exception: the outer catch
//     maps everything to a fixed slug.
//   • The scope check requires an EXACT events-read scope (calendar / calendar.readonly /
//     calendar.events / calendar.events.readonly) — calendar.settings.readonly or freebusy do
//     not grant event reads and must refuse BEFORE any refresh or API spend.
//   • Only a genuinely ABSENT google_oauth_apps row may use the shared env app; a DB error or a
//     present-but-malformed row must fail (a refresh_token can only be exchanged by the app that
//     issued it; the wrong app reads as invalid_client).
//   • The token response body is read BOUNDED and a token is accepted only from an HTTP-success
//     response; invalid_grant / invalid_client map to a fixed 'auth' slug and NOTHING is deleted
//     or written — this module has no write capability by construction, unlike the shared
//     googleAccessToken helper which deletes the google_accounts row on invalid_client.
//   • No credential ever appears in the returned envelope or in a detail slug.
import {
  CALENDAR_SOURCE,
  fetchCalendarDayEvents,
  type CalendarSection,
  type FetchLike,
} from './dailyBriefingSources.ts'

const TOKEN_URL = 'https://oauth2.googleapis.com/token' // fixed — never interpolated
const MAX_TIMEOUT_MS = 10_000
const MAX_TOKEN_BODY_BYTES = 64 * 1024
// Exact scopes that grant reading events; anything else (settings.readonly, freebusy, addons…)
// cannot serve events.list and must be refused before any spend.
const EVENTS_READ_SCOPES = new Set([
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.readonly',
])

export interface GoogleCalendarDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client shape
  db: any
  fetchImpl: FetchLike
  /** Opens a sealed secret for this account. Injected so tests never touch real crypto. */
  decrypt: (sealed: string, accountId: string, purpose: 'google-client-secret' | 'google-refresh-token') => Promise<string>
  /** The shared Nemo OAuth app from env — used ONLY when the account has no app row at all. */
  envApp: { id: string; secret: string }
  now?: () => Date
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

class BriefingGoogleFailure extends Error {
  constructor(public readonly slug: string) { super(`BRIEFING_GOOGLE_${slug}`) }
}

// Streamed, capped token-body read: counting bytes as they arrive stops an oversized (or
// endless) body AT THE CAP — allocating the whole body first would defeat the bound. Each read
// races the shared deadline; cleanup is fire-and-forget like the sources module.
async function readBoundedTokenBody(response: Response, expired: Promise<never>): Promise<string> {
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
        if (total > MAX_TOKEN_BODY_BYTES) throw new BriefingGoogleFailure('network')
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
  if (new TextEncoder().encode(text).byteLength > MAX_TOKEN_BODY_BYTES) throw new BriefingGoogleFailure('network')
  return text
}

export async function fetchOwnerCalendarSection(
  deps: GoogleCalendarDeps,
  options: { accountId: string; date: string; timeoutMs?: number },
): Promise<CalendarSection> {
  const now = deps.now ?? (() => new Date())
  const fail = (detail: string): CalendarSection => ({ status: 'unavailable', source: CALENDAR_SOURCE, fetchedAt: now().toISOString(), detail })

  const timeoutMs = clampInt(options.timeoutMs, MAX_TIMEOUT_MS, 1, MAX_TIMEOUT_MS)
  const deadlineAt = Date.now() + timeoutMs
  const controller = new AbortController()
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const timer = setTimeout(() => { controller.abort(); expire(new Error('BRIEFING_GOOGLE_TIMEOUT')) }, timeoutMs)

  try {
    // 1) Connection + scope — refuse BEFORE any refresh or API spend.
    const { data: account, error: accountError } = await Promise.race([
      deps.db.from('google_accounts').select('refresh_token, scopes').eq('account_id', options.accountId).maybeSingle(),
      expired,
    ])
    if (accountError) throw new BriefingGoogleFailure('db_error')
    if (!account?.refresh_token) throw new BriefingGoogleFailure('not_connected')
    const scopeText = Array.isArray(account.scopes) ? account.scopes.join(' ') : String(account.scopes ?? '')
    const grantedScopes = scopeText.split(/[\s,]+/).filter(Boolean)
    if (!grantedScopes.some((scope) => EVENTS_READ_SCOPES.has(scope))) throw new BriefingGoogleFailure('no_scope')

    // 2) Which OAuth app issued the refresh token. A DB ERROR is not "no row", and a PRESENT but
    // malformed row is not "no row" either — only a truly absent row may use the shared env app.
    const { data: app, error: appError } = await Promise.race([
      deps.db.from('google_oauth_apps').select('client_id, client_secret').eq('account_id', options.accountId).maybeSingle(),
      expired,
    ])
    if (appError) throw new BriefingGoogleFailure('db_error')
    let clientId: string
    let clientSecret: string
    if (app === null || app === undefined) {
      clientId = deps.envApp.id
      clientSecret = deps.envApp.secret
    } else {
      clientId = typeof app.client_id === 'string' ? app.client_id.trim() : ''
      const sealedSecret = typeof app.client_secret === 'string' ? app.client_secret : ''
      if (!clientId || !sealedSecret) throw new BriefingGoogleFailure('no_app')
      try {
        clientSecret = await Promise.race([deps.decrypt(sealedSecret, options.accountId, 'google-client-secret'), expired])
      } catch (error) {
        if (error instanceof Error && error.message === 'BRIEFING_GOOGLE_TIMEOUT') throw error
        throw new BriefingGoogleFailure('secret_unreadable')
      }
    }
    if (!clientId || !clientSecret) throw new BriefingGoogleFailure('no_app')

    let refreshToken: string
    try {
      refreshToken = await Promise.race([deps.decrypt(String(account.refresh_token), options.accountId, 'google-refresh-token'), expired])
    } catch (error) {
      if (error instanceof Error && error.message === 'BRIEFING_GOOGLE_TIMEOUT') throw error
      throw new BriefingGoogleFailure('secret_unreadable')
    }
    if (!refreshToken) throw new BriefingGoogleFailure('secret_unreadable')

    // 3) Refresh — fixed URL, redirect blocked, bounded body, HTTP success required for a token.
    const response = await Promise.race([
      deps.fetchImpl(TOKEN_URL, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
        redirect: 'error',
        method: 'POST',
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
      }),
      expired,
    ])
    const bodyText = await readBoundedTokenBody(response, expired)
    let payload: { error?: unknown; access_token?: unknown } | null = null
    try { payload = JSON.parse(bodyText) } catch { payload = null }
    if (payload?.error === 'invalid_grant' || payload?.error === 'invalid_client') throw new BriefingGoogleFailure('auth')
    if (!response.ok) throw new BriefingGoogleFailure(response.status >= 500 ? 'network' : 'auth')
    if (typeof payload?.access_token !== 'string' || !payload.access_token) throw new BriefingGoogleFailure('auth')

    // 4) Calendar gets only what is LEFT of the shared budget.
    const remaining = deadlineAt - Date.now()
    if (remaining < 250) throw new BriefingGoogleFailure('timeout')
    return await fetchCalendarDayEvents(deps.fetchImpl, {
      accessToken: payload.access_token, date: options.date, timeoutMs: Math.min(remaining, MAX_TIMEOUT_MS), now,
    })
  } catch (error) {
    // Nothing escapes as an exception: every failure becomes a fixed-slug envelope.
    if (error instanceof BriefingGoogleFailure) return fail(error.slug)
    const timedOut = controller.signal.aborted
      || (error instanceof Error && (error.message === 'BRIEFING_GOOGLE_TIMEOUT' || error.name === 'AbortError'))
    return fail(timedOut ? 'timeout' : 'network')
  } finally {
    clearTimeout(timer)
  }
}
