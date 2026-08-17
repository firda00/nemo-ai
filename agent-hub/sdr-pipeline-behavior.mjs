// SDR-пайплайн: поведение, которое дороже всего сломать молча.
//
// Три вещи здесь важнее прочих: статус лида решает порог, а не модель (иначе HOT приходит не по
// тому правилу, что настроено владельцем); в Telegram уходят ТОЛЬКО горячие (иначе поток алертов
// выключают на второй день); и сбой ОДНОЙ компании не должен ронять весь прогон (иначе список,
// найденный до неё, теряется целиком).

import assert from 'node:assert/strict'
import { extractDescription, extractEmails, extractSocials } from '../supabase/functions/_shared/leadgen/enricher.ts'
import { runSdrPipeline } from '../supabase/functions/_shared/leadgen/pipeline.ts'
import { parseCsv, GooglePlacesSearch, toRawPlace } from '../supabase/functions/_shared/leadgen/placesSearch.ts'
import { formatHotLeadMessage, TelegramNotifier } from '../supabase/functions/_shared/leadgen/notifier.ts'
import { LlmIcpScorer, stripJsonFence } from '../supabase/functions/_shared/leadgen/scorer.ts'
import { statusFor as realStatusFor } from '../supabase/functions/_shared/leadgen/schemas.ts'

// --- Извлечение из HTML: реальный сигнал против HTML/CSS-мусора ---------------------------------

{
  const html = '<html><head><meta name="description" content="Стоматология в Ташкенте"></head><body>'
    + '<script>var x = "fake@2x.png";</script>'
    + '<a href="https://instagram.com/denta">IG</a>'
    + '<p>info@denta.uz, sales@denta.uz</p>'
    + '<img srcset="logo@2x.png 2x">'
    + '</body></html>'
  assert.deepEqual(extractEmails(html), ['info@denta.uz', 'sales@denta.uz'],
    'image@2x.png в srcset и в <script> похож на email по форме, но им не является')
  assert.equal(extractSocials(html).instagram, 'https://instagram.com/denta')
  assert.equal(extractDescription(html), 'Стоматология в Ташкенте')
}

assert.deepEqual(extractEmails('<p>без единого адреса</p>'), [])
assert.equal(extractSocials('<p>ничего</p>').telegram, null)
assert.equal(extractDescription('<html><body>нет meta</body></html>'), null)

// HTML-сущность в адресе — не украшение: `&amp;` в ссылке означает параметр с именем `amp;igsh`, и
// владелец, скопировавший её из отчёта, отправит клиенту нерабочую ссылку. Найдено на живой выдаче.
assert.equal(
  extractSocials('<a href="https://instagram.com/x?utm=share&amp;igsh=ZDNl">ig</a>').instagram,
  'https://instagram.com/x?utm=share&igsh=ZDNl',
)

// --- CSV: запятая в кавычках не рвёт строку ------------------------------------------------------

assert.deepEqual(
  parseCsv('name,city\n"Дента, филиал 2",Ташкент'),
  [{ name: 'Дента, филиал 2', city: 'Ташкент' }],
)
assert.deepEqual(parseCsv(''), [])

// --- toRawPlace: числа приходят и числом (Google), и строкой (CSV) --------------------------------

assert.equal(toRawPlace({ place_id: 'p1', name: 'X', rating: 4.5 }).rating, 4.5)
assert.equal(toRawPlace({ place_id: 'p1', name: 'X', rating: '4.5' }).rating, 4.5)
assert.equal(toRawPlace({ place_id: 'p1', name: 'X', rating: '' }).rating, undefined)

// --- GooglePlacesSearch: платный API, лимит запросов Details обязан соблюдаться -------------------
// Details — отдельный оплачиваемый вызов НА КАЖДУЮ запись. Вызвать его для записей за пределами
// limit значит платить за то, что в выдачу не попадёт.

{
  const detailsCalls = []
  const fakeFetch = async (url) => {
    const href = String(url)
    if (href.includes('/textsearch/')) {
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          results: [{ place_id: 'p1' }, { place_id: 'p2' }, { place_id: 'p3' }],
        }),
      }
    }
    // /details/
    const placeId = new URL(href).searchParams.get('place_id')
    detailsCalls.push(placeId)
    return { ok: true, json: async () => ({ status: 'OK', result: { place_id: placeId, name: `Place ${placeId}` } }) }
  }
  const search = new GooglePlacesSearch('fake-key', fakeFetch)
  const { places, stats } = await search.search({ query: 'q', city: 'c', limit: 2 })
  assert.equal(places.length, 2, 'выдача обрезана по limit')
  assert.deepEqual(detailsCalls, ['p1', 'p2'], 'Details вызван РОВНО для того, что попало в limit — не для p3')
  assert.equal(stats.pages, 1)
}

// --- Scorer: статус решает ТОЛЬКО порог, что бы ни прислала модель --------------------------------

{
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ score: 45, status: 'HOT', reason: 'x', key_decision_maker: null, icebreaker_pitch: null }) } }],
    }),
  })
  const scorer = new LlmIcpScorer('fake-key', 'test-model', fakeFetch)
  const company = { place_id: 'p1', name: 'X', normalized_name: 'x', city: 'Ташкент', dedupe_key: '0'.repeat(64), address: null, phone: null, website: null, rating: null, reviews: null, operational: true }
  const enrichment = { description: null, emails: [], socials: { linkedin: null, instagram: null, telegram: null, facebook: null }, people: [], failed: [] }
  const result = await scorer.score(company, enrichment, 'icp')
  assert.equal(result.status, 'QUALIFIED', 'score 45 — QUALIFIED вопреки status:"HOT" от модели')
  assert.equal(result.status, realStatusFor(45), 'совпадает с независимо посчитанным порогом')
}

// Мусор вместо JSON — score() возвращает null, а не бросает исключение (это решает пайплайн, а не
// один провалившийся ответ модели).
{
  const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'не JSON вовсе' } }] }) })
  const scorer = new LlmIcpScorer('fake-key', 'test-model', fakeFetch)
  const company = { place_id: 'p1', name: 'X', normalized_name: 'x', city: 'Ташкент', dedupe_key: '0'.repeat(64), address: null, phone: null, website: null, rating: null, reviews: null, operational: true }
  const enrichment = { description: null, emails: [], socials: { linkedin: null, instagram: null, telegram: null, facebook: null }, people: [], failed: [] }
  assert.equal(await scorer.score(company, enrichment, 'icp'), null)
}

assert.equal(stripJsonFence('```json\n{"score":1}\n```'), '{"score":1}')

// --- Notifier: только HOT уходит в Telegram --------------------------------------------------------

{
  const sent = []
  const fakeFetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) } }
  const notifier = new TelegramNotifier('token', 'chat', fakeFetch)
  const baseLead = { place_id: 'p1', name: 'X', normalized_name: 'x', city: 'Ташкент', dedupe_key: '0'.repeat(64), address: null, phone: null, website: null, rating: null, reviews: null, operational: true, enrichment: { description: null, emails: [], socials: { linkedin: null, instagram: null, telegram: null, facebook: null }, people: [], failed: [] }, found_at: new Date(0).toISOString() }

  const qualified = { ...baseLead, score: { score: 50, status: 'QUALIFIED', reason: 'r', key_decision_maker: null, icebreaker_pitch: null } }
  const notQualifiedResult = await notifier.alertHot(qualified)
  assert.equal(notQualifiedResult.ok, false)
  assert.equal(notQualifiedResult.error, 'not_hot')
  assert.equal(sent.length, 0, 'QUALIFIED не отправлен вовсе — ни один запрос к Telegram не ушёл')

  const hot = { ...baseLead, score: { score: 90, status: 'HOT', reason: 'r', key_decision_maker: null, icebreaker_pitch: null } }
  const hotResult = await notifier.alertHot(hot)
  assert.equal(hotResult.ok, true)
  assert.equal(sent.length, 1)
}

assert.ok(formatHotLeadMessage({
  place_id: 'p1', name: '<script>alert(1)</script>', normalized_name: 'x', city: 'Ташкент & область', dedupe_key: '0'.repeat(64),
  address: null, phone: null, website: null, rating: null, reviews: null, operational: true,
  enrichment: { description: null, emails: [], socials: { linkedin: null, instagram: null, telegram: null, facebook: null }, people: [], failed: [] },
  score: { score: 90, status: 'HOT', reason: 'r', key_decision_maker: null, icebreaker_pitch: null },
  found_at: new Date(0).toISOString(),
}).includes('&lt;script&gt;'), 'название компании экранировано — parse_mode HTML не должен исполнить чужую разметку')

// --- Пайплайн: сбой одной компании не роняет весь прогон -------------------------------------------

{
  const rawPlaces = [
    { place_id: 'good', name: 'Хорошая', international_phone_number: '+998901112233', website: 'https://good.uz', business_status: 'OPERATIONAL' },
    { place_id: 'bad', name: 'Ломает обогащение', international_phone_number: '+998901112234', website: 'https://bad.uz', business_status: 'OPERATIONAL' },
  ]
  const search = { search: async () => ({ places: rawPlaces, stats: { pages: 1, exhausted: true } }) }
  const enrich = {
    enrich: async (company) => {
      if (company.name.includes('Ломает')) throw new Error('boom')
      return { description: null, emails: [], socials: { linkedin: null, instagram: null, telegram: null, facebook: null }, people: [], failed: [] }
    },
  }
  const score = { score: async () => ({ score: 90, status: 'HOT', reason: 'r', key_decision_maker: null, icebreaker_pitch: null }) }
  const result = await runSdrPipeline({ query: 'qq', city: 'Ташкент', limit: 10 }, { search, enrich, score, store: null, notify: null })

  assert.equal(result.leads.length, 2, 'обе компании остались в выдаче — сбой обогащения не выбросил компанию из списка')
  assert.equal(result.failures.filter((f) => f.stage === 'enrich').length, 1, 'сбой назван, а не проглочен молча')
  assert.equal(result.hot, 2, 'оценка сработала для обеих — сбой enrich() не остановил score()')
}

// Полный отказ поиска — единственное, что оставляет пайплайн буквально без лидов, а не деградирует.
{
  const search = { search: async () => { throw new Error('Google 500') } }
  const enrich = { enrich: async () => ({ description: null, emails: [], socials: { linkedin: null, instagram: null, telegram: null, facebook: null }, people: [], failed: [] }) }
  const result = await runSdrPipeline({ query: 'qq', city: 'Ташкент', limit: 10 }, { search, enrich, score: null, store: null, notify: null })
  assert.equal(result.found, 0)
  assert.equal(result.failures[0].stage, 'search')
}

console.log('[OK] SDR pipeline behaviour: 25 assertions')
