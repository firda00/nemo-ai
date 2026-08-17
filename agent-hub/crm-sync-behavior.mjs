// Синхронизация горячих лидов во внешнюю CRM. Приёмник замокан — ни одного настоящего запроса.
//
// Дороже всего здесь стоят три вещи: формат нагрузки (приёмник у клиента настроен под него, и
// молчаливое переименование поля ломает его интеграцию), повтор ТОЛЬКО того, что может пройти со
// второй попытки (повтор 400 трижды — шум в чужом журнале, а не надёжность), и полная безвредность
// отказа для фиксации задачи (иначе воркер возьмёт её снова и спишет кредиты второй раз).

import assert from 'node:assert/strict'
import {
  backoffDelay,
  isRetryable,
  resolveCrmConfig,
  syncHotLeadsToCrm,
  toCrmPayload,
} from './crm-sync.ts'

const hotLead = {
  place_id: 'osm:node/1', dedupe_key: 'a'.repeat(64), name: 'Дента', normalized_name: 'дента', city: 'Ташкент',
  address: 'ул. Тестовая 1', phone: '+998712562363', website: 'https://denta.uz/', rating: 4.7, reviews: 128,
  operational: true,
  enrichment: {
    description: null, emails: ['info@denta.uz'],
    socials: { linkedin: null, instagram: 'https://instagram.com/denta', telegram: 'https://t.me/denta', facebook: null },
    people: [], failed: [],
  },
  score: {
    score: 85, status: 'HOT', reason: 'Есть сайт и высокий рейтинг',
    key_decision_maker: 'Иван Петров', icebreaker_pitch: 'Поможем не терять заявки ночью.',
  },
  found_at: '2026-08-17T12:00:00.000Z',
}
const warmLead = { ...hotLead, dedupe_key: 'b'.repeat(64), name: 'Тёплая', score: { ...hotLead.score, score: 50, status: 'QUALIFIED' } }

const ENV = { CRM_WEBHOOK_URL: 'https://hook.example.com/nemo', CRM_BEARER_TOKEN: 'secret-token' }
const noSleep = async () => {}

/** Мок приёмника: пишет каждый запрос и отвечает по заданному сценарию. */
function mockReceiver(responses) {
  const calls = []
  const queue = [...responses]
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body), method: init.method })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next instanceof Error) throw next
    if (next.throwName) { const e = new Error('aborted'); e.name = next.throwName; throw e }
    return { ok: next.status >= 200 && next.status < 300, status: next.status }
  }
  return { calls, fetchImpl }
}

// --- Настройки: выключено это не ошибка, а негодный адрес — ошибка -------------------------------

assert.deepEqual(resolveCrmConfig({}), { enabled: false, reason: 'CRM_WEBHOOK_URL не задан' },
  'без адреса синхронизация просто выключена — большинство запусков идёт без CRM')

{
  // Опечатка в адресе НЕ должна тихо превращаться в «выключено»: обещание доставки без доставки
  // обнаружится через неделю по пустой CRM.
  const bad = resolveCrmConfig({ CRM_WEBHOOK_URL: 'hook.example.com/nemo' })
  assert.equal(bad.enabled, false)
  assert.ok(bad.reason.includes('полным адресом'), 'причина названа, а не «выключено»')
}

{
  const ok = resolveCrmConfig(ENV)
  assert.equal(ok.enabled, true)
  assert.equal(ok.config.CRM_WEBHOOK_URL, ENV.CRM_WEBHOOK_URL)
  assert.equal(ok.config.CRM_BEARER_TOKEN, 'secret-token')
}
// Токен опционален: у Make и n8n сам адрес вебхука и есть секрет.
assert.equal(resolveCrmConfig({ CRM_WEBHOOK_URL: ENV.CRM_WEBHOOK_URL }).config.CRM_BEARER_TOKEN, undefined)
// Пустая строка — это «не задан», а не «токен из нуля символов».
assert.equal(resolveCrmConfig({ ...ENV, CRM_BEARER_TOKEN: '' }).config.CRM_BEARER_TOKEN, undefined)

// --- Формат нагрузки: приёмник у клиента настроен под него ----------------------------------------

{
  const payload = toCrmPayload(hotLead, 'row-uuid-1')
  assert.deepEqual(Object.keys(payload).sort(), [
    'city', 'created_at', 'icebreaker', 'icp_reasoning', 'id', 'lead_id',
    'name', 'phone', 'score', 'socials', 'status', 'website',
  ], 'состав полей зафиксирован — переименование ломает интеграцию у клиента')

  assert.equal(payload.id, 'a'.repeat(64), 'id — устойчивый ключ: тот же бизнес даст тот же id')
  assert.equal(payload.lead_id, 'row-uuid-1', 'ссылка на строку в базе, чтобы связать записи')
  assert.equal(payload.name, 'Дента')
  assert.equal(payload.city, 'Ташкент')
  assert.equal(payload.phone, '+998712562363')
  assert.equal(payload.website, 'https://denta.uz/')
  assert.equal(payload.score, 85)
  assert.equal(payload.status, 'HOT')
  assert.equal(payload.icp_reasoning, 'Есть сайт и высокий рейтинг')
  assert.equal(payload.icebreaker, 'Поможем не терять заявки ночью.')
  assert.equal(payload.created_at, '2026-08-17T12:00:00.000Z', 'время находки лида, а не время отправки')
  assert.deepEqual(payload.socials, {
    telegram: 'https://t.me/denta', instagram: 'https://instagram.com/denta',
    linkedin: null, facebook: null, emails: ['info@denta.uz'],
  })
}

// Пустые поля приезжают как null, а не как undefined: undefined исчезает при JSON.stringify, и
// приёмник видит отсутствие поля вместо явного «значения нет».
{
  const bare = toCrmPayload({ ...hotLead, phone: null, website: null, enrichment: {}, score: null })
  const json = JSON.parse(JSON.stringify(bare))
  assert.equal(json.phone, null)
  assert.equal(json.website, null)
  assert.equal(json.score, null)
  assert.equal(json.icebreaker, null)
  assert.equal(json.lead_id, null)
  assert.ok('phone' in json && 'score' in json, 'поля остаются в объекте, а не пропадают')
}

// --- Заголовки -----------------------------------------------------------------------------------

{
  const { calls, fetchImpl } = mockReceiver([{ status: 200 }])
  await syncHotLeadsToCrm([hotLead], { env: ENV, fetchImpl, sleep: noSleep, idByKey: new Map([[hotLead.dedupe_key, 'row-1']]) })
  const call = calls[0]
  assert.equal(call.method, 'POST')
  assert.equal(call.url, ENV.CRM_WEBHOOK_URL)
  assert.equal(call.headers['Content-Type'], 'application/json')
  assert.equal(call.headers.Authorization, 'Bearer secret-token')
  // Ключ идемпотентности нужен ИЗ-ЗА повторов: если первая попытка дошла, а ответ потерялся, вторая
  // создала бы у клиента дубль того же лида.
  assert.equal(call.headers['Idempotency-Key'], hotLead.dedupe_key)
  assert.equal(call.body.lead_id, 'row-1')
}

// Токена нет — заголовка Authorization нет вовсе, а не «Bearer undefined».
{
  const { calls, fetchImpl } = mockReceiver([{ status: 200 }])
  await syncHotLeadsToCrm([hotLead], { env: { CRM_WEBHOOK_URL: ENV.CRM_WEBHOOK_URL }, fetchImpl, sleep: noSleep })
  assert.equal('Authorization' in calls[0].headers, false)
}

// --- ТОЛЬКО горячие ------------------------------------------------------------------------------

{
  const { calls, fetchImpl } = mockReceiver([{ status: 200 }])
  const outcome = await syncHotLeadsToCrm([warmLead, hotLead, { ...hotLead, dedupe_key: 'c'.repeat(64), score: null }], {
    env: ENV, fetchImpl, sleep: noSleep,
  })
  assert.equal(calls.length, 1, 'тёплый и неоценённый в CRM не уходят')
  assert.equal(calls[0].body.name, 'Дента')
  assert.equal(outcome.sent, 1)
  assert.deepEqual(outcome.syncedKeys, [hotLead.dedupe_key])
}

// Выключенная синхронизация не делает ни одного запроса и честно называет причину.
{
  const { calls, fetchImpl } = mockReceiver([{ status: 200 }])
  const outcome = await syncHotLeadsToCrm([hotLead], { env: {}, fetchImpl, sleep: noSleep })
  assert.equal(calls.length, 0)
  assert.equal(outcome.sent, 0)
  assert.ok(outcome.skipped.includes('CRM_WEBHOOK_URL'))
}

// --- Что повторять, а что нет --------------------------------------------------------------------

assert.equal(isRetryable(null), true, 'сеть не ответила — повтор осмыслен')
assert.equal(isRetryable(500), true)
assert.equal(isRetryable(503), true)
assert.equal(isRetryable(429), true, 'приёмник попросил подождать')
assert.equal(isRetryable(400), false, 'мы отправили не то — повтор пришлёт то же самое')
assert.equal(isRetryable(401), false)
assert.equal(isRetryable(404), false)
assert.equal(isRetryable(200), false)

// Задержка растёт, а не остаётся постоянной: три запроса подряд в лежащий приёмник его не поднимут.
assert.equal(backoffDelay(0, 500), 500)
assert.equal(backoffDelay(1, 500), 1000)
assert.equal(backoffDelay(2, 500), 2000)

// 5xx — три попытки всего (первая + два повтора), потом отказ с числом попыток.
{
  const { calls, fetchImpl } = mockReceiver([{ status: 503 }])
  const outcome = await syncHotLeadsToCrm([hotLead], { env: ENV, fetchImpl, sleep: noSleep })
  assert.equal(calls.length, 3, 'первая попытка плюс два повтора')
  assert.equal(outcome.sent, 0)
  assert.equal(outcome.failed, 1)
  assert.ok(outcome.errors[0].includes('3 попыток'))
  assert.deepEqual(outcome.syncedKeys, [], 'неотправленное не помечается отправленным')
}

// 5xx, затем успех — повтор доводит дело до конца.
{
  const { calls, fetchImpl } = mockReceiver([{ status: 500 }, { status: 200 }])
  const outcome = await syncHotLeadsToCrm([hotLead], { env: ENV, fetchImpl, sleep: noSleep })
  assert.equal(calls.length, 2)
  assert.equal(outcome.sent, 1)
  assert.deepEqual(outcome.syncedKeys, [hotLead.dedupe_key])
}

// 400 — ОДНА попытка. Повторять свою же ошибку трижды значит трижды намусорить в чужом журнале.
{
  const { calls, fetchImpl } = mockReceiver([{ status: 400 }])
  const outcome = await syncHotLeadsToCrm([hotLead], { env: ENV, fetchImpl, sleep: noSleep })
  assert.equal(calls.length, 1)
  assert.equal(outcome.failed, 1)
  assert.ok(outcome.errors[0].includes('HTTP 400'))
}

// --- Таймаут ------------------------------------------------------------------------------------
// Зависший приёмник не должен держать воркер. AbortSignal.timeout приходит как TimeoutError.

{
  const { calls, fetchImpl } = mockReceiver([{ throwName: 'TimeoutError' }])
  const outcome = await syncHotLeadsToCrm([hotLead], { env: ENV, fetchImpl, sleep: noSleep })
  assert.equal(calls.length, 3, 'таймаут повторяется — ответа не было, а не «отказано»')
  assert.equal(outcome.failed, 1)
  assert.ok(outcome.errors[0].includes('таймаут'), 'таймаут назван словом, а не кодом')
}

// Сеть оборвалась — тоже повтор, и наружу выходит объект, а не исключение.
{
  const { calls, fetchImpl } = mockReceiver([new Error('ECONNREFUSED')])
  const outcome = await syncHotLeadsToCrm([hotLead], { env: ENV, fetchImpl, sleep: noSleep })
  assert.equal(calls.length, 3)
  assert.equal(outcome.failed, 1)
  assert.ok(outcome.errors[0].includes('ECONNREFUSED'))
}

// --- Никогда не бросает ---------------------------------------------------------------------------
// Вызывается перед фиксацией задачи: исключение здесь стоило бы повторной обработки и повторного
// списания кредитов.

for (const leads of [null, undefined, [], [null], [{}], [{ score: {} }]]) {
  const { fetchImpl } = mockReceiver([{ status: 200 }])
  const outcome = await syncHotLeadsToCrm(leads, { env: ENV, fetchImpl, sleep: noSleep })
  assert.equal(typeof outcome.sent, 'number', `не падаем на ${JSON.stringify(leads)}`)
}

// Один сломанный лид не мешает остальным уехать.
{
  const { calls, fetchImpl } = mockReceiver([{ status: 200 }])
  const broken = { dedupe_key: 'd'.repeat(64), score: { status: 'HOT' } } // ни имени, ни enrichment
  const outcome = await syncHotLeadsToCrm([broken, hotLead], { env: ENV, fetchImpl, sleep: noSleep })
  assert.equal(outcome.sent + outcome.failed, 2, 'обработаны оба, а не остановились на первом')
  assert.ok(calls.some((one) => one.body.name === 'Дента'), 'здоровый лид всё равно уехал')
}

console.log('[OK] CRM sync behaviour: 72 assertions')
