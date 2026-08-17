// Поиск компаний БЕЗ платных ключей: OpenStreetMap через Overpass API.
//
// Это путь по умолчанию — то, что работает одной командой сразу после клонирования. Google Places
// остаётся, но становится необязательным улучшением, а не условием запуска.
//
// ПОЧЕМУ НЕ СКРАПИНГ ПОИСКОВИКА И НЕ СПИСОК ОТ МОДЕЛИ. Разбор выдачи DuckDuckGo обычно нарушает
// условия использования и ломается от любой правки их разметки — молча, в проде, без ошибки.
// Список компаний, придуманный моделью, ещё хуже: для нишевых локальных справочников она охотно
// сочиняет правдоподобные названия и номера, а проверка «домен отвечает» подтверждает только
// существование домена, но не то, что телефон и вывеска настоящие. Холодный звонок по выдуманному
// номеру — это звонок случайному человеку. Overpass — официальный API, предназначенный ровно для
// такого запроса, и отдаёт структурированные поля, а не текст, из которого их надо угадывать.
//
// ЧЕГО ЖДАТЬ ОТ ПОЛНОТЫ ДАННЫХ. OSM ведут добровольцы, и контакты заполнены далеко не у всех: по
// живому замеру (Ташкент, стоматологии, 2026-08-17) из 181 найденной точки имя было у 138, телефон
// у 48, сайт у 12, и телефон вместе с сайтом — только у 11. Фильтр качества в sanitizer.ts требует
// оба канала, поэтому большая часть выдачи честно отсеивается с названной причиной. Это не поломка
// поиска: это состояние открытых данных, и в отчёте оно видно строкой «причины отсева».

import { backoffDelays, type PlacesSearch, type SearchStats } from './contracts.ts'
import type { LeadSearchRequest, RawPlace } from './schemas.ts'
import { toRawPlace } from './rawPlace.ts'

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
// Обе службы бесплатные и общие. Их правила требуют опознаваемого User-Agent с контактом: без него
// анонимный поток запросов справедливо блокируют, и виноваты будем мы, а не они.
const USER_AGENT = 'NemoAI-SDR/1.0 (+https://github.com/firda00/nemo-ai)'

/**
 * Ключевое слово поручения → теги OSM.
 *
 * Таблица намеренно НЕ полная и не претендует быть классификатором всех отраслей: платформа
 * домен-нейтральна, и зашивать сюда закрытый список сфер нельзя. Она лишь ускоряет частые случаи, а
 * неизвестная категория всё равно найдётся — к любому запросу ВСЕГДА добавляется поиск по названию
 * (см. buildOverpassQuery), поэтому «шиномонтаж» или «типография» без записи в таблице не теряются.
 */
const CATEGORY_TAGS: Array<{ words: string[]; selectors: string[] }> = [
  { words: ['стоматолог', 'dentist', 'tish', 'зубн'], selectors: ['"amenity"="dentist"', '"healthcare"="dentist"'] },
  { words: ['клиник', 'больниц', 'медцентр', 'clinic', 'hospital', 'shifoxona'], selectors: ['"amenity"="clinic"', '"amenity"="hospital"', '"amenity"="doctors"'] },
  { words: ['аптек', 'pharmacy', 'dorixona'], selectors: ['"amenity"="pharmacy"'] },
  // «кофейн» отдельным словом: подстрока «кафе» в него не входит, и запрос «кофейни» уходил в
  // OSM без единого тега — только поиском по названию, что даёт ноль записей.
  { words: ['ресторан', 'кафе', 'кофейн', 'restaurant', 'cafe', 'coffee', 'oshxona'], selectors: ['"amenity"="restaurant"', '"amenity"="cafe"'] },
  { words: ['отель', 'гостиниц', 'hotel', 'mehmonxona'], selectors: ['"tourism"="hotel"', '"tourism"="guest_house"'] },
  { words: ['салон', 'парикмахер', 'beauty', 'barber', 'sartaroshxona'], selectors: ['"shop"="beauty"', '"shop"="hairdresser"'] },
  { words: ['фитнес', 'спортзал', 'gym', 'fitness'], selectors: ['"leisure"="fitness_centre"'] },
  { words: ['школ', 'курс', 'учебн', 'school', 'maktab', 'oquv'], selectors: ['"amenity"="school"', '"amenity"="language_school"', '"amenity"="college"'] },
  { words: ['автосервис', 'шиномонтаж', 'car_repair', 'avtoservis'], selectors: ['"shop"="car_repair"', '"shop"="tyres"'] },
  { words: ['юрист', 'адвокат', 'lawyer', 'yurist'], selectors: ['"office"="lawyer"'] },
  { words: ['магазин', 'shop', 'dokon'], selectors: ['"shop"'] },
]

/** Экранирование для строки внутри регулярного выражения Overpass QL. */
function escapeForOverpassRegex(text: string): string {
  return text.replace(/["\\]/g, '\\$&')
}

export function selectorsFor(query: string): string[] {
  const lower = query.toLowerCase()
  const matched = CATEGORY_TAGS.find((row) => row.words.some((word) => lower.includes(word)))
  return matched?.selectors ?? []
}

/** [юг, север, запад, восток] — тот порядок, в котором boundingbox отдаёт Nominatim. */
export type BBox = [number, number, number, number]

export function buildOverpassQuery(query: string, bbox: BBox, timeoutSec = 60): string {
  const [south, north, west, east] = bbox
  const box = `${south},${west},${north},${east}`
  const selectors = selectorsFor(query)
  // Поиск по названию идёт ВСЕГДА, а не только когда категория неизвестна: «Дента» может быть
  // помечена как amenity=dentist, а может — вообще без тега категории, с одним name. Второй способ
  // ловит то, что пропустил первый, а дедупликация по osm-идентификатору уберёт пересечение.
  const nameSelector = `"name"~"${escapeForOverpassRegex(query)}",i`
  const parts = [...selectors, nameSelector].map((selector) => `  nwr[${selector}](${box});`)
  return `[out:json][timeout:${timeoutSec}];\n(\n${parts.join('\n')}\n);\nout tags center;`
}

interface NominatimPlace {
  boundingbox?: [string, string, string, string]
  addresstype?: string
  class?: string
  name?: string
}

/**
 * Что считается населённым пунктом.
 *
 * Фильтр обязателен, и вот почему. На запрос «Ташкенте» (так пишут в живой речи: «стоматология в
 * Ташкенте») Nominatim первым возвращает КАФЕ «Однажды в Ташкенте» — в Москве, координаты 55.71.
 * Без проверки типа мы бы искали клиники в рамке московского кафе и честно доложили «ничего не
 * найдено», а причину не показал бы ни один журнал.
 */
const SETTLEMENT_TYPES = new Set([
  'city', 'town', 'village', 'hamlet', 'municipality', 'borough', 'suburb',
  'state', 'county', 'region', 'province', 'administrative',
])

function isSettlement(place: NominatimPlace): boolean {
  return SETTLEMENT_TYPES.has(String(place.addresstype ?? ''))
    || place.class === 'boundary'
    || place.class === 'place'
}

/**
 * Варианты написания города — чтобы «в Ташкенте» нашёл Ташкент.
 *
 * Русский предложный падеж Nominatim не понимает: «Ташкент» находится, «Ташкенте» — нет. Полного
 * разбора морфологии здесь не будет, он и не нужен: хватает четырёх правил на окончание, а
 * страховкой от неверного попадания служит фильтр по типу выше. Не нашлось ни по одному варианту —
 * честно возвращаем null, а не берём что попало.
 */
export function cityCandidates(raw: string): string[] {
  const base = String(raw ?? '').trim().replace(/^(в|во|in)\s+/i, '')
  const out = [base]
  if (/[а-яё]е$/i.test(base)) {
    out.push(base.slice(0, -1))              // Ташкенте → Ташкент, Нукусе → Нукус
    out.push(`${base.slice(0, -1)}а`)        // Бухаре → Бухара, Москве → Москва
  }
  if (/[а-яё]и$/i.test(base)) out.push(`${base.slice(0, -1)}я`) // Анталии → Анталия
  if (/[а-яё]у$/i.test(base)) out.push(base.slice(0, -1))       // Баку остаётся, но Ростову → Ростов
  return [...new Set(out.filter(Boolean))]
}

/** Город → рамка координат. Работает и с латиницей, и с кириллицей (проверено на живой службе). */
export async function resolveCityBBox(city: string, fetchImpl: typeof fetch = fetch): Promise<BBox | null> {
  for (const candidate of cityCandidates(city)) {
    const url = new URL(NOMINATIM_URL)
    url.searchParams.set('q', candidate)
    url.searchParams.set('format', 'json')
    // Пять, а не один: годный населённый пункт может стоять не первым, если выше него оказалась
    // кофейня с тем же словом в названии.
    url.searchParams.set('limit', '5')
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) continue
    const data = await res.json() as NominatimPlace[]
    const place = (Array.isArray(data) ? data : []).find(isSettlement)
    const box = place?.boundingbox
    if (!box || box.length !== 4) continue
    const numbers = box.map(Number) as BBox
    if (numbers.every((one) => Number.isFinite(one))) return numbers
  }
  return null
}

interface OverpassElement {
  type: string
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

/** Тег есть и в чистом виде, и с префиксом contact: — OSM допускает оба, и оба встречаются вживую. */
function tag(tags: Record<string, string>, name: string): string | undefined {
  return tags[name] ?? tags[`contact:${name}`]
}

/**
 * Первый номер из значения OSM.
 *
 * В живых данных телефон приходит списком через точку с запятой:
 * «+99871 256-2363; +99897 154-4274; +99890 187-5252». toE164 из sanitizer.ts на такой строке
 * возвращает null — он убирает разделители и получает 36-значное «число», — и лид с ТРЕМЯ рабочими
 * номерами молча отсеивался бы как «без телефона». Разбор здесь, а не в общем sanitizer: это
 * особенность формата OSM, а не всех источников.
 */
export function firstPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const first = raw.split(/[;,]/)[0]?.trim()
  return first || undefined
}

/** Элемент OSM → запись формы RawPlace. */
export function elementToRawPlace(element: OverpassElement): RawPlace | null {
  const tags = element.tags ?? {}
  const name = tags.name ?? tags['name:ru'] ?? tags['name:en']
  // Точка без названия лидом быть не может: писать и звонить некуда, и в списке она была бы
  // строкой «Без названия», создающей видимость работы.
  if (!name) return null

  const address = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city']]
    .filter(Boolean).join(', ') || undefined

  return toRawPlace({
    // Свой идентификатор с явным происхождением: osm-точка и запись Google не должны выглядеть
    // одинаково в базе, где лежат обе.
    place_id: `osm:${element.type}/${element.id}`,
    name,
    formatted_address: address,
    international_phone_number: firstPhone(tag(tags, 'phone') ?? tag(tags, 'mobile')),
    website: tag(tags, 'website') ?? tag(tags, 'url'),
    // Рейтинга и числа отзывов в OSM нет вовсе — это не пропуск заполнения, а отсутствие такого
    // понятия в данных. Пустые поля честнее выдуманной единицы.
    business_status: tags.disused === 'yes' || tags.abandoned === 'yes' ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
  })
}

/** Общая бесплатная служба отвечает так, когда занята. Это «повторите позже», а не «запрос неверен». */
function isBusyResponse(text: string): boolean {
  return /Dispatcher_Client|too busy|rate.?limit|timeout/i.test(text)
}

export class OverpassPlacesSearch implements PlacesSearch {
  private readonly fetchImpl: typeof fetch
  private readonly endpoint: string

  constructor(fetchImpl: typeof fetch = fetch, endpoint: string = OVERPASS_URL) {
    this.fetchImpl = fetchImpl
    this.endpoint = endpoint
  }

  async search(request: LeadSearchRequest): Promise<{ places: RawPlace[]; stats: SearchStats }> {
    const bbox = await resolveCityBBox(request.city, this.fetchImpl)
    if (!bbox) throw new Error(`overpass_city_not_found: не удалось определить границы города «${request.city}»`)

    const body = buildOverpassQuery(request.query, bbox)
    const delays = backoffDelays(3, 2000)
    let payload: { elements?: OverpassElement[] } | null = null

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: new URLSearchParams({ data: body }).toString(),
        signal: AbortSignal.timeout(90_000),
      })
      const text = await res.text()
      // Занятость приходит как HTTP 200 с HTML-страницей об ошибке, а не кодом ответа: проверять
      // res.ok здесь недостаточно, и без разбора текста «занято» выглядело бы как пустая выдача.
      if (!res.ok || isBusyResponse(text)) {
        if (attempt === delays.length) {
          throw new Error('overpass_busy: общая служба Overpass занята — повторите через минуту')
        }
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
        continue
      }
      try { payload = JSON.parse(text) } catch { throw new Error('overpass_bad_response: ответ не разобрался как JSON') }
      break
    }

    const elements = payload?.elements ?? []
    // Один бизнес попадает в выдачу дважды, когда подходит и по тегу категории, и по названию.
    // Дедупликация здесь — по идентификатору OSM; смысловая (по имени и городу) остаётся за
    // sanitizer.dropDuplicates, у которой другая задача.
    const seen = new Set<string>()
    const all: RawPlace[] = []
    for (const element of elements) {
      const key = `${element.type}/${element.id}`
      if (seen.has(key)) continue
      seen.add(key)
      const place = elementToRawPlace(element)
      if (place) all.push(place)
    }

    // ЛИМИТ ПРИМЕНЯЕТСЯ К САМЫМ ПОЛНЫМ ЗАПИСЯМ, А НЕ К ПЕРВЫМ ПОДРЯД.
    //
    // У Google «найдено» и «годится» почти совпадают, и порядок выдачи неважен. В OSM контакты
    // заполнены у меньшинства точек: если взять первые N в порядке ответа, из пятнадцати запись с
    // хоть каким-то контактом окажется одна, а остальные честно отсеются как no_contacts — «--limit 15»
    // превратится в один лид. Overpass отдаёт всю выдачу одним ответом, поэтому упорядочить её
    // здесь ничего не стоит: ни лишнего запроса, ни оплаты.
    //
    // Сортировка НЕ подменяет фильтр качества из sanitizer.ts — она лишь решает, какие записи
    // доедут до него первыми. Отсев по-прежнему считает и называет причины.
    const richness = (place: RawPlace): number =>
      (place.international_phone_number ? 2 : 0) + (place.website ? 1 : 0)
    const ranked = all
      .map((place, index) => ({ place, index, rank: richness(place) }))
      .sort((a, b) => (b.rank - a.rank) || (a.index - b.index))
      .map((one) => one.place)

    return {
      places: ranked.slice(0, request.limit),
      // Overpass отдаёт всё одним ответом — страниц как таковых нет. exhausted означает «в городе
      // нашлось меньше, чем просили», и считается по ВСЕЙ выдаче, а не по обрезанному куску.
      stats: { pages: 1, exhausted: all.length <= request.limit },
    }
  }
}
