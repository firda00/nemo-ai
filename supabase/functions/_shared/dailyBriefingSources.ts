// Daily-briefing source adapters — foundation layer only (no endpoint, no consent, no delivery).
//
// Contract agreed with Codex before implementation (incl. the early-review fixes):
//   • fetch is INJECTED and every adapter owns ONE end-to-end deadline (≤10s, a public invariant —
//     caller-supplied timeouts are clamped) covering every request AND body read. The budget races
//     the fetch and each stream read, so an injected fetch that ignores the signal, or a stalled
//     body stream, still ends at the deadline.
//   • URLs are built here from typed parameters against a fixed https host allowlist; an arbitrary
//     source URL or a credential sent to the wrong host is not expressible through this module.
//   • redirect: 'error' on every request, so a bearer/appid can never follow a redirect elsewhere.
//   • The envelope's `source` is a fixed public identifier — it NEVER carries an appid or token,
//     and failure details are fixed slugs, never raw error text (which could echo a URL).
//   • 'partial' requires valid prior data. No collected events + a page failure (or unexhausted
//     pages) is 'unavailable' — it must never masquerade as a complete empty calendar.
//   • Values are validated, never coerced: a missing rate is not 0, a future effective date or
//     observation is not fresh data, and 2026-99-99T25:99 is not a timestamp.
//   • Nothing here retries a paid provider and nothing stores or refreshes credentials. This module
//     deliberately does NOT touch googleAccessToken (it deletes tenant rows on invalid_client).
export type SectionStatus = 'ready' | 'stale' | 'partial' | 'unavailable'

export interface SectionBase {
  status: SectionStatus
  /** Fixed public source identifier (host or host/path). Never contains credentials. */
  source: string
  /** ISO time the adapter finished, from the injected clock. */
  fetchedAt: string
  /** Fixed machine slug explaining a degraded status. Never raw error/provider text. */
  detail?: string
}

export interface UsdRateSection extends SectionBase {
  data?: { ratePerUnit: number; nominal: number; rate: number; effectiveDate: string; requestedDate: string }
}
export interface WeatherSection extends SectionBase {
  data?: { tempC: number; feelsLikeC?: number; description?: string; place?: string; observedAt: string }
}
export interface CalendarEvent { id: string; title: string; allDay: boolean; start: string; end?: string }
export interface CalendarSection extends SectionBase {
  data?: { events: CalendarEvent[]; truncated: boolean }
}
export interface NewsHeadline { title: string; source: string; publishedAt: string; link?: string }
export interface NewsSection extends SectionBase { data?: { headlines: NewsHeadline[] } }

export type FetchLike = (
  url: string,
  init: { headers?: Record<string, string>; signal: AbortSignal; redirect: 'error'; method?: string; body?: string },
) => Promise<Response>

const MAX_BODY_BYTES = 256 * 1024
const MAX_TIMEOUT_MS = 10_000
const WEATHER_CLOCK_SKEW_MS = 5 * 60_000
const ALLOWED_HOSTS = new Set(['cbu.uz', 'api.openweathermap.org', 'www.googleapis.com', 'www.spot.uz', 'www.gazeta.uz'])

// VERIFIED public RSS endpoints (probed live 2026-09-05: HTTP 200, application/rss+xml, valid
// RSS 2.0). spot.uz covers business/economics, gazeta.uz general + world. Never guessed URLs:
// kun.uz and daryo.uz candidates were probed too and rejected (404 / HTML).
export const NEWS_FEEDS = [
  'https://www.spot.uz/rss/',
  'https://www.gazeta.uz/ru/rss/',
] as const

export const CBU_SOURCE = 'cbu.uz'
export const WEATHER_SOURCE = 'api.openweathermap.org'
export const CALENDAR_SOURCE = 'www.googleapis.com/calendar'
export const NEWS_SOURCE = 'news'

export function assertAllowedBriefingUrl(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error('BRIEFING_SOURCE_HOST_BLOCKED')
  }
}

/** Options must be finite integers within bounds; anything else falls back — never NaN math. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

interface Budget {
  signal: AbortSignal
  /** Rejects with BRIEFING_SOURCE_TIMEOUT when the deadline fires — raced against every await. */
  expired: Promise<never>
  finish: () => void
}

// One deadline for the whole adapter call: pages, fetches and body reads all consume it.
function openBudget(timeoutMs: number): Budget {
  const controller = new AbortController()
  let expire: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {}) // the deadline may fire when nobody is racing — never an unhandled rejection
  const timer = setTimeout(() => { controller.abort(); expire(new Error('BRIEFING_SOURCE_TIMEOUT')) }, timeoutMs)
  return { signal: controller.signal, expired, finish: () => clearTimeout(timer) }
}

async function readBoundedText(response: Response, budget: Budget): Promise<string> {
  const body = response.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        // Race the read against the deadline: a stalled stream must not outlive the budget.
        const { done, value } = await Promise.race([reader.read(), budget.expired])
        if (done) break
        total += value.byteLength
        if (total > MAX_BODY_BYTES) throw new Error('BRIEFING_SOURCE_BODY_TOO_LARGE')
        chunks.push(value)
      }
    } catch (error) {
      // Fire-and-forget: cancel() delegates to the underlying source, which may itself never
      // settle — awaiting it would let cleanup outlive the deadline the caller was promised.
      void reader.cancel().catch(() => {})
      throw error
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(merged)
  }
  const text = await Promise.race([response.text(), budget.expired])
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('BRIEFING_SOURCE_BODY_TOO_LARGE')
  return text
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  budget: Budget,
  headers?: Record<string, string>,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  assertAllowedBriefingUrl(url)
  // Race the fetch too: an injected fetch that ignores the signal still ends at the deadline.
  const response = await Promise.race([fetchImpl(url, { headers, signal: budget.signal, redirect: 'error' }), budget.expired])
  if (!response.ok) return { ok: false, status: response.status, json: null }
  const text = await readBoundedText(response, budget)
  try {
    return { ok: true, status: response.status, json: JSON.parse(text) }
  } catch {
    throw new Error('BRIEFING_SOURCE_BAD_JSON')
  }
}

// Raw provider errors can echo the request URL (with a key in it) — map to fixed slugs only.
function failureSlug(error: unknown, aborted: boolean): string {
  const message = error instanceof Error ? error.message : ''
  if (message === 'BRIEFING_SOURCE_BODY_TOO_LARGE') return 'body_too_large'
  if (message === 'BRIEFING_SOURCE_BAD_JSON') return 'bad_json'
  if (message === 'BRIEFING_SOURCE_TIMEOUT') return 'timeout'
  if (aborted || (error instanceof Error && error.name === 'AbortError')) return 'timeout'
  return 'network'
}

// Missing values must never become 0: a rate of 0 is a lie, an absent rate is 'unavailable'.
function parseStrictPositive(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Number(value.trim().replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

// Regex admits the shape; the checks below close what Date.parse would quietly repair.
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
function parseRfc3339Ms(value: unknown): number | null {
  if (typeof value !== 'string' || !RFC3339_RE.test(value)) return null
  // Date.parse NORMALIZES impossible calendar dates (Feb 30 → Mar 2) and accepts the 24:00
  // rollover — both would silently move an event to a day nobody wrote. Validate the date
  // prefix as a real calendar date and keep hours within 00-23 before trusting the parse.
  if (!isValidIsoDate(value.slice(0, 10))) return null
  if (Number(value.slice(11, 13)) > 23) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Tashkent is fixed UTC+5 with no DST, so calendar day math is pure arithmetic. */
export function tashkentDateString(now: Date): string {
  return new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
}

function nextIsoDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day) + 86_400_000).toISOString().slice(0, 10)
}

function sanitizeText(value: unknown, max = 200): string {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point here
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

// ── CBU USD — official date-addressed JSON, one request, no prior-day fanout ─────────────────────
export async function fetchCbuUsdRate(
  fetchImpl: FetchLike,
  options: { date: string; timeoutMs?: number; now?: () => Date },
): Promise<UsdRateSection> {
  const now = options.now ?? (() => new Date())
  const fail = (detail: string): UsdRateSection => ({ status: 'unavailable', source: CBU_SOURCE, fetchedAt: now().toISOString(), detail })
  // A malformed or future date must be refused before any network spend.
  if (!isValidIsoDate(options.date) || options.date > tashkentDateString(now())) return fail('invalid_date')

  const budget = openBudget(clampInt(options.timeoutMs, MAX_TIMEOUT_MS, 1, MAX_TIMEOUT_MS))
  try {
    const { ok, status, json } = await requestJson(
      fetchImpl, `https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/${options.date}/`, budget,
    )
    if (!ok) return fail(status === 404 ? 'no_record' : 'http_error')
    if (!Array.isArray(json)) return fail('bad_shape')
    const record = json.find((row) => (row as { Ccy?: unknown })?.Ccy === 'USD') as
      { Nominal?: unknown; Rate?: unknown; Date?: unknown } | undefined
    if (!record) return fail('no_record')
    const nominal = parseStrictPositive(record.Nominal)
    const rate = parseStrictPositive(record.Rate)
    const rawDate = typeof record.Date === 'string' ? record.Date : ''
    const dateMatch = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(rawDate.trim())
    const effectiveDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null
    if (nominal === null || rate === null || !effectiveDate || !isValidIsoDate(effectiveDate)) return fail('bad_record')
    // A rate "effective" AFTER the requested day is not an archive record — refuse it.
    if (effectiveDate > options.date) return fail('bad_record')
    const ratePerUnit = rate / nominal
    if (!Number.isFinite(ratePerUnit)) return fail('bad_record')
    return {
      status: effectiveDate === options.date ? 'ready' : 'stale',
      source: CBU_SOURCE,
      fetchedAt: now().toISOString(),
      data: { ratePerUnit, nominal, rate, effectiveDate, requestedDate: options.date },
    }
  } catch (error) {
    return fail(failureSlug(error, budget.signal.aborted))
  } finally {
    budget.finish()
  }
}

// ── OpenWeather current conditions — key is a parameter, never stored or echoed ──────────────────
export async function fetchOpenWeather(
  fetchImpl: FetchLike,
  options: { lat: number; lon: number; apiKey: string; lang?: string; timeoutMs?: number; staleAfterMs?: number; now?: () => Date },
): Promise<WeatherSection> {
  const now = options.now ?? (() => new Date())
  const fail = (detail: string): WeatherSection => ({ status: 'unavailable', source: WEATHER_SOURCE, fetchedAt: now().toISOString(), detail })
  // A missing key or bad coordinates must produce ZERO requests.
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim()) return fail('missing_key')
  if (!Number.isFinite(options.lat) || Math.abs(options.lat) > 90 || !Number.isFinite(options.lon) || Math.abs(options.lon) > 180) {
    return fail('invalid_coords')
  }

  const budget = openBudget(clampInt(options.timeoutMs, MAX_TIMEOUT_MS, 1, MAX_TIMEOUT_MS))
  try {
    const query = new URLSearchParams({
      lat: String(options.lat), lon: String(options.lon), units: 'metric',
      lang: /^[a-z]{2}$/.test(options.lang ?? '') ? String(options.lang) : 'en',
      appid: options.apiKey.trim(),
    })
    const { ok, json } = await requestJson(fetchImpl, `https://api.openweathermap.org/data/2.5/weather?${query}`, budget)
    if (!ok) return fail('http_error')
    const payload = json as { main?: { temp?: unknown; feels_like?: unknown }; weather?: Array<{ description?: unknown }>; name?: unknown; dt?: unknown }
    const temp = payload?.main?.temp
    const dt = payload?.dt
    // A reading without a finite temperature or a valid observation time is not a reading.
    if (typeof temp !== 'number' || !Number.isFinite(temp)) return fail('bad_record')
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0) return fail('bad_record')
    const observedMs = dt * 1000
    // An observation from the future (beyond small clock skew) is corrupt, not fresh.
    if (observedMs > now().getTime() + WEATHER_CLOCK_SKEW_MS) return fail('bad_record')
    const feels = payload?.main?.feels_like
    return {
      status: now().getTime() - observedMs > (options.staleAfterMs ?? 3 * 3_600_000) ? 'stale' : 'ready',
      source: WEATHER_SOURCE,
      fetchedAt: now().toISOString(),
      data: {
        tempC: temp,
        feelsLikeC: typeof feels === 'number' && Number.isFinite(feels) ? feels : undefined,
        description: typeof payload?.weather?.[0]?.description === 'string' ? sanitizeText(payload.weather[0].description, 80) : undefined,
        place: typeof payload?.name === 'string' ? sanitizeText(payload.name, 80) : undefined,
        observedAt: new Date(observedMs).toISOString(),
      },
    }
  } catch (error) {
    return fail(failureSlug(error, budget.signal.aborted))
  } finally {
    budget.finish()
  }
}

// ── Google Calendar events for one Tashkent day — token is a parameter, ≤2 pages ─────────────────
export async function fetchCalendarDayEvents(
  fetchImpl: FetchLike,
  options: { accessToken: string; date: string; timeoutMs?: number; maxResults?: number; maxPages?: number; now?: () => Date },
): Promise<CalendarSection> {
  const now = options.now ?? (() => new Date())
  const fail = (detail: string): CalendarSection => ({ status: 'unavailable', source: CALENDAR_SOURCE, fetchedAt: now().toISOString(), detail })
  if (typeof options.accessToken !== 'string' || !options.accessToken.trim()) return fail('missing_token')
  if (!isValidIsoDate(options.date)) return fail('invalid_date')

  const budget = openBudget(clampInt(options.timeoutMs, MAX_TIMEOUT_MS, 1, MAX_TIMEOUT_MS))
  const maxPages = clampInt(options.maxPages, 2, 1, 5)
  const maxResults = clampInt(options.maxResults, 50, 1, 250)
  const events: CalendarEvent[] = []
  const seenIds = new Set<string>()
  let invalidCount = 0
  let pageFailed = false
  let morePages = false
  let firstPageFailure: string | null = null

  try {
    let pageToken = ''
    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams({
        timeMin: `${options.date}T00:00:00+05:00`,
        timeMax: `${nextIsoDate(options.date)}T00:00:00+05:00`,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(maxResults),
      })
      if (pageToken) query.set('pageToken', pageToken)
      let payload: { items?: unknown; nextPageToken?: unknown }
      try {
        const { ok, status, json } = await requestJson(
          fetchImpl,
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`,
          budget,
          { Authorization: `Bearer ${options.accessToken.trim()}` },
        )
        if (!ok) throw new Error(status === 401 || status === 403 ? 'BRIEFING_SOURCE_AUTH' : 'BRIEFING_SOURCE_HTTP')
        payload = json as { items?: unknown; nextPageToken?: unknown }
        // A response without an items array is an invalid shape, not an empty calendar.
        if (!Array.isArray(payload.items)) throw new Error('BRIEFING_SOURCE_BAD_SHAPE')
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        const slug = message === 'BRIEFING_SOURCE_AUTH' ? 'auth'
          : message === 'BRIEFING_SOURCE_HTTP' ? 'http_error'
          : message === 'BRIEFING_SOURCE_BAD_SHAPE' ? 'bad_shape'
          : failureSlug(error, budget.signal.aborted)
        if (page === 0) { firstPageFailure = slug } else { pageFailed = true }
        break
      }
      for (const raw of payload.items as unknown[]) {
        const item = raw as { id?: unknown; status?: unknown; summary?: unknown; start?: { date?: unknown; dateTime?: unknown }; end?: { date?: unknown; dateTime?: unknown } }
        if (item?.status === 'cancelled') continue // cancelled is a valid, deliberate absence
        const id = typeof item?.id === 'string' && item.id ? item.id : null
        // All-day dates and timed RFC3339 strings are kept VERBATIM once validated — no Date()
        // round-trip that could shift them across a UTC boundary. An end, when present, must be
        // valid and must not precede its start; otherwise the event shape is invalid.
        let event: Omit<CalendarEvent, 'id' | 'title'> | null = null
        if (isValidIsoDate(item?.start?.date)) {
          const start = String(item.start?.date)
          const endRaw = item?.end?.date
          if (endRaw === undefined || (isValidIsoDate(endRaw) && String(endRaw) >= start)) {
            event = { allDay: true, start, end: endRaw === undefined ? undefined : String(endRaw) }
          }
        } else {
          const startMs = parseRfc3339Ms(item?.start?.dateTime)
          if (startMs !== null) {
            const endRaw = item?.end?.dateTime
            if (endRaw === undefined) {
              event = { allDay: false, start: String(item.start?.dateTime) }
            } else {
              const endMs = parseRfc3339Ms(endRaw)
              if (endMs !== null && endMs >= startMs) event = { allDay: false, start: String(item.start?.dateTime), end: String(endRaw) }
            }
          }
        }
        if (!id || !event) { invalidCount += 1; continue }
        if (seenIds.has(id)) continue // page boundaries can repeat an event
        seenIds.add(id)
        events.push({ id, title: sanitizeText(item?.summary, 160), ...event })
      }
      pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : ''
      if (!pageToken) break
      if (page === maxPages - 1) morePages = true
    }
  } finally {
    budget.finish()
  }

  if (firstPageFailure) return fail(firstPageFailure)
  // 'partial' requires valid prior data. With nothing collected, a failed or unexhausted
  // pagination knows NOTHING — it must not claim a complete empty calendar either.
  if (events.length === 0) {
    if (pageFailed) return fail('page_failed')
    if (morePages) return fail('more_pages')
    if (invalidCount > 0) return fail('invalid_events')
    return { status: 'ready', source: CALENDAR_SOURCE, fetchedAt: now().toISOString(), data: { events: [], truncated: false } }
  }
  const detail = pageFailed ? 'page_failed' : morePages ? 'more_pages' : invalidCount > 0 ? 'invalid_events_skipped' : undefined
  return {
    status: detail ? 'partial' : 'ready',
    source: CALENDAR_SOURCE,
    fetchedAt: now().toISOString(),
    detail,
    data: { events, truncated: pageFailed || morePages },
  }
}

// ── News — interim stub: honestly unavailable. Kept for callers without a live fetch (and as
// the composer's degraded-path contract); the real adapter is fetchNewsHeadlines below. ─────────
export function newsSection(now: () => Date = () => new Date()): NewsSection {
  return { status: 'unavailable', source: NEWS_SOURCE, fetchedAt: now().toISOString(), detail: 'no_verified_adapter' }
}

const ITEM_RE = /<item>([\s\S]*?)<\/item>/g
// fetchedAt only proves RETRIEVAL — presenting an item as today's news requires its own
// publication date to be recent, and a missing/unparseable/future date disqualifies the item
const NEWS_FRESHNESS_MS = 48 * 3_600_000
const NEWS_FUTURE_SKEW_MS = 5 * 60_000
const LINK_RE = /^https?:\/\/\S{1,300}$/

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
}

function pickTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>(?:\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`).exec(block)
  return match ? (match[1] ?? match[2] ?? '').trim() : null
}

// ── News headlines from the VERIFIED feeds — titles are DATA, one budget covers both feeds ──────
export async function fetchNewsHeadlines(
  fetchImpl: FetchLike,
  options: { feeds?: readonly string[]; timeoutMs?: number; maxHeadlines?: number; now?: () => Date } = {},
): Promise<NewsSection> {
  const now = options.now ?? (() => new Date())
  const feeds = (options.feeds ?? NEWS_FEEDS).slice(0, 4)
  const maxHeadlines = clampInt(options.maxHeadlines, 3, 1, 10)
  const source = feeds.map((feed) => { try { return new URL(feed).hostname.replace(/^www\./, '') } catch { return 'news' } }).join('+')
  const fail = (detail: string): NewsSection => ({ status: 'unavailable', source, fetchedAt: now().toISOString(), detail })
  if (!feeds.length) return fail('no_feeds')

  const budget = openBudget(clampInt(options.timeoutMs, MAX_TIMEOUT_MS, 1, MAX_TIMEOUT_MS))
  let failedFeeds = 0
  const headlines: NewsHeadline[] = []
  try {
    const perFeed = await Promise.all(feeds.map(async (feed): Promise<NewsHeadline[]> => {
      try {
        assertAllowedBriefingUrl(feed)
        const response = await Promise.race([fetchImpl(feed, { signal: budget.signal, redirect: 'error' }), budget.expired])
        if (!response.ok) throw new Error('BRIEFING_SOURCE_HTTP')
        const xml = await readBoundedText(response, budget)
        const host = new URL(feed).hostname.replace(/^www\./, '')
        const nowMs = now().getTime()
        const found: NewsHeadline[] = []
        for (const match of xml.matchAll(ITEM_RE)) {
          const block = match[1]
          const title = sanitizeText(decodeXmlEntities(pickTag(block, 'title') ?? ''), 160)
          if (!title) continue
          // freshness gate: an item without a provably recent publication date is not news
          const publishedMs = Date.parse(pickTag(block, 'pubDate') ?? '')
          if (!Number.isFinite(publishedMs)) continue
          if (nowMs - publishedMs > NEWS_FRESHNESS_MS) continue // stale
          if (publishedMs - nowMs > NEWS_FUTURE_SKEW_MS) continue // future-dated is corrupt
          const rawLink = decodeXmlEntities(pickTag(block, 'link') ?? '')
          found.push({
            title,
            source: host,
            publishedAt: new Date(publishedMs).toISOString(),
            link: LINK_RE.test(rawLink) ? rawLink : undefined,
          })
          if (found.length >= maxHeadlines) break
        }
        return found
      } catch {
        failedFeeds += 1
        return []
      }
    }))
    // interleave: one from each feed in turn, so a single feed cannot crowd the section;
    // mirrored stories (same title+link across feeds) collapse to one
    const seen = new Set<string>()
    for (let index = 0; index < maxHeadlines; index += 1) {
      for (const list of perFeed) {
        const candidate = list[index]
        if (!candidate || headlines.length >= maxHeadlines) continue
        const key = `${candidate.title}|${candidate.link ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        headlines.push(candidate)
      }
    }
  } finally {
    budget.finish()
  }
  if (headlines.length === 0) return fail(failedFeeds === feeds.length ? 'network' : 'no_items')
  return {
    status: failedFeeds > 0 ? 'partial' : 'ready',
    source,
    fetchedAt: now().toISOString(),
    detail: failedFeeds > 0 ? 'feed_failed' : undefined,
    data: { headlines },
  }
}
