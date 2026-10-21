// Daily-briefing foundation — deterministic offline tests. Every network interaction is a scripted
// mock; a real host is never contacted and no credential ever leaves the injected parameters.
import { describe, expect, test } from 'vitest'
import {
  assertAllowedBriefingUrl,
  fetchCalendarDayEvents,
  fetchCbuUsdRate,
  fetchNewsHeadlines,
  fetchOpenWeather,
  newsSection,
  tashkentDateString,
  type CalendarSection,
  type FetchLike,
  type NewsSection,
  type UsdRateSection,
  type WeatherSection,
} from '../supabase/functions/_shared/dailyBriefingSources.ts'
import {
  composeEveningBriefing,
  composeMorningBriefing,
  type EveningTasksSection,
} from '../supabase/functions/_shared/dailyBriefing.ts'

const NOW = () => new Date('2026-09-05T02:59:00Z') // 07:59 in Tashkent (UTC+5)

type Handler = (url: string, init: { headers?: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Response | Promise<Response>

function scriptedFetch(handlers: Handler[]) {
  const calls: Array<{ url: string; init: { headers?: Record<string, string>; signal: AbortSignal; redirect: 'error' } }> = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)]
    return handler(url, init)
  }
  return { impl, calls }
}

const json = (value: unknown, status = 200) => () => new Response(JSON.stringify(value), { status })
const raw = (text: string, status = 200) => () => new Response(text, { status })
// A hostile injected fetch that IGNORES the abort signal entirely — the budget race must win.
const hangIgnoringSignal: Handler = () => new Promise<Response>(() => {})
// A response whose body stream stalls forever after the first chunk.
const stalledStream: Handler = () => new Response(new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new TextEncoder().encode('[')) },
  pull() { return new Promise<void>(() => {}) },
}))
// Worse: the stream ALSO refuses to settle its own cancel() — cleanup must not be awaited.
const stalledCancel: Handler = () => new Response(new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new TextEncoder().encode('[')) },
  pull() { return new Promise<void>(() => {}) },
  cancel() { return new Promise<void>(() => {}) },
}))

const CBU_ROW = { id: 69, Code: '840', Ccy: 'USD', Nominal: '1', Rate: '12650.44', Date: '05.09.2026' }

describe('CBU USD adapter', () => {
  test('ready: same-day record parsed with Nominal divisor', async () => {
    const { impl, calls } = scriptedFetch([json([{ ...CBU_ROW, Nominal: '10', Rate: '126504.40' }])])
    const section = await fetchCbuUsdRate(impl, { date: '2026-09-05', now: NOW })
    expect(section.status).toBe('ready')
    expect(section.data?.ratePerUnit).toBeCloseTo(12650.44, 2)
    expect(section.data?.effectiveDate).toBe('2026-09-05')
    expect(calls).toHaveLength(1)
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].url).toBe('https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/2026-09-05/')
  })

  test('stale: an EARLIER effective date is reported, not hidden', async () => {
    const now = () => new Date('2026-09-06T02:59:00Z')
    const { impl } = scriptedFetch([json([CBU_ROW])])
    const section = await fetchCbuUsdRate(impl, { date: '2026-09-06', now })
    expect(section.status).toBe('stale')
    expect(section.data?.effectiveDate).toBe('2026-09-05')
    expect(section.data?.requestedDate).toBe('2026-09-06')
  })

  test('a FUTURE effective date is a corrupt record, never stale data', async () => {
    const { impl } = scriptedFetch([json([{ ...CBU_ROW, Date: '06.09.2026' }])])
    const section = await fetchCbuUsdRate(impl, { date: '2026-09-05', now: NOW })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'bad_record' })
    expect(section.data).toBeUndefined()
  })

  test('empty payload and wrong currency are unavailable, never a zero rate', async () => {
    for (const payload of [[], [{ ...CBU_ROW, Ccy: 'EUR' }]]) {
      const { impl } = scriptedFetch([json(payload)])
      const section = await fetchCbuUsdRate(impl, { date: '2026-09-05', now: NOW })
      expect(section).toMatchObject({ status: 'unavailable', detail: 'no_record' })
      expect(section.data).toBeUndefined()
    }
  })

  test('nonpositive, NaN, missing or overflowing Nominal/Rate is rejected without coercion', async () => {
    const badRows = [
      { ...CBU_ROW, Nominal: '0' },
      { ...CBU_ROW, Rate: 'abc' },
      { ...CBU_ROW, Rate: undefined },
      { ...CBU_ROW, Nominal: '-1' },
      { ...CBU_ROW, Date: '2026/09/05' },
      { ...CBU_ROW, Rate: '1e308', Nominal: '1e-300' }, // division overflows to Infinity
    ]
    for (const row of badRows) {
      const { impl } = scriptedFetch([json([row])])
      const section = await fetchCbuUsdRate(impl, { date: '2026-09-05', now: NOW })
      expect(section.status).toBe('unavailable')
      expect(section.detail).toBe('bad_record')
      expect(section.data).toBeUndefined()
    }
  })

  test('future and malformed request dates are refused with zero requests', async () => {
    for (const date of ['2026-09-06', '2026-13-05', 'tomorrow', '2026-09-31']) {
      const { impl, calls } = scriptedFetch([json([CBU_ROW])])
      const section = await fetchCbuUsdRate(impl, { date, now: NOW })
      expect(section).toMatchObject({ status: 'unavailable', detail: 'invalid_date' })
      expect(calls).toHaveLength(0)
    }
  })

  test('real malformed JSON body is unavailable/bad_json', async () => {
    const { impl } = scriptedFetch([raw('<html>maintenance</html>')])
    const section = await fetchCbuUsdRate(impl, { date: '2026-09-05', now: NOW })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'bad_json' })
  })

  test('a body over the cap is rejected as body_too_large', async () => {
    const { impl } = scriptedFetch([raw(JSON.stringify([{ ...CBU_ROW, note: 'x'.repeat(300_000) }]))])
    const section = await fetchCbuUsdRate(impl, { date: '2026-09-05', now: NOW })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'body_too_large' })
  })

  test('a fetch that ignores the abort signal still ends at the deadline', async () => {
    const { impl, calls } = scriptedFetch([hangIgnoringSignal])
    const section = await fetchCbuUsdRate(impl, { date: '2026-09-05', timeoutMs: 25, now: NOW })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'timeout' })
    expect(calls).toHaveLength(1) // no retry after the failure
  })

  test('a stalled body stream cannot outlive the deadline', async () => {
    const { impl } = scriptedFetch([stalledStream])
    const started = Date.now()
    const section = await fetchCbuUsdRate(impl, { date: '2026-09-05', timeoutMs: 25, now: NOW })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('a stream whose cancel() never settles still cannot outlive the deadline', async () => {
    const { impl } = scriptedFetch([stalledCancel])
    const started = Date.now()
    const section = await fetchCbuUsdRate(impl, { date: '2026-09-05', timeoutMs: 25, now: NOW })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('a non-integer timeout falls back safely instead of NaN math', async () => {
    const { impl } = scriptedFetch([json([CBU_ROW])])
    const section = await fetchCbuUsdRate(impl, { date: '2026-09-05', timeoutMs: Number.NaN, now: NOW })
    expect(section.status).toBe('ready')
  })
})

describe('OpenWeather adapter', () => {
  const weatherPayload = (dtEpochSeconds: number) => ({
    main: { temp: 21.4, feels_like: 20.1 },
    weather: [{ description: 'clear sky' }],
    name: 'Tashkent',
    dt: dtEpochSeconds,
  })

  test('ready: finite temp and fresh dt', async () => {
    const dt = Math.floor(NOW().getTime() / 1000) - 600
    const { impl, calls } = scriptedFetch([json(weatherPayload(dt))])
    const section = await fetchOpenWeather(impl, { lat: 41.311, lon: 69.28, apiKey: 'APIKEY123', now: NOW })
    expect(section.status).toBe('ready')
    expect(section.data?.tempC).toBeCloseTo(21.4)
    expect(section.data?.place).toBe('Tashkent')
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].url).toContain('units=metric')
  })

  test('explicit staleness threshold: 2h50m old is ready, 3h10m old is stale', async () => {
    const base = Math.floor(NOW().getTime() / 1000)
    for (const [ageSeconds, expected] of [[170 * 60, 'ready'], [190 * 60, 'stale']] as const) {
      const { impl } = scriptedFetch([json(weatherPayload(base - ageSeconds))])
      const section = await fetchOpenWeather(impl, { lat: 41.311, lon: 69.28, apiKey: 'APIKEY123', now: NOW })
      expect(section.status).toBe(expected)
    }
  })

  test('an observation from the future is corrupt beyond small clock skew', async () => {
    const base = Math.floor(NOW().getTime() / 1000)
    const { impl: withinSkew } = scriptedFetch([json(weatherPayload(base + 60))])
    expect((await fetchOpenWeather(withinSkew, { lat: 41.311, lon: 69.28, apiKey: 'APIKEY123', now: NOW })).status).toBe('ready')
    const { impl: farFuture } = scriptedFetch([json(weatherPayload(base + 3_600))])
    expect(await fetchOpenWeather(farFuture, { lat: 41.311, lon: 69.28, apiKey: 'APIKEY123', now: NOW }))
      .toMatchObject({ status: 'unavailable', detail: 'bad_record' })
  })

  test('missing key makes zero requests', async () => {
    const { impl, calls } = scriptedFetch([json({})])
    const section = await fetchOpenWeather(impl, { lat: 41.311, lon: 69.28, apiKey: '  ', now: NOW })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'missing_key' })
    expect(calls).toHaveLength(0)
  })

  test('non-finite temp or missing dt is not a reading', async () => {
    for (const payload of [
      { main: { temp: '21' }, dt: 1_757_000_000 },
      { main: { temp: 21 }, name: 'Tashkent' },
    ]) {
      const { impl } = scriptedFetch([json(payload)])
      const section = await fetchOpenWeather(impl, { lat: 41.311, lon: 69.28, apiKey: 'APIKEY123', now: NOW })
      expect(section).toMatchObject({ status: 'unavailable', detail: 'bad_record' })
    }
  })

  test('http 401 is unavailable and the key never leaks into the envelope', async () => {
    const { impl } = scriptedFetch([json({ cod: 401 }, 401)])
    const section = await fetchOpenWeather(impl, { lat: 41.311, lon: 69.28, apiKey: 'APIKEY123', now: NOW })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'http_error' })
    expect(JSON.stringify(section)).not.toContain('APIKEY123')
    expect(section.source).toBe('api.openweathermap.org')
  })
})

describe('Google Calendar adapter', () => {
  const TOKEN = 'ya29.SECRET-TOKEN'
  const timed = (id: string, hhmm: string, summary = `Event ${id}`) => ({
    id, summary, start: { dateTime: `2026-09-05T${hhmm}:00+05:00` }, end: { dateTime: `2026-09-05T${hhmm}:30+05:00` },
  })
  const page = (items: unknown[], nextPageToken?: string) => json({ items, nextPageToken })
  const run = (impl: FetchLike, extra: Record<string, unknown> = {}) =>
    fetchCalendarDayEvents(impl, { accessToken: TOKEN, date: '2026-09-05', now: NOW, ...extra })

  test('two pages merge in order, duplicates on the page boundary collapse', async () => {
    const { impl, calls } = scriptedFetch([
      page([timed('a', '09:00'), timed('b', '10:00')], 'p2'),
      page([timed('b', '10:00'), timed('c', '11:00')]),
    ])
    const section = await run(impl)
    expect(section.status).toBe('ready')
    expect(section.data?.events.map((event) => event.id)).toEqual(['a', 'b', 'c'])
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('timeMin=2026-09-05T00%3A00%3A00%2B05%3A00')
    expect(calls[0].url).toContain('timeMax=2026-09-06T00%3A00%3A00%2B05%3A00')
    expect(calls[0].url).toContain('singleEvents=true')
    expect(calls[0].url).toContain('orderBy=startTime')
    expect(calls[1].url).toContain('pageToken=p2')
    for (const call of calls) {
      expect(call.init.redirect).toBe('error')
      expect(call.init.headers?.Authorization).toBe(`Bearer ${TOKEN}`)
      expect(call.url).not.toContain(TOKEN)
    }
    expect(JSON.stringify(section)).not.toContain(TOKEN)
  })

  test('a token left after the page cap means partial + truncated, with the collected data kept', async () => {
    const { impl, calls } = scriptedFetch([
      page([timed('a', '09:00')], 'p2'),
      page([timed('b', '10:00')], 'p3'),
    ])
    const section = await run(impl)
    expect(section).toMatchObject({ status: 'partial', detail: 'more_pages' })
    expect(section.data?.truncated).toBe(true)
    expect(section.data?.events).toHaveLength(2)
    expect(calls).toHaveLength(2) // the third page is never requested
  })

  test('a failing second page degrades to partial ONLY because page one had valid data', async () => {
    const { impl } = scriptedFetch([
      page([timed('a', '09:00')], 'p2'),
      () => { throw new Error('socket reset') },
    ])
    const section = await run(impl)
    expect(section).toMatchObject({ status: 'partial', detail: 'page_failed' })
    expect(section.data?.events.map((event) => event.id)).toEqual(['a'])
  })

  test('an EMPTY first page + failing second page is unavailable — nothing valid was collected', async () => {
    const { impl } = scriptedFetch([page([], 'p2'), json(null, 503)])
    const section = await run(impl)
    expect(section).toMatchObject({ status: 'unavailable', detail: 'page_failed' })
    expect(section.data).toBeUndefined()
  })

  test('exhausted pages with nothing collected cannot claim a complete empty calendar', async () => {
    const { impl } = scriptedFetch([page([], 'p2'), page([], 'p3')])
    const section = await run(impl)
    expect(section).toMatchObject({ status: 'unavailable', detail: 'more_pages' })
    expect(section.data).toBeUndefined()
  })

  test('a failing FIRST page is unavailable — partial requires valid prior data', async () => {
    const { impl } = scriptedFetch([() => { throw new Error('socket reset') }])
    const section = await run(impl)
    expect(section).toMatchObject({ status: 'unavailable', detail: 'network' })
    expect(section.data).toBeUndefined()
  })

  test('401 maps to auth without mutating anything', async () => {
    const { impl } = scriptedFetch([json({ error: { code: 401 } }, 401)])
    expect(await run(impl)).toMatchObject({ status: 'unavailable', detail: 'auth' })
  })

  test('a payload without an items array is bad_shape, not an empty calendar', async () => {
    const { impl } = scriptedFetch([json({ kind: 'calendar#events' })])
    expect(await run(impl)).toMatchObject({ status: 'unavailable', detail: 'bad_shape' })
  })

  test('impossible timestamps and missing offsets are invalid events, not data', async () => {
    const badItems = [
      { id: 'imp', summary: 'x', start: { dateTime: '2026-99-99T25:99:00+05:00' } },
      { id: 'noofs', summary: 'x', start: { dateTime: '2026-09-05T09:00:00' } },
      { id: 'order', summary: 'x', start: { dateTime: '2026-09-05T10:00:00+05:00' }, end: { dateTime: '2026-09-05T09:00:00+05:00' } },
      { id: 'badend', summary: 'x', start: { date: '2026-09-05' }, end: { date: 'nonsense' } },
      // Date.parse would quietly repair both of these — Feb 30 becomes Mar 2, 24:00 rolls over
      // to the next day. Neither may pass as a written timestamp.
      { id: 'feb30', summary: 'x', start: { dateTime: '2026-02-30T09:00:00Z' } },
      { id: 'h24', summary: 'x', start: { dateTime: '2026-09-05T24:00:00+05:00' } },
    ]
    const { impl: allBad } = scriptedFetch([page(badItems)])
    expect(await run(allBad)).toMatchObject({ status: 'unavailable', detail: 'invalid_events' })
    const { impl: mixed } = scriptedFetch([page([timed('a', '09:00'), badItems[0]])])
    const section = await run(mixed)
    expect(section).toMatchObject({ status: 'partial', detail: 'invalid_events_skipped' })
    expect(section.data?.events).toHaveLength(1)
  })

  test('cancelled events are excluded and an honestly empty day stays ready', async () => {
    const { impl } = scriptedFetch([page([{ ...timed('a', '09:00'), status: 'cancelled' }])])
    const section = await run(impl)
    expect(section.status).toBe('ready')
    expect(section.data?.events).toHaveLength(0)
  })

  test('all-day dates stay verbatim strings — no UTC shift', async () => {
    const { impl } = scriptedFetch([page([{ id: 'rent', summary: 'Оплата аренды', start: { date: '2026-09-05' }, end: { date: '2026-09-06' } }])])
    const section = await run(impl)
    expect(section.data?.events[0]).toMatchObject({ allDay: true, start: '2026-09-05', end: '2026-09-06' })
  })

  test('one deadline spans all pages: a hung second page becomes partial with page-one data', async () => {
    const { impl } = scriptedFetch([page([timed('a', '09:00')], 'p2'), hangIgnoringSignal])
    const section = await run(impl, { timeoutMs: 25 })
    // later-page failures collapse into the fixed 'page_failed' slug whatever their cause;
    // 'timeout' is reserved for whole-adapter failures with nothing collected
    expect(section).toMatchObject({ status: 'partial', detail: 'page_failed' })
    expect(section.data?.events.map((event) => event.id)).toEqual(['a'])
  })

  test('non-integer maxPages/maxResults fall back to bounded defaults', async () => {
    const endless = [page([timed('a', '09:00')], 'p2'), page([timed('b', '10:00')], 'p3'), page([timed('c', '11:00')], 'p4')]
    const { impl, calls } = scriptedFetch(endless)
    const section = await run(impl, { maxPages: Number.POSITIVE_INFINITY, maxResults: Number.NaN })
    expect(calls).toHaveLength(2) // default page cap
    expect(calls[0].url).toContain('maxResults=50') // default results cap
    expect(section.status).toBe('partial')
  })

  test('missing token makes zero requests', async () => {
    const { impl, calls } = scriptedFetch([page([])])
    const section = await fetchCalendarDayEvents(impl, { accessToken: '', date: '2026-09-05', now: NOW })
    expect(section).toMatchObject({ status: 'unavailable', detail: 'missing_token' })
    expect(calls).toHaveLength(0)
  })
})

describe('news stub and URL guard', () => {
  test('news is explicitly unavailable — no fabricated headlines path exists', () => {
    const section = newsSection(NOW)
    expect(section).toMatchObject({ status: 'unavailable', source: 'news', detail: 'no_verified_adapter' })
    expect(section.data).toBeUndefined()
  })

  // fixtures default to FRESH publication dates relative to the fixed NOW (07:59 Tashkent)
  const FRESH = 'Fri, 05 Sep 2026 07:30:00 +0500' // 29 minutes before NOW, RFC 822 form
  const item = (title: string, pubDate: string | null = FRESH, link: string | null = 'https://www.spot.uz/article/1') =>
    `<item><title>${title}</title>${link === null ? '' : `<link>${link}</link>`}${pubDate === null ? '' : `<pubDate>${pubDate}</pubDate>`}</item>`
  const rss = (...items: string[]) => `<?xml version="1.0"?><rss><channel><title>Feed</title>${items.join('')}</channel></rss>`

  test('verified feeds parse: CDATA/entities decoded, sources attributed, links and dates carried', async () => {
    const { impl, calls } = scriptedFetch([
      (url) => url.includes('spot')
        ? raw(rss(item('<![CDATA[Спот: курс &amp; налоги]]>'), item('Spot 2', '2026-09-05T02:00:00Z', null)))()
        : raw(rss(item('Газета &quot;мир&quot;', FRESH, 'https://www.gazeta.uz/ru/2026/09/05/x/'), item('Gazeta 2')))(),
    ])
    const section = await fetchNewsHeadlines(impl, { now: NOW })
    expect(section.status).toBe('ready')
    expect(section.source).toBe('spot.uz+gazeta.uz')
    expect(section.data?.headlines.map((h) => h.title)).toEqual(['Спот: курс & налоги', 'Газета "мир"', 'Spot 2'])
    expect(section.data?.headlines[0]).toMatchObject({ source: 'spot.uz', link: 'https://www.spot.uz/article/1', publishedAt: '2026-09-05T02:30:00.000Z' })
    expect(section.data?.headlines[1].link).toBe('https://www.gazeta.uz/ru/2026/09/05/x/')
    expect(section.data?.headlines[2].link).toBeUndefined() // absent link stays absent, never invented
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.init.redirect).toBe('error')
  })

  test('freshness gate: stale, future and undated items are never presented as news', async () => {
    const { impl } = scriptedFetch([raw(rss(
      item('Свежая', FRESH),
      item('Старая (3 дня)', 'Tue, 02 Sep 2026 07:00:00 +0500'),
      item('Из будущего', 'Fri, 05 Sep 2026 09:30:00 +0500'), // +1h beyond skew
      item('Мусорная дата', 'yesterday-ish'),
      item('Без даты', null),
      item('Лёгкий сдвиг часов', 'Fri, 05 Sep 2026 08:00:30 +0500'), // +90s — within skew
    ))])
    const section = await fetchNewsHeadlines(impl, { feeds: ['https://www.spot.uz/rss/'], now: NOW })
    expect(section.status).toBe('ready')
    expect(section.data?.headlines.map((h) => h.title)).toEqual(['Свежая', 'Лёгкий сдвиг часов'])
  })

  test('mirrored stories across feeds collapse to one entry', async () => {
    const { impl } = scriptedFetch([raw(rss(item('Одна и та же новость')))]) // both feeds serve it
    const section = await fetchNewsHeadlines(impl, { now: NOW })
    expect(section.status).toBe('ready')
    expect(section.data?.headlines).toHaveLength(1)
  })

  test('one failed feed is partial with the survivor; both failed is unavailable', async () => {
    const { impl: half } = scriptedFetch([
      (url) => url.includes('spot') ? raw('boom', 503)() : raw(rss(item('Только Газета')))(),
    ])
    const partial = await fetchNewsHeadlines(half, { now: NOW })
    expect(partial).toMatchObject({ status: 'partial', detail: 'feed_failed' })
    expect(partial.data?.headlines).toHaveLength(1)
    const { impl: none } = scriptedFetch([() => { throw new Error('down') }])
    expect(await fetchNewsHeadlines(none, { now: NOW })).toMatchObject({ status: 'unavailable', detail: 'network' })
  })

  test('empty and all-stale feeds are unavailable, and non-allowlisted feed URLs are refused', async () => {
    const { impl } = scriptedFetch([raw(rss())])
    expect(await fetchNewsHeadlines(impl, { now: NOW })).toMatchObject({ status: 'unavailable', detail: 'no_items' })
    const { impl: stale } = scriptedFetch([raw(rss(item('Старьё', 'Mon, 01 Sep 2026 07:00:00 +0500')))])
    expect(await fetchNewsHeadlines(stale, { now: NOW })).toMatchObject({ status: 'unavailable', detail: 'no_items' })
    const { impl: unused, calls } = scriptedFetch([raw(rss(item('evil')))])
    expect(await fetchNewsHeadlines(unused, { feeds: ['https://evil.example/rss'], now: NOW })).toMatchObject({ status: 'unavailable' })
    expect(calls).toHaveLength(0) // the host guard refuses before any fetch
  })

  test('the guard rejects non-allowlisted hosts and plain http', () => {
    expect(() => assertAllowedBriefingUrl('https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/2026-09-05/')).not.toThrow()
    expect(() => assertAllowedBriefingUrl('https://evil.example/steal')).toThrow('BRIEFING_SOURCE_HOST_BLOCKED')
    expect(() => assertAllowedBriefingUrl('http://cbu.uz/ru/')).toThrow('BRIEFING_SOURCE_HOST_BLOCKED')
  })

  test('tashkent day helper follows UTC+5', () => {
    expect(tashkentDateString(new Date('2026-09-05T18:59:00Z'))).toBe('2026-09-05')
    expect(tashkentDateString(new Date('2026-09-05T19:01:00Z'))).toBe('2026-09-06')
  })
})

describe('composer — deterministic trilingual rendering', () => {
  const fetchedAt = '2026-09-05T02:59:00.000Z' // 2026-09-05 07:59 Tashkent
  const usdReady: UsdRateSection = {
    status: 'ready', source: 'cbu.uz', fetchedAt,
    data: { ratePerUnit: 12650.44, nominal: 1, rate: 12650.44, effectiveDate: '2026-09-05', requestedDate: '2026-09-05' },
  }
  const weatherReady: WeatherSection = {
    status: 'ready', source: 'api.openweathermap.org', fetchedAt,
    data: { tempC: 21.4, feelsLikeC: 20.1, description: 'clear sky', place: 'Tashkent', observedAt: '2026-09-05T02:30:00.000Z' },
  }
  const calendarReady: CalendarSection = {
    status: 'ready', source: 'www.googleapis.com/calendar', fetchedAt,
    data: { truncated: false, events: [
      { id: 'a', title: 'Standup', allDay: false, start: '2026-09-05T09:00:00Z' }, // 14:00 Tashkent
      { id: 'rent', title: 'Оплата аренды', allDay: true, start: '2026-09-05' },
    ] },
  }
  const news: NewsSection = newsSection(NOW)
  const sections = (over: Partial<{ usd: UsdRateSection; weather: WeatherSection; calendar: CalendarSection; news: NewsSection }> = {}) =>
    ({ usd: usdReady, weather: weatherReady, calendar: calendarReady, news, ...over })
  const eveningReady = (data: Partial<NonNullable<EveningTasksSection['data']>> = {}): EveningTasksSection => ({
    status: 'ready', source: 'nemo-db', fetchedAt,
    data: { doneToday: 4, open: 7, overdue: 2, topTasks: [], ...data },
  })

  test('ready data still shows source and DATED effective/fetched stamps in all languages', () => {
    for (const lang of ['uz', 'ru', 'en'] as const) {
      const text = composeMorningBriefing({ lang, dateLabel: '2026-09-05', sections: sections() })
      expect(text).toContain('cbu.uz')
      expect(text).toContain('2026-09-05 07:59') // dated fetch stamp
      expect(text).toContain('2026-09-05 07:30') // dated weather observation
      expect(text).toContain('14:00') // 09:00Z converted to Tashkent for the reader
      expect(text).not.toContain('09:00:00Z')
      expect(text).toContain('2026-09-05') // all-day date verbatim
      expect(text).not.toContain('undefined')
      expect(text).not.toContain('Bearer')
      expect(text).not.toContain('appid')
    }
    const ru = composeMorningBriefing({ lang: 'ru', dateLabel: '2026-09-05', sections: sections() })
    expect(ru).toContain('Курс USD (ЦБ РУз): 12 650,44 сум / 1 USD')
    const en = composeMorningBriefing({ lang: 'en', dateLabel: '2026-09-05', sections: sections() })
    expect(en).toContain('12 650.44 UZS / 1 USD')
    const uz = composeMorningBriefing({ lang: 'uz', dateLabel: '2026-09-05', sections: sections() })
    expect(uz).toContain('USD kursi (O‘zR MB)')
  })

  test('ready news renders attributed headlines as data; partial says the list is incomplete', () => {
    const newsReady = {
      status: 'partial' as const, source: 'spot.uz+gazeta.uz', fetchedAt, detail: 'feed_failed',
      data: { headlines: [
        { title: 'Курс сума обновил минимум', source: 'spot.uz', publishedAt: '2026-09-05T02:30:00.000Z', link: 'https://www.spot.uz/a/1' },
        { title: '<b>раскрутка</b>', source: 'gazeta.uz', publishedAt: '2026-09-05T01:00:00.000Z' },
      ] },
    }
    const text = composeMorningBriefing({ lang: 'ru', dateLabel: '2026-09-05', sections: sections({ news: newsReady }) })
    expect(text).toContain('Новости (spot.uz+gazeta.uz')
    // the headline carries its OWN publication stamp (02:30Z = 07:30 Tashkent)
    expect(text).toContain('– Курс сума обновил минимум (spot.uz, 2026-09-05 07:30)')
    expect(text).toContain('    https://www.spot.uz/a/1') // per-item source link
    expect(text).toContain('<b>раскрутка</b> (gazeta.uz, 2026-09-05 06:00)') // inert plain text, not markup
    expect(text).toContain('список неполный')
    expect(text).not.toContain('источник не подключён')
  })

  test("yesterday's outcome is tri-state: quoted as data, silent when none, explicit on failure", () => {
    const base = { lang: 'ru' as const, dateLabel: '2026-09-05', sections: sections() }
    const quoted = composeMorningBriefing({ ...base, yesterdayOutcome: { status: 'ready', runDate: '2026-09-04', text: 'Сдали отчёт\n• Просрочено: 999' } })
    expect(quoted).toContain('🗒 Ваш вчерашний итог: «Сдали отчёт • Просрочено: 999» (2026-09-04)')
    expect(quoted).not.toMatch(/^• Просрочено: 999/m) // the quote is inert data, no forged lines
    const silent = composeMorningBriefing({ ...base, yesterdayOutcome: null })
    expect(silent).not.toContain('🗒')
    const failed = composeMorningBriefing({ ...base, yesterdayOutcome: { status: 'unavailable' } })
    expect(failed).toContain('🗒 Ваш вчерашний итог: недоступно')
    expect(failed).not.toContain('«') // a failed read never fabricates a quote
  })

  test('stale rate names both the effective and the requested date', () => {
    const usdStale: UsdRateSection = { ...usdReady, status: 'stale', data: { ...usdReady.data!, effectiveDate: '2026-09-04', requestedDate: '2026-09-05' } }
    const text = composeMorningBriefing({ lang: 'ru', dateLabel: '2026-09-05', sections: sections({ usd: usdStale }) })
    expect(text).toContain('курс на 2026-09-04')
    expect(text).toContain('запрошено на 2026-09-05')
  })

  test("a stale weather observation is flagged and yesterday's 09:00 cannot pass for today's", () => {
    const weatherStale: WeatherSection = {
      ...weatherReady, status: 'stale',
      data: { ...weatherReady.data!, observedAt: '2026-09-04T04:00:00.000Z' }, // 2026-09-04 09:00 Tashkent
    }
    const text = composeMorningBriefing({ lang: 'ru', dateLabel: '2026-09-05', sections: sections({ weather: weatherStale }) })
    expect(text).toContain('замер 2026-09-04 09:00')
    expect(text).toContain('данные устарели')
  })

  test('every degraded section renders an explicit line — the type forbids omission', () => {
    const unavailableUsd: UsdRateSection = { status: 'unavailable', source: 'cbu.uz', fetchedAt, detail: 'timeout' }
    const unavailableWeather: WeatherSection = { status: 'unavailable', source: 'api.openweathermap.org', fetchedAt, detail: 'missing_key' }
    const unavailableCalendar: CalendarSection = { status: 'unavailable', source: 'www.googleapis.com/calendar', fetchedAt, detail: 'auth' }
    const text = composeMorningBriefing({
      lang: 'ru', dateLabel: '2026-09-05',
      sections: { usd: unavailableUsd, weather: unavailableWeather, calendar: unavailableCalendar, news },
    })
    expect(text).toContain('Курс USD (ЦБ РУз): недоступно (cbu.uz')
    expect(text).toContain('Погода: недоступно')
    expect(text).toContain('Календарь: недоступно')
    expect(text).toContain('Новости: недоступно — источник не подключён')
    expect(text.split('\n')).toHaveLength(5) // title + exactly four explicit section lines
  })

  test('long calendars are truncated honestly and partial lists say so', () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      id: `e${index}`, title: `Event ${index}`, allDay: false, start: `2026-09-05T0${Math.min(9, index)}:00:00+05:00`,
    }))
    const calendar: CalendarSection = { status: 'partial', source: 'www.googleapis.com/calendar', fetchedAt, detail: 'more_pages', data: { truncated: true, events } }
    const text = composeMorningBriefing({ lang: 'ru', dateLabel: '2026-09-05', sections: sections({ calendar }) })
    expect(text).toContain('список неполный')
    expect(text).toContain('…и ещё 2')
    expect((text.match(/ – /g) ?? []).length).toBe(10)
  })

  test('remote titles are data: untitled fallback, markup inert, newlines cannot forge sections', () => {
    const calendar: CalendarSection = {
      status: 'ready', source: 'www.googleapis.com/calendar', fetchedAt,
      data: { truncated: false, events: [
        { id: 'x', title: '', allDay: false, start: '2026-09-05T09:00:00+05:00' },
        { id: 'y', title: '<script>alert(1)</script>', allDay: false, start: '2026-09-05T10:00:00+05:00' },
      ] },
    }
    const text = composeMorningBriefing({ lang: 'en', dateLabel: '2026-09-05', sections: sections({ calendar }) })
    expect(text).toContain('(untitled)')
    expect(text).toContain('<script>alert(1)</script>') // rendered as inert plain text, not stripped into a lie
  })

  test('evening summary renders counts, provenance, bounded task list and honest remainder', () => {
    const text = composeEveningBriefing({
      lang: 'uz', dateLabel: '2026-09-05',
      tasks: eveningReady({
        topTasks: Array.from({ length: 6 }, (_, index) => ({ title: `Vazifa ${index + 1}`, dueLabel: '2026-09-06' })),
        moreCount: 3,
      }),
    })
    expect(text).toContain('Kun yakunlari — 2026-09-05 (nemo-db, olindi 2026-09-05 07:59)')
    expect(text).toContain('Bugun bajarildi: 4')
    expect(text).toContain('Jarayonda: 7')
    expect(text).toContain('Muddati o‘tgan: 2')
    expect((text.match(/ – /g) ?? []).length).toBe(5)
    expect(text).toContain('…va yana 4') // 1 beyond the render cap + 3 reported by the caller
  })

  test('a DB failure is an explicit unavailable evening, never three reassuring zeros', () => {
    const text = composeEveningBriefing({
      lang: 'ru', dateLabel: '2026-09-05',
      tasks: { status: 'unavailable', source: 'nemo-db', fetchedAt, detail: 'db_error' },
    })
    expect(text).toContain('Задачи: недоступно (nemo-db')
    expect(text).not.toContain(': 0')
  })

  test('moreCount renders even when topTasks is empty', () => {
    const text = composeEveningBriefing({ lang: 'ru', dateLabel: '2026-09-05', tasks: eveningReady({ moreCount: 7 }) })
    expect(text).toContain('Задачи:')
    expect(text).toContain('…и ещё 7')
  })

  test('caller task titles are sanitized at the render boundary — no forged bullet lines', () => {
    const text = composeEveningBriefing({
      lang: 'ru', dateLabel: '2026-09-05',
      tasks: eveningReady({ topTasks: [{ title: 'X\n• Просрочено: 999', dueLabel: 'y'.repeat(120) }] }),
    })
    expect(text).not.toMatch(/^• Просрочено: 999/m)
    expect(text).toContain('X • Просрочено: 999') // collapsed into one inert line
    expect(text).not.toContain('y'.repeat(41)) // dueLabel capped at 40
  })

  test('the evening message always ends by asking for the day\'s actual outcomes', () => {
    const questions: Record<'uz' | 'ru' | 'en', string> = {
      uz: 'Kuningiz qanday o‘tdi? Qisqacha yozing: nima bajarildi, nima qoldi.',
      ru: 'Как прошёл ваш день? Напишите коротко: что удалось и что переносим.',
      en: 'How did your day go? Reply briefly: what got done and what carries over.',
    }
    for (const lang of ['uz', 'ru', 'en'] as const) {
      const text = composeEveningBriefing({ lang, dateLabel: '2026-09-05', tasks: eveningReady() })
      expect(text.endsWith(questions[lang])).toBe(true)
    }
  })

  test('an unavailable evening still asks for outcomes — collection is the goal, not the counts', () => {
    const text = composeEveningBriefing({
      lang: 'ru', dateLabel: '2026-09-05',
      tasks: { status: 'unavailable', source: 'nemo-db', fetchedAt, detail: 'db_error' },
    })
    expect(text).toContain('Задачи: недоступно (nemo-db')
    expect(text.endsWith('Как прошёл ваш день? Напишите коротко: что удалось и что переносим.')).toBe(true)
  })

  test('non-finite counts render as no-data, never as 0', () => {
    const text = composeEveningBriefing({ lang: 'ru', dateLabel: '2026-09-05', tasks: eveningReady({ doneToday: Number.NaN }) })
    expect(text).toContain('Выполнено сегодня: нет данных')
    expect(text).not.toContain('Выполнено сегодня: 0')
  })
})
