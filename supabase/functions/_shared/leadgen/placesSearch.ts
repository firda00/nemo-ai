// Поиск компаний: Google Places, с бумажным запасным путём, когда ключа нет.
//
// Text Search сам по себе не отдаёт international_phone_number и website — только place_id,
// name, formatted_address, rating, business_status. Без отдельного вызова Details каждая запись
// провалила бы sanitizePlace() на no_phone: у неё физически неоткуда взяться телефону. Details —
// платный вызов на каждую запись, поэтому тянется ТОЛЬКО для того, что реально попадёт в выдачу
// (после отсечения по limit), а не для всей страницы впустую.

import { readFile } from 'node:fs/promises'
import type { PlacesSearch, SearchStats } from './contracts.ts'
import type { LeadSearchRequest, RawPlace } from './schemas.ts'
import { OverpassPlacesSearch } from './overpassSearch.ts'
import { toRawPlace } from './rawPlace.ts'

const TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
const DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json'
const DETAILS_FIELDS = [
  'place_id', 'name', 'formatted_address', 'international_phone_number',
  'website', 'rating', 'user_ratings_total', 'business_status',
].join(',')

// Google выдаёт next_page_token, но он активируется не сразу: запрос с ним без паузы возвращает
// INVALID_REQUEST, который легко принять за конец выдачи, хотя страницы ещё есть.
const NEXT_PAGE_DELAY_MS = 2000
// Text Search отдаёт максимум три страницы по двадцать записей — это ограничение самого API,
// не наше: дальше pagetoken перестаёт быть валидным вне зависимости от того, что мы попросим.
const MAX_PAGES = 3

type PlacesResponse = { results: Array<Record<string, unknown>>; next_page_token?: string; status: string }
type DetailsResponse = { result?: Record<string, unknown>; status: string }

/**
 * Google Places (классический API — поля формы RawPlace взяты дословно из его ответа, а не из
 * Places API (New), где те же поля называются camelCase иначе).
 *
 * fetchImpl принимается аргументом ради теста: настоящий Google не подделать, а пагинацию и лимит
 * запросов Details проверить нужно — это ровно то место, где платится реальными деньгами за
 * каждую лишнюю запись.
 */
export class GooglePlacesSearch implements PlacesSearch {
  // Обычные поля, а не сокращение `constructor(private readonly x)`: последнее генерирует код
  // присваивания, а не только стирает типы, и node --experimental-strip-types такое не понимает —
  // падает с ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Здесь весь пайплайн запускается именно так.
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey
    this.fetchImpl = fetchImpl
  }

  private async textSearchPage(query: string, pageToken?: string): Promise<PlacesResponse> {
    const url = new URL(TEXT_SEARCH_URL)
    url.searchParams.set('key', this.apiKey)
    if (pageToken) url.searchParams.set('pagetoken', pageToken)
    else url.searchParams.set('query', query)
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`Google Places textsearch: HTTP ${res.status}`)
    return await res.json() as PlacesResponse
  }

  private async placeDetails(placeId: string): Promise<Record<string, unknown> | null> {
    const url = new URL(DETAILS_URL)
    url.searchParams.set('key', this.apiKey)
    url.searchParams.set('place_id', placeId)
    url.searchParams.set('fields', DETAILS_FIELDS)
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const data = await res.json() as DetailsResponse
    return data.status === 'OK' ? (data.result ?? null) : null
  }

  async search(request: LeadSearchRequest): Promise<{ places: RawPlace[]; stats: SearchStats }> {
    const places: RawPlace[] = []
    let pageToken: string | undefined
    let pages = 0
    let exhausted = false

    do {
      if (pageToken) await new Promise((resolve) => setTimeout(resolve, NEXT_PAGE_DELAY_MS))
      const page = await this.textSearchPage(`${request.query} ${request.city}`, pageToken)
      pages += 1
      if (page.status !== 'OK' && page.status !== 'ZERO_RESULTS') {
        throw new Error(`Google Places textsearch: status ${page.status}`)
      }
      for (const item of page.results) {
        if (places.length >= request.limit) break
        const details = await this.placeDetails(String(item.place_id ?? ''))
        places.push(toRawPlace(details ?? item))
      }
      pageToken = page.next_page_token
      if (!pageToken) exhausted = true
    } while (pageToken && places.length < request.limit && pages < MAX_PAGES)

    return { places, stats: { pages, exhausted } }
  }
}

/** Простой CSV: запятая-разделитель, кавычки экранируют запятую внутри поля. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes; continue }
    if (char === ',' && !inQuotes) { cells.push(current.trim()); current = ''; continue }
    current += char
  }
  cells.push(current.trim())
  return cells
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) return []
  const headers = splitCsvLine(lines[0])
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    const row: Record<string, string> = {}
    headers.forEach((header, index) => { row[header] = cells[index] ?? '' })
    return row
  })
}

/**
 * Запасной путь без GOOGLE_PLACES_API_KEY: локальный JSON-массив или CSV с уже собранными
 * записями (полями RawPlace). Один прогон, без страниц — файл либо содержит нужное, либо нет.
 */
export class FilePlacesSearch implements PlacesSearch {
  private readonly filePath: string
  constructor(filePath: string) { this.filePath = filePath }

  async search(request: LeadSearchRequest): Promise<{ places: RawPlace[]; stats: SearchStats }> {
    const raw = await readFile(this.filePath, 'utf8')
    const rows = this.filePath.toLowerCase().endsWith('.csv') ? parseCsv(raw) : JSON.parse(raw)
    const places = (Array.isArray(rows) ? rows : []).slice(0, request.limit).map(toRawPlace)
    return { places, stats: { pages: 1, exhausted: true } }
  }
}

/**
 * Источник поиска по тому, что задано в окружении. НЕ БРОСАЕТ ИСКЛЮЧЕНИЙ.
 *
 * Раньше здесь был отказ `places_search_not_configured`, и пайплайн не запускался без платного
 * ключа или руками собранного файла — то есть «одной командой из коробки» не работал вовсе.
 * Теперь ключ Google и файл — необязательные улучшения, а не условие запуска: без них берётся
 * OpenStreetMap, у которого нет ни ключей, ни оплаты.
 *
 * Порядок именно такой: у Google полнота контактов заметно выше (см. замер в overpassSearch.ts),
 * поэтому если за него уже заплачено — используем его; явно указанный файл важнее общего
 * справочника, потому что его задали намеренно.
 */
export function resolvePlacesSearch(env: NodeJS.ProcessEnv = process.env): PlacesSearch {
  const apiKey = env.GOOGLE_PLACES_API_KEY
  if (apiKey) return new GooglePlacesSearch(apiKey)
  const fallbackFile = env.SDR_PLACES_FALLBACK_FILE
  if (fallbackFile) return new FilePlacesSearch(fallbackFile)
  return new OverpassPlacesSearch()
}

// Живёт в rawPlace.ts (иначе overpassSearch ↔ placesSearch замкнулись бы в кольцо), но
// переэкспортируется отсюда: для вызывающего это по-прежнему часть слоя источников поиска.
export { toRawPlace } from './rawPlace.ts'
