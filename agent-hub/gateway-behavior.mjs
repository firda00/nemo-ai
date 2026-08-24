// API Gateway и очередь на Dragonfly.
//
// ГЛАВНОЕ, что здесь защищается, — ДВЕ ГРАНИЦЫ, каждая из которых стоит денег при ошибке.
//
// Первая: ПРИВЯЗКА ЗАДАЧИ К АККАУНТУ. Идентификатор задачи — обычный UUID, он попадает в журналы, в
// историю браузера и в переписку. Забытый фильтр по account_id означает, что чужой идентификатор
// отдаёт чужие лиды: имена, телефоны и оценки компаний, за которые заплатил другой владелец.
//
// Вторая: ПОРЯДОК ПРОВЕРОК И ПОРЯДОК ЗАПИСИ. Расход минутного лимита считается ПОСЛЕ подтверждения
// права — иначе подобранный ключ жжёт квоту настоящего владельца. Сигнал в очередь публикуется ПОСЛЕ
// создания задачи в Postgres и его неудача НЕ отменяет ответ — иначе клиент поставит задачу второй раз
// и заплатит дважды за уже существующую.
//
// Fastify поднимается на НАСТОЯЩЕМ сокете в конце файла: маршрутизация, разбор тела и заголовков —
// тоже поведение, и проверять его вызовом обработчика напрямую значит не проверять вовсе.

import assert from 'node:assert/strict'
import {
  JOB_ID_SHAPE, authenticate, buildGateway, handleCreateJob, handleCrmWebhook, handleGetJob,
  handleHealth, handleNativeAmoWebhook, parseJobRequest, secretsMatch,
} from './server/gateway.ts'
import {
  BLOCK_SECONDS, JOB_SIGNAL_KEY, connectQueue, createQueue, disabledQueue, resolveRedisUrl,
} from './server/queue.ts'
import { generateToken, hashToken } from '../supabase/functions/_shared/apiTokens.ts'

let checks = 0
const check = (fn) => { fn(); checks++ }
const checkAsync = async (fn) => { await fn(); checks++ }

const PEPPER = 'перец-проверки'
const ACCOUNT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER_ACCOUNT = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
const JOB = '11111111-2222-3333-4444-555555555555'
const TOKEN = generateToken()
const HASH = await hashToken(TOKEN, PEPPER)

/** Мок Supabase. Пишет в журнал вызовов, чтобы проверялся не только ответ, но и ПОРЯДОК обращений. */
function makeAdmin(options = {}) {
  const calls = []
  const inserted = []
  const runtimeEvents = new Set()
  const tokenRow = options.tokenRow === undefined
    ? {
      id: 'tok-1', account_id: ACCOUNT, allowed_actions: ['sdr:trigger', 'sdr:read'],
      rate_limit_per_minute: 30, is_active: true, expires_at: null,
    }
    : options.tokenRow

  const admin = {
    calls,
    inserted,
    from(table) {
      calls.push(`from:${table}`)
      return {
        select: () => ({
          eq: (column, value) => ({
            eq: (column2, value2) => ({
              maybeSingle: async () => {
                calls.push(`select:${table}:${column}=${value}&${column2}=${value2}`)
                const mine = table === 'sdr_jobs' && value === ACCOUNT && value2 === JOB
                return { data: mine ? { id: JOB, status: 'queued', params: {} } : null }
              },
            }),
            maybeSingle: async () => {
              calls.push(`select:${table}:${column}`)
              if (table === 'nemo_api_tokens') return { data: value === HASH ? tokenRow : null }
              if (table === 'billing_subscriptions') return { data: { status: options.subscription ?? 'active' } }
              return { data: null }
            },
            order: async () => ({ data: [{ name: 'Дента', phone: '+998712000000' }] }),
          }),
          limit: async () => {
            calls.push('health:select')
            return options.databaseDown
              ? { data: null, error: { message: 'connection refused' } }
              : { data: [], error: null }
          },
        }),
        update: () => ({ eq: async () => { calls.push(`update:${table}`); return {} } }),
        insert: async (values) => {
          calls.push(`insert:${table}`)
          if (options.insertError) return { error: options.insertError }
          if (inserted.some((one) => one.idempotency_key === values.idempotency_key)) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          }
          inserted.push(values)
          return { error: null }
        },
      }
    },
    async rpc(name, args) {
      calls.push(`rpc:${name}`)
      if (name === 'resolve_amocrm_webhook') {
        if (options.amoResolveError) return { data: null, error: options.amoResolveError }
        return {
          data: options.amoResolution === null ? [] : [options.amoResolution ?? {
            account_id: ACCOUNT,
            integration_id: '93333333-4444-4555-8666-777777777777',
            account_domain: 'nemo-test',
          }],
          error: null,
        }
      }
      if (name === 'nemo_token_consume_rate') return { data: options.rateAllowed ?? true, error: null }
      if (name === 'enqueue_sdr_job') {
        if (options.enqueueError) return { data: null, error: { message: 'boom' } }
        if (options.insufficientCredits) return { data: { ok: false, error: 'insufficient_credits' }, error: null }
        return { data: { ok: true, job_id: JOB, reserved: args.p_cost }, error: null }
      }
      if (name === 'runtime_ingest_event') {
        if (options.runtimeError) return { data: null, error: options.runtimeError }
        const key = `${args.p_account_id}:${args.p_provider}:${args.p_external_event_id}`
        const duplicate = runtimeEvents.has(key)
        runtimeEvents.add(key)
        return {
          data: {
            status: duplicate ? 'duplicate' : 'created',
            workflow_id: '91111111-2222-4333-8444-555555555555',
            inbox_event_id: '92222222-3333-4444-8555-666666666666',
          },
          error: null,
        }
      }
      return { data: null, error: null }
    },
  }
  return admin
}

function makeQueue(options = {}) {
  const published = []
  const trimmed = []
  return {
    published,
    trimmed,
    queue: createQueue({
      rpush: async (key, value) => {
        if (options.publishThrows) throw new Error('Dragonfly недоступен')
        published.push([key, value])
        return published.length
      },
      ltrim: async (key, start, stop) => { trimmed.push([key, start, stop]); return 'OK' },
      blpop: async () => (options.blpopThrows ? Promise.reject(new Error('обрыв')) : options.popped ?? null),
      llen: async () => published.length,
      ping: async () => { if (options.pingThrows) throw new Error('нет соединения'); return 'PONG' },
      quit: async () => 'OK',
    }),
  }
}

const deps = (overrides = {}) => ({
  admin: overrides.admin ?? makeAdmin(),
  queue: overrides.queue ?? makeQueue().queue,
  pepper: overrides.pepper ?? PEPPER,
  crmSecret: overrides.crmSecret ?? 'crm-secret-abc123',
  entitlement: overrides.entitlement,
})

const bearer = (token) => `Bearer ${token}`

// ─── Очередь ──────────────────────────────────────────────────────────────────────────────────────

check(() => assert.equal(resolveRedisUrl({}), null))
check(() => assert.equal(resolveRedisUrl({ REDIS_URL: 'redis://dragonfly:6379' }), 'redis://dragonfly:6379'))
// Пустая строка — это НЕ адрес. В docker-compose переменная легко оказывается объявленной и
// незаполненной, и «redis://» в таком виде не подключится никуда.
check(() => assert.equal(resolveRedisUrl({ REDIS_URL: '   ' }), null))
check(() => assert.equal(resolveRedisUrl({ DRAGONFLY_URL: 'redis://x:6379' }), 'redis://x:6379'))

await checkAsync(async () => {
  const off = disabledQueue()
  assert.equal(off.enabled, false)
  assert.equal(await off.publish('job'), false)
  assert.equal(await off.waitForJob(1), null)
  assert.deepEqual(await off.health(), { configured: false, reachable: false, latencyMs: null, pending: null, error: 'REDIS_URL не задан' })
})

await checkAsync(async () => {
  const { queue, published, trimmed } = makeQueue()
  assert.equal(await queue.publish(JOB), true)
  assert.deepEqual(published, [[JOB_SIGNAL_KEY, JOB]])
  // Хвост обрезается: список сигналов, который никто не разбирает, растёт неограниченно и однажды
  // съедает память Dragonfly целиком.
  assert.equal(trimmed.length, 1)
  assert.equal(trimmed[0][0], JOB_SIGNAL_KEY)
})

// publish НЕ БРОСАЕТ ни при каких обстоятельствах. Задача к этому моменту уже создана и кредиты
// списаны; исключение здесь означало бы ответ «не получилось» при существующей задаче.
await checkAsync(async () => {
  const { queue } = makeQueue({ publishThrows: true })
  assert.equal(await queue.publish(JOB), false)
})

// Обрыв соединения на ожидании не должен останавливать воркер: он сходит в базу опросом.
await checkAsync(async () => {
  const { queue } = makeQueue({ blpopThrows: true })
  assert.equal(await queue.waitForJob(1), null)
})
await checkAsync(async () => {
  const { queue } = makeQueue({ popped: [JOB_SIGNAL_KEY, JOB] })
  assert.equal(await queue.waitForJob(1), JOB, 'из ответа BLPOP берётся значение, а не имя ключа')
})

await checkAsync(async () => {
  const { queue } = makeQueue()
  const health = await queue.health()
  assert.equal(health.configured, true)
  assert.equal(health.reachable, true)
  assert.equal(typeof health.latencyMs, 'number')
})
await checkAsync(async () => {
  const { queue } = makeQueue({ pingThrows: true })
  const health = await queue.health()
  assert.equal(health.configured, true, 'адрес задан — значит очередь настроена, просто недоступна')
  assert.equal(health.reachable, false)
  assert.match(health.error, /нет соединения/)
})

// Недоступный Dragonfly не должен ронять процесс: шлюз обязан подниматься и работать без ускорения.
await checkAsync(async () => {
  const fallback = await connectQueue('redis://нет-такого:6379', () => { throw new Error('ECONNREFUSED') })
  assert.equal(fallback.enabled, false)
  assert.match((await fallback.health()).error, /ECONNREFUSED/)
})
check(() => assert.ok(BLOCK_SECONDS > 0 && BLOCK_SECONDS <= 60, 'ожидание должно быть конечным: вечный BLPOP не переживает перезапуск Dragonfly'))

// ─── Авторизация ──────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const result = await authenticate(deps(), bearer(TOKEN), 'sdr:trigger')
  assert.equal(result.ok, true)
  assert.equal(result.accountId, ACCOUNT)
})

await checkAsync(async () => {
  const result = await authenticate(deps(), null, 'sdr:trigger')
  assert.equal(result.response.status, 401)
  assert.equal(result.response.body.error, 'no_token')
})
await checkAsync(async () => {
  const result = await authenticate(deps(), bearer(generateToken()), 'sdr:trigger')
  assert.equal(result.response.body.error, 'unknown_token')
})
await checkAsync(async () => {
  const result = await authenticate(deps(), 'Basic dXNlcjpwYXNz', 'sdr:trigger')
  assert.equal(result.response.body.error, 'no_token', 'чужая схема авторизации — не наш токен')
})

// Без перца отпечаток посчитать нечем. Отказ ЗАКРЫТЫЙ: работать «пока без проверки» означало бы
// принимать любой токен, то есть открыть очередь всему интернету.
await checkAsync(async () => {
  const result = await authenticate(deps({ pepper: '' }), bearer(TOKEN), 'sdr:trigger')
  assert.equal(result.response.status, 503)
  assert.equal(result.response.body.error, 'gateway_not_configured')
})

await checkAsync(async () => {
  const admin = makeAdmin({ tokenRow: { id: 't', account_id: ACCOUNT, allowed_actions: ['sdr:read'], rate_limit_per_minute: 30, is_active: false, expires_at: null } })
  const result = await authenticate(deps({ admin }), bearer(TOKEN), 'sdr:read')
  assert.equal(result.response.body.error, 'token_inactive')
})
await checkAsync(async () => {
  const admin = makeAdmin({ tokenRow: { id: 't', account_id: ACCOUNT, allowed_actions: ['sdr:read'], rate_limit_per_minute: 30, is_active: true, expires_at: '2020-01-01T00:00:00Z' } })
  const result = await authenticate(deps({ admin }), bearer(TOKEN), 'sdr:read')
  assert.equal(result.response.body.error, 'token_expired')
})
// DENY BY DEFAULT: пустой список прав означает «нельзя», а не «всё».
await checkAsync(async () => {
  const admin = makeAdmin({ tokenRow: { id: 't', account_id: ACCOUNT, allowed_actions: [], rate_limit_per_minute: 30, is_active: true, expires_at: null } })
  const result = await authenticate(deps({ admin }), bearer(TOKEN), 'sdr:trigger')
  assert.equal(result.response.status, 403)
  assert.equal(result.response.body.error, 'action_not_allowed')
})
// Право на чтение НЕ даёт права на постановку задачи: это разные действия и разные деньги.
await checkAsync(async () => {
  const admin = makeAdmin({ tokenRow: { id: 't', account_id: ACCOUNT, allowed_actions: ['sdr:read'], rate_limit_per_minute: 30, is_active: true, expires_at: null } })
  const result = await authenticate(deps({ admin }), bearer(TOKEN), 'sdr:trigger')
  assert.equal(result.response.body.error, 'action_not_allowed')
})
await checkAsync(async () => {
  const admin = makeAdmin({ rateAllowed: false })
  const result = await authenticate(deps({ admin }), bearer(TOKEN), 'sdr:trigger')
  assert.equal(result.response.status, 429)
})

/*
 * ПОРЯДОК: право — раньше расхода лимита.
 *
 * Если считать расход первым, чужой подобранный ключ жжёт минутную квоту настоящего владельца, ничего
 * при этом не выполняя: сто запросов в минуту от постороннего — и владелец не может работать своим же
 * ключом. Проверяется по журналу обращений, а не по ответу: ответ в обоих случаях одинаковый.
 */
await checkAsync(async () => {
  const admin = makeAdmin({ tokenRow: { id: 't', account_id: ACCOUNT, allowed_actions: [], rate_limit_per_minute: 30, is_active: true, expires_at: null } })
  await authenticate(deps({ admin }), bearer(TOKEN), 'sdr:trigger')
  assert.equal(admin.calls.includes('rpc:nemo_token_consume_rate'), false,
    'лимит не должен расходоваться на запросе, отклонённом по правам')
})
await checkAsync(async () => {
  const admin = makeAdmin()
  await authenticate(deps({ admin }), bearer(TOKEN), 'sdr:trigger')
  const tokenLookup = admin.calls.findIndex((one) => one.startsWith('select:nemo_api_tokens'))
  const rate = admin.calls.indexOf('rpc:nemo_token_consume_rate')
  assert.ok(tokenLookup >= 0 && rate > tokenLookup, 'сначала находим токен, потом считаем расход')
})

// ─── POST /v1/sdr/jobs ────────────────────────────────────────────────────────────────────────────

check(() => assert.deepEqual(parseJobRequest({ query: 'стоматология', city: 'Ташкент' }).params,
  { query: 'стоматология', city: 'Ташкент', limit: 50, icp: null }))
// Пределы те же, что в Edge Function: одинаковый запрос обязан стоить одинаково в обеих дверях.
check(() => assert.equal(parseJobRequest({ query: 'x'.repeat(2), city: 'Ташкент', limit: 9999 }).params.limit, 200))
check(() => assert.equal(parseJobRequest({ query: 'ab', city: 'Ташкент', limit: 'много' }).params.limit, 50))
check(() => assert.equal(parseJobRequest({ query: 'ab', city: 'Ташкент', limit: -5 }).params.limit, 1))

/*
 * limit: 0 даёт 50, а НЕ 1 — и это фиксируется здесь как есть, потому что ровно так ведёт себя
 * Edge Function.
 *
 * Причина: `Number(0) || 50` возвращает 50, ноль ложный. То есть клиент, приславший ноль из
 * неинициализированной переменной, платит за пятьдесят лидов. Поведение спорное, но ОДИНАКОВОЕ в обеих
 * дверях, и это важнее: разойтись здесь значило бы, что один и тот же запрос стоит по-разному в
 * зависимости от того, куда он попал. Чинить это надо в обоих местах сразу и отдельным изменением.
 */
check(() => assert.equal(parseJobRequest({ query: 'ab', city: 'Ташкент', limit: 0 }).params.limit, 50))
check(() => assert.equal(parseJobRequest({ query: 'a', city: 'Ташкент' }).ok, false))
check(() => assert.equal(parseJobRequest({ query: 'стоматология', city: 'Т' }).ok, false))
check(() => assert.equal(parseJobRequest({}).ok, false))
check(() => assert.equal(parseJobRequest(null).ok, false))
check(() => assert.equal(parseJobRequest({ query: 'я'.repeat(500), city: 'Ташкент' }).params.query.length, 200))
// Пустой ICP — null, а не пустая строка: в базу должно лечь отсутствие значения, а не «».
check(() => assert.equal(parseJobRequest({ query: 'ab', city: 'Ташкент', icp: '   ' }).params.icp, null))

await checkAsync(async () => {
  const { queue, published } = makeQueue()
  const response = await handleCreateJob(deps({ queue }), bearer(TOKEN), { query: 'стоматология', city: 'Ташкент', limit: 15 })
  // 202, а не 200: задача принята, но НЕ выполнена. Двести означало бы «готово», и клиент, прочитавший
  // ответ буквально, ушёл бы за результатом, которого ещё нет.
  assert.equal(response.status, 202)
  assert.equal(response.body.job_id, JOB)
  assert.equal(response.body.status, 'queued')
  assert.equal(response.body.reserved_tokens, 15 * 700)
  assert.equal(response.body.dispatch, 'signalled')
  assert.deepEqual(published.map((one) => one[1]), [JOB])
})

/*
 * СИГНАЛ — ПОСЛЕ СОЗДАНИЯ ЗАДАЧИ, и его неудача НЕ отменяет ответ.
 *
 * Задача уже в Postgres и кредиты уже зарезервированы. Ответить клиенту ошибкой значит заставить его
 * поставить её второй раз и заплатить дважды. Не ушедший сигнал стоит одной задержки до следующего
 * прохода воркера — и это всё.
 */
await checkAsync(async () => {
  const { queue } = makeQueue({ publishThrows: true })
  const response = await handleCreateJob(deps({ queue }), bearer(TOKEN), { query: 'стоматология', city: 'Ташкент' })
  assert.equal(response.status, 202, 'отказ Dragonfly не должен отменять принятую задачу')
  assert.equal(response.body.dispatch, 'polling', 'клиент вправе знать, что воркер узнает о задаче опросом')
})
await checkAsync(async () => {
  const admin = makeAdmin()
  const { queue } = makeQueue()
  await handleCreateJob(deps({ admin, queue }), bearer(TOKEN), { query: 'стоматология', city: 'Ташкент' })
  assert.ok(admin.calls.includes('rpc:enqueue_sdr_job'), 'задача создаётся в Postgres')
})

// Очередь, НАРУШАЮЩАЯ договор и бросающая из publish, тоже не должна отменять принятую задачу.
// Проверка отдельная от предыдущей: там publish защищён собственным catch внутри createQueue, здесь
// его нет вовсе — и защита должна быть у самого шлюза. Мутационный прогон показал, что без неё
// достаточно одной новой реализации JobQueue, чтобы клиенты начали платить дважды.
await checkAsync(async () => {
  const rogue = {
    enabled: true,
    publish: async () => { throw new Error('очередь нарушила договор') },
    waitForJob: async () => null,
    health: async () => ({ configured: true, reachable: false, latencyMs: null, pending: null, error: 'x' }),
    close: async () => {},
  }
  const response = await handleCreateJob(deps({ queue: rogue }), bearer(TOKEN), { query: 'стоматология', city: 'Ташкент' })
  assert.equal(response.status, 202)
  assert.equal(response.body.dispatch, 'polling')
})

await checkAsync(async () => {
  const response = await handleCreateJob(deps(), bearer(TOKEN), { query: 'a', city: 'Ташкент' })
  assert.equal(response.status, 400)
  assert.equal(response.body.error, 'query_and_city_required')
})
// Нехватка кредитов приходит ЗНАЧЕНИЕМ из enqueue_sdr_job, а не исключением: это ответ, а не сбой.
await checkAsync(async () => {
  const response = await handleCreateJob(deps({ admin: makeAdmin({ insufficientCredits: true }) }), bearer(TOKEN), { query: 'стоматология', city: 'Ташкент' })
  assert.equal(response.status, 402)
  assert.equal(response.body.error, 'insufficient_credits')
})
await checkAsync(async () => {
  const response = await handleCreateJob(deps({ admin: makeAdmin({ enqueueError: true }) }), bearer(TOKEN), { query: 'стоматология', city: 'Ташкент' })
  assert.equal(response.status, 500)
})
// Сигнал НЕ публикуется, когда задача не создана: разбуженный впустую воркер сходит в базу зря.
await checkAsync(async () => {
  const { queue, published } = makeQueue()
  await handleCreateJob(deps({ admin: makeAdmin({ insufficientCredits: true }), queue }), bearer(TOKEN), { query: 'стоматология', city: 'Ташкент' })
  assert.equal(published.length, 0)
})

// Замок подписки: токен отвечает на «кто», подписка — на «вправе ли вообще».
await checkAsync(async () => {
  const response = await handleCreateJob(
    deps({ entitlement: async () => ({ allowed: false, reason: 'expired' }) }),
    bearer(TOKEN), { query: 'стоматология', city: 'Ташкент' },
  )
  assert.equal(response.status, 402)
  assert.equal(response.body.error, 'subscription_required')
  assert.equal(response.body.reason, 'expired')
})

// ─── GET /v1/sdr/jobs/:id ─────────────────────────────────────────────────────────────────────────

check(() => assert.equal(JOB_ID_SHAPE.test(JOB), true))
check(() => assert.equal(JOB_ID_SHAPE.test('../../etc/passwd'), false))
check(() => assert.equal(JOB_ID_SHAPE.test("' or 1=1--"), false))
check(() => assert.equal(JOB_ID_SHAPE.test('11111111-2222-3333-4444-55555555555'), false, 'короткий UUID не проходит'))

await checkAsync(async () => {
  const response = await handleGetJob(deps(), bearer(TOKEN), JOB)
  assert.equal(response.status, 200)
  assert.equal(response.body.job.id, JOB)
  assert.equal(response.body.leads.length, 1)
})

/*
 * ПРИВЯЗКА К АККАУНТУ — самая дорогая проверка файла.
 *
 * Идентификатор задачи попадает в журналы, в историю браузера и в переписку. Без фильтра по account_id
 * чужой идентификатор отдал бы чужие лиды: имена, телефоны и оценки компаний, за которые заплатил
 * другой владелец. Проверяется И по ответу, И по тому, что фильтр вообще был применён.
 */
await checkAsync(async () => {
  const admin = makeAdmin()
  const response = await handleGetJob(deps({ admin }), bearer(TOKEN), '99999999-2222-3333-4444-555555555555')
  assert.equal(response.status, 404)
  assert.equal(response.body.error, 'job_not_found')
  assert.ok(admin.calls.some((one) => one.includes(`account_id=${ACCOUNT}`)), 'фильтр по аккаунту обязан быть применён')
})
await checkAsync(async () => {
  const admin = makeAdmin({ tokenRow: { id: 't', account_id: OTHER_ACCOUNT, allowed_actions: ['sdr:read'], rate_limit_per_minute: 30, is_active: true, expires_at: null } })
  const response = await handleGetJob(deps({ admin }), bearer(TOKEN), JOB)
  assert.equal(response.status, 404, 'та же задача чужому аккаунту не видна')
})
await checkAsync(async () => {
  const response = await handleGetJob(deps(), bearer(TOKEN), 'не-uuid')
  assert.equal(response.status, 400)
  assert.equal(response.body.error, 'bad_job_id')
})

// ─── POST /v1/crm/webhook ─────────────────────────────────────────────────────────────────────────

check(() => assert.equal(secretsMatch('abc', 'abc'), true))
check(() => assert.equal(secretsMatch('abc', 'abd'), false))
check(() => assert.equal(secretsMatch('ab', 'abc'), false, 'разная длина — не совпадение'))
// Пустой ожидаемый секрет НЕ совпадает ни с чем, включая пустую строку: незаданный секрет означает
// выключенный приём, а не «пускать всех, кто тоже прислал пустоту».
check(() => assert.equal(secretsMatch('', ''), false))

const EVENT = {
  tenantId: ACCOUNT, provider: 'AMOCRM', eventType: 'DEAL_STAGE_CHANGED', externalDealId: '42',
  contactPhone: '+998901112233', pipelineId: '7', statusId: '13', occurredAt: '2026-08-17T10:00:00Z',
}

// Незаданный секрет — приём ВЫКЛЮЧЕН, а не открыт для всех. Незавершённая настройка не должна
// означать «пишем в свою базу что угодно».
await checkAsync(async () => {
  const response = await handleCrmWebhook(deps({ crmSecret: '' }), 'что-нибудь', EVENT)
  assert.equal(response.status, 503)
  assert.equal(response.body.error, 'crm_webhook_not_configured')
})
await checkAsync(async () => {
  const response = await handleCrmWebhook(deps(), 'подобранный', EVENT)
  assert.equal(response.status, 401)
})
await checkAsync(async () => {
  const response = await handleCrmWebhook(deps(), null, EVENT)
  assert.equal(response.status, 401)
})

await checkAsync(async () => {
  const admin = makeAdmin()
  const response = await handleCrmWebhook(deps({ admin }), 'crm-secret-abc123', EVENT)
  assert.equal(response.status, 200)
  assert.equal(response.body.duplicate, false)
  assert.equal(admin.inserted.length, 1)
  assert.equal(admin.inserted[0].direction, 'INBOUND')
  assert.equal(admin.inserted[0].tenant_id, ACCOUNT)
  assert.equal(admin.inserted[0].status, 'PROCESSED')
  assert.equal(response.body.runtime_shadow.ok, true)
  assert.equal(response.body.runtime_shadow.status, 'created')
  assert.ok(admin.calls.includes('rpc:runtime_ingest_event'))
})

/*
 * ПОВТОР — это 200, а не ошибка.
 *
 * Обе CRM повторяют доставку при любом не-2xx. Вернуть 409 на дубликат значит получить его снова через
 * минуту, потом через пять, и так до исчерпания их попыток — а запись при этом уже есть. Повтор здесь
 * штатная работа протокола, и уникальный ключ в базе своё дело уже сделал.
 */
await checkAsync(async () => {
  const admin = makeAdmin()
  const first = await handleCrmWebhook(deps({ admin }), 'crm-secret-abc123', EVENT)
  const second = await handleCrmWebhook(deps({ admin }), 'crm-secret-abc123', EVENT)
  assert.equal(first.body.duplicate, false)
  assert.equal(second.status, 200, 'повторная доставка не должна выглядеть отказом')
  assert.equal(second.body.duplicate, true)
  assert.equal(second.body.idempotency_key, first.body.idempotency_key)
  assert.equal(admin.inserted.length, 1, 'вторая записи в журнале быть не должно')
  assert.equal(second.body.runtime_shadow.status, 'duplicate')
})

// Разные события — разные ключи, иначе второе молча потерялось бы как «дубль».
await checkAsync(async () => {
  const admin = makeAdmin()
  await handleCrmWebhook(deps({ admin }), 'crm-secret-abc123', EVENT)
  const other = await handleCrmWebhook(deps({ admin }), 'crm-secret-abc123', { ...EVENT, externalDealId: '43' })
  assert.equal(other.body.duplicate, false)
  assert.equal(admin.inserted.length, 2)
})

// Негодное событие — 400 и НЕ повторять: оно не пройдёт и на второй доставке. Причина названа полем.
await checkAsync(async () => {
  const response = await handleCrmWebhook(deps(), 'crm-secret-abc123', { ...EVENT, contactPhone: '8-901-111' })
  assert.equal(response.status, 400)
  assert.equal(response.body.error, 'invalid_event')
  assert.ok(response.body.details.some((one) => one.includes('contactPhone')))
})
await checkAsync(async () => {
  const response = await handleCrmWebhook(deps(), 'crm-secret-abc123', { ...EVENT, provider: 'BITRIX' })
  assert.equal(response.status, 400)
})
await checkAsync(async () => {
  const response = await handleCrmWebhook(deps(), 'crm-secret-abc123', null)
  assert.equal(response.status, 400)
})
// Отказ базы, не связанный с дублем, — это 500, а не тихое «принято».
await checkAsync(async () => {
  const admin = makeAdmin({ insertError: { code: '42501', message: 'permission denied' } })
  const response = await handleCrmWebhook(deps({ admin }), 'crm-secret-abc123', EVENT)
  assert.equal(response.status, 500)
  assert.equal(response.body.error, 'sync_log_failed')
})

// Shadow-контур наблюдает, а не управляет подтверждением webhook: его сбой не заставляет amoCRM
// повторять уже принятую legacy-запись и не раскрывает наружу текст ошибки Postgres.
await checkAsync(async () => {
  const admin = makeAdmin({ runtimeError: { code: '55000', message: 'sensitive database detail' } })
  const response = await handleCrmWebhook(deps({ admin }), 'crm-secret-abc123', EVENT)
  assert.equal(response.status, 200)
  assert.equal(response.body.duplicate, false)
  assert.deepEqual(response.body.runtime_shadow, { ok: false, error_code: '55000' })
  assert.equal(JSON.stringify(response.body).includes('sensitive database detail'), false)
})

// Первый утверждённый shadow-коннектор — только amoCRM. HubSpot продолжает legacy-путь и не должен
// тихо попасть в новый рантайм до отдельного контракта идентичности и replay.
await checkAsync(async () => {
  const admin = makeAdmin()
  const response = await handleCrmWebhook(
    deps({ admin }),
    'crm-secret-abc123',
    { ...EVENT, provider: 'HUBSPOT', externalDealId: 'hubspot-42' },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.runtime_shadow, { ok: true, status: 'skipped_provider' })
  assert.equal(admin.calls.includes('rpc:runtime_ingest_event'), false)
})

// ─── Native amoCRM form webhook ──────────────────────────────────────────────────────────────────

const AMO_SECRET = 'amo_native_secret_1234567890abcdef'
const AMO_FORM = new URLSearchParams({
  'account[subdomain]': 'nemo-test',
  'account[id]': '7001',
  'leads[status][0][id]': '42',
  'leads[status][0][pipeline_id]': '7',
  'leads[status][0][status_id]': '13',
  'leads[status][0][last_modified]': '1787565600',
}).toString()

await checkAsync(async () => {
  const admin = makeAdmin()
  const response = await handleNativeAmoWebhook(deps({ admin }), AMO_SECRET, AMO_FORM)
  assert.equal(response.status, 200)
  assert.equal(response.body.created, 1)
  assert.equal(response.body.enrichment, 'queued')
  assert.ok(admin.calls.includes('rpc:resolve_amocrm_webhook'))
  assert.ok(admin.calls.includes('rpc:runtime_ingest_event'))
})

await checkAsync(async () => {
  const admin = makeAdmin({ amoResolution: null })
  const response = await handleNativeAmoWebhook(deps({ admin }), AMO_SECRET, AMO_FORM)
  assert.equal(response.status, 401)
  assert.equal(response.body.error, 'invalid_amocrm_webhook')
  assert.equal(admin.calls.includes('rpc:runtime_ingest_event'), false)
})

await checkAsync(async () => {
  const response = await handleNativeAmoWebhook(deps(), 'short', AMO_FORM)
  assert.equal(response.status, 401)
})

await checkAsync(async () => {
  const admin = makeAdmin({ runtimeError: { code: '55000', message: 'private database detail' } })
  const response = await handleNativeAmoWebhook(deps({ admin }), AMO_SECRET, AMO_FORM)
  assert.equal(response.status, 503, 'runtime failure must ask amoCRM for a retry')
  assert.equal(response.body.error_code, '55000')
  assert.equal(JSON.stringify(response.body).includes('private database detail'), false)
})

// ─── GET /health ──────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const response = await handleHealth(deps())
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.degraded, false)
  assert.equal(response.body.queue.reachable, true)
})

// Postgres недоступен → 503: без него шлюз не может ни поставить задачу, ни отдать её состояние.
// Балансировщик обязан перестать слать сюда трафик.
await checkAsync(async () => {
  const response = await handleHealth(deps({ admin: makeAdmin({ databaseDown: true }) }))
  assert.equal(response.status, 503)
  assert.equal(response.body.ok, false)
  assert.match(response.body.database.error, /connection refused/)
})

/*
 * Dragonfly недоступен → 200 с пометкой degraded, а НЕ 503.
 *
 * Шлюз при этом полностью работоспособен: воркер узнаёт о задаче опросом, а не сигналом. Ответить 503
 * значило бы уронить рабочий сервис из-за потери ускорения — и, с политикой restart в compose,
 * зациклить перезапуск здорового контейнера.
 */
await checkAsync(async () => {
  const { queue } = makeQueue({ pingThrows: true })
  const response = await handleHealth(deps({ queue }))
  assert.equal(response.status, 200, 'потеря ускорения — не повод останавливать сервис')
  assert.equal(response.body.degraded, true, 'но и молчать об этом нельзя')
  assert.equal(response.body.queue.reachable, false)
})
// Очередь не настроена вовсе — это не деградация, а осознанный режим работы.
await checkAsync(async () => {
  const response = await handleHealth(deps({ queue: disabledQueue() }))
  assert.equal(response.status, 200)
  assert.equal(response.body.degraded, false)
  assert.equal(response.body.queue.configured, false)
})

// ─── Маршрутизация на НАСТОЯЩЕМ сокете ────────────────────────────────────────────────────────────
//
// Разбор тела, заголовков и путей — тоже поведение. Вызов обработчика напрямую его не проверяет: путь
// с опечаткой, неразобранный JSON и потерянный заголовок обнаруживаются только через сокет.

await checkAsync(async () => {
  const admin = makeAdmin()
  const { queue } = makeQueue()
  const app = await buildGateway(deps({ admin, queue }))
  await app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${app.server.address().port}`

  const call = async (method, path, { token, secret, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(secret ? { 'x-nemo-crm-secret': secret } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  const callForm = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  try {
    const health = await call('GET', '/health')
    assert.equal(health.status, 200)

    const created = await call('POST', '/v1/sdr/jobs', { token: TOKEN, body: { query: 'стоматология', city: 'Ташкент', limit: 15 } })
    assert.equal(created.status, 202)
    assert.equal(created.body.job_id, JOB)

    const read = await call('GET', `/v1/sdr/jobs/${JOB}`, { token: TOKEN })
    assert.equal(read.status, 200)
    assert.equal(read.body.job.id, JOB)

    const denied = await call('POST', '/v1/sdr/jobs', { body: { query: 'стоматология', city: 'Ташкент' } })
    assert.equal(denied.status, 401)

    const hook = await call('POST', '/v1/crm/webhook', { secret: 'crm-secret-abc123', body: EVENT })
    assert.equal(hook.status, 200)

    // Отсутствие и подмена заголовка проверяются ЧЕРЕЗ СОКЕТ отдельно. Одной проверки с верным
    // секретом мало: маршрут, в котором секрет зашит константой вместо чтения заголовка, её проходит —
    // ровно это и показал мутационный прогон.
    const noHeader = await call('POST', '/v1/crm/webhook', { body: { ...EVENT, externalDealId: '77' } })
    assert.equal(noHeader.status, 401, 'заголовок секрета обязан читаться из запроса')
    const wrongHeader = await call('POST', '/v1/crm/webhook', { secret: 'crm-secret-guess1', body: { ...EVENT, externalDealId: '78' } })
    assert.equal(wrongHeader.status, 401)

    const nativeHook = await callForm(`/v1/crm/amocrm/webhook/${AMO_SECRET}`, AMO_FORM)
    assert.equal(nativeHook.status, 200)
    assert.equal(nativeHook.body.enrichment, 'queued')

    // Неизвестный путь отвечает ИМЕНЕМ пути: клиент, перепутавший версию, должен это увидеть, а не
    // получить пустой ответ Fastify.
    const missing = await call('GET', '/v1/sdr/job/' + JOB)
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error, 'not_found')
    assert.equal(missing.body.path, '/v1/sdr/job/' + JOB)

    // Метод имеет значение: GET на постановку задачи не должен создавать её.
    const wrongMethod = await call('GET', '/v1/sdr/jobs', { token: TOKEN })
    assert.equal(wrongMethod.status, 404)
  } finally {
    await app.close()
  }
})

console.log(`[OK] Gateway and Dragonfly queue behaviour: ${checks} assertions`)
