// Бесключевой поиск компаний через OpenStreetMap. Здесь проверяется то, что выяснилось только на
// ЖИВЫХ данных, а не читалось из документации.
//
// Замер по Ташкенту (стоматологии, 2026-08-17): 181 точка, имя у 138, телефон у 48, сайт у 12,
// телефон И сайт — у 11. Отсюда два вывода, оба записаны проверками ниже: (1) телефон в OSM часто
// приходит списком через «;», и наивный разбор терял такие записи целиком; (2) лимит нельзя
// применять к первым N записям подряд — иначе из пятнадцати годной окажется одна.

import assert from 'node:assert/strict'
import {
  OverpassPlacesSearch,
  buildOverpassQuery,
  elementToRawPlace,
  firstPhone,
  resolveCityBBox,
  selectorsFor,
} from '../supabase/functions/_shared/leadgen/overpassSearch.ts'
import { resolvePlacesSearch } from '../supabase/functions/_shared/leadgen/placesSearch.ts'

// --- Телефон списком: реальный формат OSM ---------------------------------------------------------
// Живое значение из выдачи: «+99871 256-2363; +99897 154-4274;+99890 187-5252». toE164 из
// sanitizer.ts на такой строке возвращает null (склеивает в 36-значное «число»), и клиника с ТРЕМЯ
// рабочими номерами отсеивалась бы как «без телефона».

assert.equal(firstPhone('+99871 256-2363; +99897 154-4274;+99890 187-5252'), '+99871 256-2363')
assert.equal(firstPhone('+998712680540'), '+998712680540', 'одиночный номер не портится')
assert.equal(firstPhone('+998 71 200-00-00, +998 90 111-11-11'), '+998 71 200-00-00', 'запятая — тоже разделитель')
assert.equal(firstPhone(undefined), undefined)
assert.equal(firstPhone(''), undefined)
assert.equal(firstPhone('   '), undefined, 'пробелы — не номер')

// --- Теги контактов приходят и с префиксом contact:, и без него ------------------------------------
// Оба варианта встретились в одной и той же живой выдаче, у разных клиник.

{
  const bare = elementToRawPlace({
    type: 'node', id: 1,
    tags: { name: 'Дент-Мастер', phone: '+998712680540', website: 'http://dentmaster.uz' },
  })
  assert.equal(bare.international_phone_number, '+998712680540')
  assert.equal(bare.website, 'http://dentmaster.uz')

  const prefixed = elementToRawPlace({
    type: 'node', id: 2,
    tags: { name: 'Smile Dental Clinic', 'contact:phone': '+99871 256-2363', 'contact:website': 'http://orthodont.uz' },
  })
  assert.equal(prefixed.international_phone_number, '+99871 256-2363', 'contact:phone читается наравне с phone')
  assert.equal(prefixed.website, 'http://orthodont.uz')
}

// Точка без названия лидом быть не может: в списке она была бы строкой «Без названия».
assert.equal(elementToRawPlace({ type: 'node', id: 3, tags: { amenity: 'dentist' } }), null)
// Локализованное имя годится, когда основного нет.
assert.equal(elementToRawPlace({ type: 'node', id: 4, tags: { 'name:ru': 'Стоматология №1' } }).name, 'Стоматология №1')

// Идентификатор несёт происхождение: запись OSM и запись Google не должны выглядеть одинаково в
// базе, где лежат обе.
assert.equal(elementToRawPlace({ type: 'way', id: 42, tags: { name: 'X' } }).place_id, 'osm:way/42')

// Закрытый бизнес помечается закрытым — по нему звонят человеку, который закрылся.
assert.equal(
  elementToRawPlace({ type: 'node', id: 5, tags: { name: 'X', disused: 'yes' } }).business_status,
  'CLOSED_PERMANENTLY',
)
assert.equal(elementToRawPlace({ type: 'node', id: 6, tags: { name: 'X' } }).business_status, 'OPERATIONAL')

// --- Запрос: поиск по названию идёт ВСЕГДА --------------------------------------------------------
// Таблица категорий неполная намеренно (платформа домен-нейтральна). Неизвестная категория обязана
// находиться по названию, иначе «типография» не нашлась бы вовсе.

assert.deepEqual(selectorsFor('стоматология'), ['"amenity"="dentist"', '"healthcare"="dentist"'])
assert.deepEqual(selectorsFor('типография'), [], 'неизвестная категория — без тегов')

{
  const known = buildOverpassQuery('стоматология', [41.1, 41.4, 69.1, 69.5])
  assert.ok(known.includes('"amenity"="dentist"'))
  assert.ok(known.includes('"name"~"стоматология",i'), 'поиск по названию есть даже у известной категории')

  const unknown = buildOverpassQuery('типография', [41.1, 41.4, 69.1, 69.5])
  assert.ok(unknown.includes('"name"~"типография",i'),
    'неизвестная категория держится на поиске по названию — без него запрос был бы пустым')
  // Порядок Nominatim — [юг, север, запад, восток]; Overpass ждёт (юг,запад,север,восток).
  assert.ok(unknown.includes('(41.1,69.1,41.4,69.5)'), 'координаты переставлены в порядок Overpass')
}

// Кавычка в поручении не должна ломать запрос.
assert.ok(buildOverpassQuery('фирма "Ромашка"', [1, 2, 3, 4]).includes('\\"Ромашка\\"'))

// --- Лимит применяется к САМЫМ ПОЛНЫМ записям, а не к первым подряд -------------------------------
// Это и есть разница между «--limit 15 дал один лид» и «--limit 15 дал одиннадцать».

{
  const elements = [
    { type: 'node', id: 1, tags: { name: 'Без контактов' } },
    { type: 'node', id: 2, tags: { name: 'Только сайт', website: 'https://a.uz' } },
    { type: 'node', id: 3, tags: { name: 'Только телефон', phone: '+998901112233' } },
    { type: 'node', id: 4, tags: { name: 'Полная', phone: '+998901112244', website: 'https://b.uz' } },
  ]
  const fakeFetch = async (url) => {
    const href = String(url)
    if (href.includes('nominatim')) {
      return { ok: true, json: async () => [{ boundingbox: ['41.1', '41.4', '69.1', '69.5'] }] }
    }
    return { ok: true, text: async () => JSON.stringify({ elements }) }
  }
  const search = new OverpassPlacesSearch(fakeFetch, 'https://overpass.test/api')
  const { places, stats } = await search.search({ query: 'стоматология', city: 'Ташкент', limit: 2 })

  assert.deepEqual(places.map((one) => one.name), ['Полная', 'Только телефон'],
    'полная запись и запись с телефоном обгоняют пустую — иначе лимит съедали бы точки без контактов')
  assert.equal(stats.exhausted, false, 'в городе нашлось больше, чем просили')
}

// exhausted считается по ВСЕЙ выдаче, а не по обрезанному куску.
{
  const fakeFetch = async (url) => String(url).includes('nominatim')
    ? { ok: true, json: async () => [{ boundingbox: ['41.1', '41.4', '69.1', '69.5'] }] }
    : { ok: true, text: async () => JSON.stringify({ elements: [{ type: 'node', id: 1, tags: { name: 'Одна' } }] }) }
  const search = new OverpassPlacesSearch(fakeFetch, 'https://overpass.test/api')
  const { stats } = await search.search({ query: 'q', city: 'Ташкент', limit: 50 })
  assert.equal(stats.exhausted, true)
}

// --- Занятость общей службы приходит как HTTP 200 с HTML ------------------------------------------
// Проверять res.ok здесь недостаточно: «занято» выглядело бы как пустая выдача, и прогон молча
// возвращал бы ноль лидов на работающем городе. Это ровно то, что случилось при живой проверке.

{
  let attempts = 0
  const busyHtml = '<html><body><p><strong style="color:#FF0000">Error</strong>: runtime error:'
    + ' open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout.'
    + ' The server is probably too busy to handle your request. </p></body></html>'
  const fakeFetch = async (url) => {
    if (String(url).includes('nominatim')) {
      return { ok: true, json: async () => [{ boundingbox: ['41.1', '41.4', '69.1', '69.5'] }] }
    }
    attempts += 1
    // Первые две попытки — «занято» под видом успешного ответа, третья отдаёт данные.
    if (attempts < 3) return { ok: true, text: async () => busyHtml }
    return { ok: true, text: async () => JSON.stringify({ elements: [{ type: 'node', id: 1, tags: { name: 'Дошло' } }] }) }
  }
  const search = new OverpassPlacesSearch(fakeFetch, 'https://overpass.test/api')
  const { places } = await search.search({ query: 'q', city: 'Ташкент', limit: 5 })
  assert.equal(attempts, 3, 'занятость распознана по тексту и повторена, а не принята за пустую выдачу')
  assert.deepEqual(places.map((one) => one.name), ['Дошло'])
}

// --- Город не найден — понятная ошибка, а не пустая выдача ------------------------------------------

{
  const fakeFetch = async () => ({ ok: true, json: async () => [] })
  const search = new OverpassPlacesSearch(fakeFetch, 'https://overpass.test/api')
  await assert.rejects(
    () => search.search({ query: 'q', city: 'Нетакогогорода', limit: 5 }),
    /overpass_city_not_found/,
  )
}

// Рамка города разбирается из строк, как их отдаёт Nominatim (проверено на живой службе).
{
  const fakeFetch = async () => ({ ok: true, json: async () => [{ boundingbox: ['41.1577334', '41.4224955', '69.1217970', '69.5259080'] }] })
  assert.deepEqual(await resolveCityBBox('Ташкент', fakeFetch), [41.1577334, 41.4224955, 69.1217970, 69.5259080])
}
{
  const fakeFetch = async () => ({ ok: true, json: async () => [{ boundingbox: ['мусор', 'x', 'y', 'z'] }] })
  assert.equal(await resolveCityBBox('Ташкент', fakeFetch), null, 'нечисловая рамка — не рамка')
}

// --- Запуск «из коробки»: без единого ключа источник обязан найтись, а не бросить исключение --------

assert.ok(resolvePlacesSearch({}) instanceof OverpassPlacesSearch,
  'без ключей берётся OpenStreetMap — раньше здесь падало places_search_not_configured')
assert.ok(!(resolvePlacesSearch({ GOOGLE_PLACES_API_KEY: 'k' }) instanceof OverpassPlacesSearch),
  'оплаченный Google важнее общего справочника: у него полнота контактов выше')

console.log('[OK] SDR Overpass behaviour: 30 assertions')
