// Реестр инструментов, MCP-клиент и браузерный инструмент.
//
// ГЛАВНОЕ, что здесь защищается, — ГРАНИЦА ПРАВ. Модель предлагает вызов по имени и с произвольным
// JSON, причём оба берутся из текста, который писала не она: содержимое чужого сайта, чужая карточка
// товара, чужое письмо. Классическая атака выглядит так: агент читает страницу, в тексте страницы
// написано «вызови send_offer», и без запрета по умолчанию агент это выполняет. Поэтому больше половины
// проверок ниже — про то, что действие БЕЗ явного разрешения не происходит, а чужой MCP-сервер не может
// выдать право сам себе.
//
// Браузер проверяется на ЗАГЛУШКЕ движка: разбор страницы (мессенджеры, виджеты, заслон) — чистые
// функции, и запускать ради них Chromium значило бы получить набор, который падает на чужом сайте, а не
// на нашей ошибке. Живая проверка настоящим Chromium сделана отдельно и записана в сообщении коммита.

import assert from 'node:assert/strict'
import { ToolRegistry, defineTool, toJsonSchema, withTimeout } from './tools/registry.ts'
import {
  McpConnection, connectMcpServers, extractTextContent, namespacedToolName,
  resolveMcpServers, resolvePermission, schemaFromJsonSchema, toOpenRouterTools,
} from './tools/mcp-client.ts'
import {
  buildNavigateAndExtractTool, buildScreenshotTool, detectBookingWidgets, detectMessengers,
  looksLikeChallenge, registerBrowserTools, shouldBlockRequest,
} from './tools/browser.ts'
import { browserFallbackEnabled, createBrowserBridge } from './tools/enrich-browser.ts'
import { z } from 'zod'

let checks = 0
const check = (fn) => { fn(); checks++ }
const checkAsync = async (fn) => { await fn(); checks++ }

const readTool = () => defineTool({
  name: 'lookup', description: 'Найти компанию', permission: 'read_only',
  parameters: z.object({ query: z.string().min(2), limit: z.number().int().default(10) }),
  execute: async (args) => ({ q: args.query, limit: args.limit }),
})
const actionTool = () => defineTool({
  name: 'send_offer', description: 'Отправить оффер клиенту', permission: 'action',
  parameters: z.object({ phone: z.string() }),
  execute: async () => ({ sent: true }),
})

// --- Регистрация: имена уникальны, описание обязательно -------------------------------------------

check(() => {
  const reg = new ToolRegistry().register(readTool())
  assert.equal(reg.size(), 1)
  assert.equal(reg.has('lookup'), true)
  assert.equal(reg.has('нет-такого'), false)
})

// Повторное имя — ОШИБКА, а не молчаливая замена: иначе модель зовёт один инструмент, а срабатывает
// другой, и понять это по журналу невозможно.
check(() => {
  const reg = new ToolRegistry().register(readTool())
  assert.throws(() => reg.register(readTool()), /уже зарегистрирован/)
})

// Описание — единственное, по чему модель решает, когда звать инструмент. Пустое означает, что его не
// позовут вовсе или позовут не к месту.
check(() => assert.throws(
  () => new ToolRegistry().register({ ...readTool(), description: '   ' }),
  /нужно описание/,
))

// Имя должно проходить ограничение OpenRouter на function.name — иначе отказ придёт от чужого API уже
// в бою, а не здесь.
check(() => assert.throws(() => new ToolRegistry().register({ ...readTool(), name: 'плохое имя' }), /не подходит/))
check(() => assert.throws(() => new ToolRegistry().register({ ...readTool(), name: 'a'.repeat(65) }), /не подходит/))
check(() => { new ToolRegistry().register({ ...readTool(), name: 'mcp__db__read-rows_1' }) })

// --- ЗАПРЕТ ПО УМОЛЧАНИЮ --------------------------------------------------------------------------

await checkAsync(async () => {
  const reg = new ToolRegistry().register(readTool()).register(actionTool())
  // Чтение выполняется само.
  const read = await reg.call('lookup', { query: 'кофейни' })
  assert.equal(read.ok, true)
  // Действие без разрешения — отказ, и он НЕ зависит от правильности аргументов.
  const denied = await reg.call('send_offer', { phone: '+998901112233' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'permission_denied')
})

// Отказ по праву проверяется РАНЬШЕ разбора аргументов. Иначе текст ошибки подсказывает, как подобрать
// аргументы к запрещённому действию: «phone обязателен» означает, что имя действия угадано верно.
await checkAsync(async () => {
  const reg = new ToolRegistry().register(actionTool())
  const denied = await reg.call('send_offer', { совсем: 'не то' })
  assert.equal(denied.code, 'permission_denied', 'сначала право, потом аргументы')
})

// С явным разрешением — выполняется.
await checkAsync(async () => {
  const reg = new ToolRegistry().register(actionTool())
  const allowed = await reg.call('send_offer', { phone: '+998901112233' }, { allowedActions: ['send_offer'] })
  assert.equal(allowed.ok, true)
})

// Разрешение на ДРУГОЙ инструмент права не даёт: список точный, а не «хоть что-то разрешено».
await checkAsync(async () => {
  const reg = new ToolRegistry().register(actionTool())
  const denied = await reg.call('send_offer', { phone: '+998' }, { allowedActions: ['send_sms'] })
  assert.equal(denied.code, 'permission_denied')
})

// Модели показываются ТОЛЬКО доступные инструменты. Показать запрещённое — это круг: модель зовёт,
// получает отказ, зовёт снова и жжёт токены, не понимая причины.
check(() => {
  const reg = new ToolRegistry().register(readTool()).register(actionTool())
  assert.deepEqual(reg.describeForOpenRouter().map((t) => t.function.name), ['lookup'])
  assert.deepEqual(
    reg.describeForOpenRouter({ allowedActions: ['send_offer'] }).map((t) => t.function.name),
    ['lookup', 'send_offer'],
  )
})

// --- Ошибки возвращаются ЗНАЧЕНИЕМ, а не исключением ----------------------------------------------
// Инструменты ходят в сеть и в браузер, то есть падают регулярно и по чужим причинам. Исключение
// отсюда означало бы, что один недоступный сайт роняет прогон вместе с уже найденными лидами.

await checkAsync(async () => {
  const reg = new ToolRegistry().register(defineTool({
    name: 'boom', description: 'Всегда падает', permission: 'read_only',
    parameters: z.object({}), execute: async () => { throw new Error('сайт недоступен') },
  }))
  const outcome = await reg.call('boom', {})
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'execution_failed')
  assert.match(outcome.error, /сайт недоступен/)
})

await checkAsync(async () => {
  const reg = new ToolRegistry().register(readTool())
  const missing = await reg.call('нет-такого', {})
  assert.equal(missing.code, 'tool_not_found')
  // Список доступного в тексте отказа: модель, получившая «нет такого инструмента» без перечисления,
  // выдумает второе имя вместо того, чтобы выбрать из существующих.
  assert.match(missing.error, /lookup/)
})

// Причина негодных аргументов называется ПОЛЕМ. «Неверные аргументы» без указания поля модель
// исправляет наугад и присылает тот же вызов второй раз.
await checkAsync(async () => {
  const reg = new ToolRegistry().register(readTool())
  const bad = await reg.call('lookup', { query: 'x' })
  assert.equal(bad.code, 'invalid_arguments')
  assert.match(bad.error, /query/)
})

// Значения по умолчанию из схемы доезжают до обработчика: иначе default в Zod — украшение.
await checkAsync(async () => {
  const reg = new ToolRegistry().register(readTool())
  const outcome = await reg.call('lookup', { query: 'кофейни' })
  assert.equal(outcome.result.limit, 10)
})

// --- Таймаут и отмена -----------------------------------------------------------------------------

await checkAsync(async () => {
  const reg = new ToolRegistry().register(defineTool({
    name: 'slow', description: 'Долгий', permission: 'read_only', timeoutMs: 60,
    parameters: z.object({}), execute: async () => new Promise((resolve) => setTimeout(resolve, 5_000)),
  }))
  const outcome = await reg.call('slow', {})
  assert.equal(outcome.code, 'timeout')
  assert.match(outcome.error, /не ответил/)
})

/*
 * ИСТЁКШИЙ СРОК ОТМЕНЯЕТ САМУ РАБОТУ, А НЕ ТОЛЬКО ОЖИДАНИЕ.
 *
 * Раньше вызывающая сторона просто переставала ждать: обещание жило дальше, запрос шёл. Для быстрых
 * инструментов это мелочь. Для обращения к модели — нет: брошенный запрос с расшифровкой на сотню
 * тысяч знаков дойдёт до конца и будет оплачен целиком за ответ, который никто не прочтёт.
 */
await checkAsync(async () => {
  let aborted = false
  const reg = new ToolRegistry().register(defineTool({
    name: 'slow_network', description: 'Долгий сетевой', permission: 'read_only', timeoutMs: 60,
    parameters: z.object({}),
    execute: async (_args, context) => new Promise((resolve) => {
      context.signal?.addEventListener('abort', () => { aborted = true; resolve('прервано') }, { once: true })
      setTimeout(() => resolve('доработал'), 5_000)
    }),
  }))
  const outcome = await reg.call('slow_network', {})
  assert.equal(outcome.code, 'timeout')
  assert.equal(aborted, true, 'по истечении срока работа инструмента не отменена — запрос продолжает идти')
})

// Отмена снаружи доходит до инструмента: сеанс сняли — обращения обязаны прекратиться.
await checkAsync(async () => {
  const controller = new AbortController()
  let aborted = false
  const reg = new ToolRegistry().register(defineTool({
    name: 'watch_signal', description: 'Слушает сигнал', permission: 'read_only', timeoutMs: 5_000,
    parameters: z.object({}),
    execute: async (_args, context) => new Promise((resolve) => {
      context.signal?.addEventListener('abort', () => { aborted = true; resolve('прервано') }, { once: true })
      setTimeout(() => controller.abort(), 20)
    }),
  }))
  await reg.call('watch_signal', {}, { signal: controller.signal })
  assert.equal(aborted, true, 'внешняя отмена не дошла до инструмента')
})

// Таймер снимается и на УСПЕШНОМ пути. Иначе висящий setTimeout держит процесс живым, и CLI,
// закончивший работу, не выходит — человек видит зависший терминал вместо приглашения.
await checkAsync(async () => {
  const before = process.getActiveResourcesInfo().filter((one) => one === 'Timeout').length
  await withTimeout(Promise.resolve('готово'), 30_000, 'проверка')
  const after = process.getActiveResourcesInfo().filter((one) => one === 'Timeout').length
  assert.ok(after <= before, `таймер не снят: было ${before}, стало ${after}`)
})

await checkAsync(async () => {
  const controller = new AbortController()
  controller.abort()
  const reg = new ToolRegistry().register(readTool())
  const outcome = await reg.call('lookup', { query: 'кофейни' }, { signal: controller.signal })
  assert.equal(outcome.code, 'aborted', 'отменённый вызов не должен начинаться')
})

// --- Схема для модели -----------------------------------------------------------------------------

check(() => {
  const schema = toJsonSchema(z.object({
    query: z.string().describe('Что искать'),
    limit: z.number().int().default(10),
    mode: z.enum(['fast', 'deep']),
    tags: z.array(z.string()),
    deep: z.boolean().optional(),
  }))
  assert.equal(schema.type, 'object')
  assert.equal(schema.properties.query.description, 'Что искать')
  assert.equal(schema.properties.mode.type, 'string')
  assert.deepEqual(schema.properties.mode.enum, ['fast', 'deep'])
  assert.equal(schema.properties.tags.items.type, 'string')
  // Обязательны только те, у кого нет ни default, ни optional: поле с default модель может не
  // присылать, и требовать его — значит получать отказы на законных вызовах.
  assert.deepEqual(schema.required, ['query', 'mode', 'tags'])
})

// required с пустым массивом некоторые модели читают как «обязательных нет вообще» и начинают
// присылать пустой объект. Поля проще не писать.
check(() => assert.equal('required' in toJsonSchema(z.object({})), false))

// --- MCP: чужой сервер не выдаёт права сам себе ---------------------------------------------------

// Не помеченный инструмент = ДЕЙСТВИЕ. Молчание сервера — не признак безопасности.
check(() => assert.equal(resolvePermission({ name: 'write_row' }, { allowedActions: [] }), 'action'))
// Помеченный читающим — чтение.
check(() => assert.equal(
  resolvePermission({ name: 'read_rows', annotations: { readOnlyHint: true } }, { allowedActions: [] }),
  'read_only',
))
// РАЗРУШИТЕЛЬНЫЙ пересиливает собственное «только чтение» сервера. Именно так выглядит враждебный или
// просто небрежный сервер: `drop_table` с пометкой readOnlyHint.
check(() => assert.equal(
  resolvePermission(
    { name: 'drop_table', annotations: { readOnlyHint: true, destructiveHint: true } },
    { allowedActions: [] },
  ),
  'action',
))
// Наш список важнее подсказки в обе стороны.
check(() => assert.equal(
  resolvePermission({ name: 'write_row', annotations: { readOnlyHint: true } }, { allowedActions: ['write_row'] }),
  'action',
))

// Имена приводятся к нашему пространству: иначе сервер назовётся browser_screenshot и столкнётся с
// нашим инструментом, сломав весь набор.
check(() => assert.equal(namespacedToolName('testdb', 'read_rows'), 'mcp__testdb__read_rows'))
// Знаки, недопустимые в function.name, заменяются, а не отбрасываются: иначе два разных инструмента
// («тест!» и «тест?») дали бы одно имя, и второй затёр бы первый.
check(() => assert.equal(namespacedToolName('db', 'read rows!'), 'mcp__db__read_rows_'))
check(() => assert.notEqual(namespacedToolName('db', 'тест!'), namespacedToolName('db', 'тест')))
check(() => assert.ok(namespacedToolName('db', 'x'.repeat(200)).length <= 64, 'предел OpenRouter на имя — 64 знака'))
check(() => assert.ok(namespacedToolName('db', 'x'.repeat(200)).startsWith('mcp__db__'), 'признак сервера сохраняется при обрезке'))

// Форма аргументов проверяется, содержимое — нет: правила чужой схемы знает только сам сервер.
check(() => {
  const schema = schemaFromJsonSchema({ type: 'object', required: ['table'], properties: { table: { type: 'string' } } })
  assert.equal(schema.safeParse({ table: 'leads' }).success, true)
  assert.equal(schema.safeParse({}).success, false, 'обязательное поле должно присутствовать')
  // passthrough: чужие поля доезжают до сервера нетронутыми, иначе мы молча урежем вызов.
  assert.deepEqual(schema.parse({ table: 'x', limit: 5 }), { table: 'x', limit: 5 })
})
// Схема БЕЗ обязательных полей — отдельная ветка кода, и в ней passthrough так же обязателен: сервер
// без required тоже получает аргументы, и вырезать их значит вызвать его пустым.
check(() => {
  const loose = schemaFromJsonSchema({ type: 'object', properties: { limit: { type: 'number' } } })
  assert.equal(loose.safeParse({ что: 'угодно' }).success, true)
  assert.deepEqual(loose.parse({ limit: 5, table: 'leads' }), { limit: 5, table: 'leads' })
})
check(() => assert.deepEqual(schemaFromJsonSchema(undefined).parse({ x: 1 }), { x: 1 }))

// Ответ MCP приходит блоками. Модели нужен текст; картинки упоминаются, но не разворачиваются —
// base64 съест контекст, а смотреть на него некому.
check(() => assert.equal(extractTextContent({ content: [{ type: 'text', text: 'строк: 3' }] }), 'строк: 3'))
check(() => assert.match(extractTextContent({ content: [{ type: 'image', mimeType: 'image/png' }] }), /изображение/))
check(() => assert.match(extractTextContent({ content: [{ type: 'resource', resource: { uri: 'file:///x' } }] }), /file:\/\/\/x/))
check(() => assert.equal(extractTextContent({ content: [{ type: 'text', text: 'а' }, { type: 'text', text: 'б' }] }), 'а\nб'))

check(() => {
  const tools = toOpenRouterTools('testdb', [{ name: 'read_rows', inputSchema: { type: 'object' } }])
  assert.equal(tools[0].function.name, 'mcp__testdb__read_rows')
  // Сервер без описания не должен давать модели пустую строку: по ней невозможно решить, когда звать.
  assert.match(tools[0].function.description, /read_rows/)
})

// --- MCP: подключение с подменным транспортом -----------------------------------------------------

const fakeSession = (tools, onCall) => ({
  listTools: async () => ({ tools }),
  callTool: async (params) => onCall(params),
  close: async () => {},
})

await checkAsync(async () => {
  const reg = new ToolRegistry()
  const hub = await connectMcpServers(reg, [{ name: 'db', command: 'x', args: [], env: {}, allowedActions: [], enabled: true }],
    async () => fakeSession(
      [{ name: 'read_rows', description: 'Прочитать', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', required: ['table'] } }],
      () => ({ content: [{ type: 'text', text: 'строк: 3' }] }),
    ))
  assert.deepEqual(hub.registered, ['mcp__db__read_rows'])
  const outcome = await reg.call('mcp__db__read_rows', { table: 'leads' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result, 'строк: 3')
  await hub.close()
})

// isError по протоколу — сообщение об ошибке в УСПЕШНОМ ответе. Пропустить его значит выдать модели
// текст ошибки как результат работы, и она построит на нём следующий шаг.
await checkAsync(async () => {
  const reg = new ToolRegistry()
  const hub = await connectMcpServers(reg, [{ name: 'db', command: 'x', args: [], env: {}, allowedActions: [], enabled: true }],
    async () => fakeSession(
      [{ name: 'read_rows', annotations: { readOnlyHint: true } }],
      () => ({ isError: true, content: [{ type: 'text', text: 'таблица не найдена' }] }),
    ))
  const outcome = await reg.call('mcp__db__read_rows', {})
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /таблица не найдена/)
  await hub.close()
})

// Отказ ОДНОГО сервера не отменяет остальные: «postgres-mcp не установлен» не повод лишить агента
// файловых инструментов.
await checkAsync(async () => {
  const reg = new ToolRegistry()
  const hub = await connectMcpServers(reg, [
    { name: 'broken', command: 'x', args: [], env: {}, allowedActions: [], enabled: true },
    { name: 'works', command: 'y', args: [], env: {}, allowedActions: [], enabled: true },
  ], async (config) => {
    if (config.name === 'broken') throw new Error('нет такого файла')
    return fakeSession([{ name: 'ok_tool', annotations: { readOnlyHint: true } }], () => ({ content: [] }))
  })
  assert.equal(hub.failures.length, 1)
  assert.match(hub.failures[0].error, /нет такого файла/)
  assert.deepEqual(hub.registered, ['mcp__works__ok_tool'])
  await hub.close()
})

// Настройки серверов: негодный JSON называется ВСЛУХ. Молча пропущенная опечатка означает агента без
// половины инструментов, а узнают об этом по непонятно плохому результату через неделю.
check(() => assert.deepEqual(resolveMcpServers({}), { servers: [] }))
check(() => assert.match(resolveMcpServers({ NEMO_MCP_SERVERS: '{не json' }).error, /не разбирается как JSON/))
check(() => assert.match(resolveMcpServers({ NEMO_MCP_SERVERS: '[{"name":"ПЛОХО"}]' }).error, /описан неверно/))
check(() => {
  const ok = resolveMcpServers({ NEMO_MCP_SERVERS: '[{"name":"db","command":"node","args":["s.mjs"]}]' })
  assert.equal(ok.servers.length, 1)
  assert.deepEqual(ok.servers[0].env, {}, 'окружение по умолчанию ПУСТОЕ — секреты проекта чужому процессу не нужны')
  assert.deepEqual(ok.servers[0].allowedActions, [], 'права по умолчанию — никаких')
})
check(() => assert.equal(resolveMcpServers({ NEMO_MCP_SERVERS: '[{"name":"db","command":"n","enabled":false}]' }).servers.length, 0))

// Сервер не подключён — вызов инструмента обязан сказать это прямо, а не упасть на undefined.
await checkAsync(async () => {
  const connection = new McpConnection({ name: 'db', command: 'x' }, async () => fakeSession([], () => ({})))
  await assert.rejects(() => connection.callTool('x', {}), /не подключён/)
})

// --- Браузер: разбор страницы ---------------------------------------------------------------------

check(() => {
  const found = detectMessengers([
    'https://wa.me/998901112233',
    'https://t.me/dentalux',
    'https://instagram.com/denta_uz',
    'https://example.com/about',
  ])
  assert.deepEqual(found.map((one) => one.kind), ['whatsapp', 'telegram', 'instagram'])
})

// Приглашение в закрытый чат — НЕ канал связи с компанией: туда можно только войти, а написать нельзя.
check(() => assert.deepEqual(detectMessengers(['https://t.me/joinchat/AAAA']), []))
check(() => assert.deepEqual(detectMessengers(['https://t.me/+AbCdEf']), []))
check(() => assert.deepEqual(detectMessengers(['https://t.me/realaccount']).map((o) => o.kind), ['telegram']))
// Дубли не размножаются: одна и та же ссылка в шапке и в подвале — один канал.
check(() => assert.equal(detectMessengers(['https://wa.me/1', 'https://wa.me/1']).length, 1))

// Виджеты опознаются по адресам ПОДКЛЮЧЁННЫХ скриптов, а не по видимому тексту.
check(() => assert.deepEqual(detectBookingWidgets(['https://n1.yclients.com/widgetJS']), ['yclients']))
check(() => assert.deepEqual(detectBookingWidgets(['https://code.jivosite.com/widget/abc']), ['jivosite']))
check(() => assert.deepEqual(detectBookingWidgets([], '<script src="https://calendly.com/x"></script>'), ['calendly']))
check(() => assert.deepEqual(detectBookingWidgets(['https://example.com/app.js']), []))

// Заслон возвращается ПРИЗНАКОМ. Принять «Checking your browser» за описание компании значит отправить
// в модель мусор и получить уверенную оценку несуществующего бизнеса.
check(() => assert.equal(looksLikeChallenge('Just a moment...', 'Enable JavaScript and cookies to continue'), true))
check(() => assert.equal(looksLikeChallenge('Attention Required! | Cloudflare', ''), true))
check(() => assert.equal(looksLikeChallenge('Проверка браузера', ''), true))
check(() => assert.equal(looksLikeChallenge('Стоматология Дента', 'Записаться на приём'), false))

// Тяжёлые ресурсы не грузятся: это и есть бюджет 2.5 секунды на страницу.
check(() => assert.equal(shouldBlockRequest('image', 'https://x.uz/logo.png'), true))
check(() => assert.equal(shouldBlockRequest('font', 'https://x.uz/a.woff2'), true))
check(() => assert.equal(shouldBlockRequest('media', 'https://x.uz/v.mp4'), true))
check(() => assert.equal(shouldBlockRequest('document', 'https://x.uz/'), false))
// Счётчики держат открытые соединения по таймеру — из-за них networkidle не наступает никогда.
check(() => assert.equal(shouldBlockRequest('script', 'https://www.googletagmanager.com/gtm.js'), true))
check(() => assert.equal(shouldBlockRequest('script', 'https://mc.yandex.ru/metrika/tag.js'), true))
// А вот скрипт виджета записи блокируется как аналитика? Нет: он нужен для опознания виджета.
check(() => assert.equal(shouldBlockRequest('script', 'https://n1.yclients.com/widgetJS'), false))

// --- Браузерный инструмент на заглушке движка -----------------------------------------------------

const stubEngine = (harvest) => ({
  calls: [],
  closed: false,
  async harvest(url) { this.calls.push(url); return { url, finalUrl: url, title: '', text: '', links: [], requestedUrls: [], html: '', status: 200, ...harvest } },
  async screenshot() { return new Uint8Array([137, 80, 78, 71]) },
  async close() { this.closed = true },
})

await checkAsync(async () => {
  const engine = stubEngine({
    title: 'Дента', text: 'Записаться',
    links: ['https://wa.me/998901112233', 'https://t.me/denta'],
    requestedUrls: ['https://n1.yclients.com/widgetJS'],
  })
  const reg = new ToolRegistry().register(buildNavigateAndExtractTool(engine))
  const outcome = await reg.call('browser_navigate_and_extract', { url: 'https://denta.uz' })
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result.messengers.map((o) => o.kind), ['whatsapp', 'telegram'])
  assert.deepEqual(outcome.result.bookingWidgets, ['yclients'])
  assert.equal(outcome.result.blocked, false)
})

// Браузерные инструменты — ТОЛЬКО ЧТЕНИЕ, и это принципиально: они выполняются автоматически, без
// подтверждения. Инструмент, который что-то меняет, не имеет права на такой режим.
check(() => {
  const reg = new ToolRegistry()
  registerBrowserTools(reg, stubEngine({}))
  assert.equal(reg.get('browser_navigate_and_extract').permission, 'read_only')
  assert.equal(reg.get('browser_screenshot').permission, 'read_only')
})

// Адрес обязан быть полным: относительный путь браузер откроет как файл на диске.
await checkAsync(async () => {
  const reg = new ToolRegistry().register(buildNavigateAndExtractTool(stubEngine({})))
  const bad = await reg.call('browser_navigate_and_extract', { url: '/about' })
  assert.equal(bad.code, 'invalid_arguments')
})

// Текст режется по умолчанию: страница на 200 КБ в поручении модели стоит дороже, чем приносит.
await checkAsync(async () => {
  const engine = stubEngine({ text: 'я'.repeat(50_000) })
  const reg = new ToolRegistry().register(buildNavigateAndExtractTool(engine))
  const short = await reg.call('browser_navigate_and_extract', { url: 'https://x.uz' })
  assert.equal(short.result.text.length, 8_000)
  assert.equal(short.result.textLength, 50_000, 'полная длина сообщается честно')
  const full = await reg.call('browser_navigate_and_extract', { url: 'https://x.uz', fullText: true })
  assert.equal(full.result.text.length, 50_000)
})

await checkAsync(async () => {
  const reg = new ToolRegistry().register(buildScreenshotTool(stubEngine({})))
  const outcome = await reg.call('browser_screenshot', { url: 'https://x.uz' })
  assert.equal(outcome.result.format, 'png')
  // base64, а не путь к файлу: инструмент может выполняться в контейнере, чья файловая система
  // исчезнет вместе с ним, и «сохранил в /tmp/shot.png» — обещание без покрытия.
  assert.equal(outcome.result.base64, Buffer.from([137, 80, 78, 71]).toString('base64'))
})

// --- Мост браузера в обогащение -------------------------------------------------------------------

// ВЫКЛЮЧЕН по умолчанию: браузер стоит секунды и полтораста мегабайт на страницу, и включать его за
// владельца нельзя.
check(() => assert.equal(browserFallbackEnabled({}), false))
check(() => assert.equal(browserFallbackEnabled({ SDR_BROWSER: '1' }), true))
check(() => assert.equal(browserFallbackEnabled({ SDR_BROWSER: 'on' }), true))
// Выключить должно быть проще, чем включить.
check(() => assert.equal(browserFallbackEnabled({ SDR_BROWSER: '0' }), false))
check(() => assert.equal(browserFallbackEnabled({ SDR_BROWSER: 'false' }), false))
check(() => assert.equal(browserFallbackEnabled({ SDR_BROWSER: 'что-то' }), false))

// Выключенный мост даёт fallback === null: вызывающий код при этом не меняется — он всегда передаёт
// bridge.fallback и всегда вызывает close().
await checkAsync(async () => {
  const off = createBrowserBridge({ enabled: false })
  assert.equal(off.fallback, null)
  await off.close()
})

await checkAsync(async () => {
  const engine = stubEngine({ links: ['https://wa.me/1'], requestedUrls: ['https://dikidi.net/w'] })
  const bridge = createBrowserBridge({ enabled: true, engine })
  const result = await bridge.fallback('https://x.uz')
  assert.deepEqual(result.messengers.map((o) => o.kind), ['whatsapp'])
  assert.deepEqual(result.bookingWidgets, ['dikidi'])
  assert.deepEqual(bridge.stats(), { calls: 1, blocked: 0, failures: 0 })
  await bridge.close()
  assert.equal(engine.closed, true, 'close() моста обязан закрыть движок — иначе Chromium останется зомби')
})

// Заслон считается ОТДЕЛЬНО от отказа: «сайт закрыт от роботов» и «браузер не смог» — разные причины,
// и лечатся они по-разному.
await checkAsync(async () => {
  const bridge = createBrowserBridge({ enabled: true, engine: stubEngine({ title: 'Just a moment...' }) })
  const result = await bridge.fallback('https://x.uz')
  assert.equal(result.blocked, true)
  assert.equal(bridge.stats().blocked, 1)
  await bridge.close()
})

// Отказ движка приходит ИСКЛЮЧЕНИЕМ, а не null: обогащение различает «браузера нет» и «браузер есть,
// но страница не открылась», и записывает это по-разному.
await checkAsync(async () => {
  const engine = { harvest: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') }, screenshot: async () => new Uint8Array(), close: async () => {} }
  const bridge = createBrowserBridge({ enabled: true, engine })
  await assert.rejects(() => bridge.fallback('https://нет-такого.uz'), /ERR_NAME_NOT_RESOLVED/)
  assert.equal(bridge.stats().failures, 1)
  await bridge.close()
})

console.log(`[OK] Tool registry, MCP and browser behaviour: ${checks} assertions`)
