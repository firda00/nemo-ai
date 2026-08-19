// Слеш-команды: разбор, автодополнение, роли, смена модели, хирургия над историей.
//
// ГЛАВНОЕ, ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ — ИНВАРИАНТ ПРОТОКОЛА.
//
// В истории реплика модели с вызовами инструментов и результаты этих вызовов образуют НЕРАЗРЫВНУЮ
// группу: каждому tool_call_id обязан соответствовать ответ, и наоборот. Любая операция, режущая
// историю посередине — /undo, /compact, /clear — способна оставить результат инструмента без
// заказавшей его реплики. Провайдер отвергает такой запрос ЦЕЛИКОМ, и человек видит не «команда
// сломала историю», а «модель не отвечает» на следующем же вопросе — через минуту после команды, без
// видимой связи с ней.
//
// Поэтому здесь после каждой операции проверяется не только результат, но и целостность всей истории.

import assert from 'node:assert/strict'
import {
  AGENT_ROLES, COMMANDS, COMPACT_INSTRUCTION, DEFAULT_ROLE, LOCAL_MODEL_BASE, MODEL_ALIASES,
  canonicalName, completeSlash, parseSlash, renderTranscript, resolveModel, runSlash,
} from './cli/commands.ts'
import { AgentSession, DEFAULT_AGENT_MODEL, createOpenRouterStream, setSessionRegistry } from './agent-runtime.ts'
import { ToolRegistry, defineTool, restrictRegistry } from './tools/registry.ts'
import { collectHealth, fetchBalance, probeBinary, toolBadges } from './cli/wiring.ts'
import { z } from 'zod'

let checks = 0
const check = (fn) => { fn(); checks++ }
const checkAsync = async (fn) => { await fn(); checks++ }

/**
 * Проверка целостности истории по правилам протокола.
 *
 * Возвращает список нарушений. Пустой список — историю можно отправлять.
 */
function historyFaults(messages) {
  const faults = []
  const systems = messages.filter((one) => one.role === 'system')
  if (systems.length > 1) faults.push(`системных реплик ${systems.length}, должна быть одна`)
  if (messages.length && messages[0].role !== 'system') faults.push('первая реплика не системная')

  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      // За репликой с вызовами обязаны идти ответы — по одному на каждый вызов, сразу же.
      const answers = messages.slice(index + 1, index + 1 + message.tool_calls.length)
      const ids = new Set(answers.filter((one) => one.role === 'tool').map((one) => one.tool_call_id))
      for (const call of message.tool_calls) {
        if (!ids.has(call.id)) faults.push(`вызов ${call.id} (${call.function.name}) остался без ответа`)
      }
    }
    if (message.role === 'tool') {
      // У ответа обязан быть заказавший его вызов где-то выше.
      const ordered = messages.slice(0, index).some(
        (one) => one.role === 'assistant' && one.tool_calls?.some((call) => call.id === message.tool_call_id),
      )
      if (!ordered) faults.push(`ответ ${message.tool_call_id} висит без вызова`)
    }
  }
  return faults
}

// Проверка самой проверки: она должна ловить оба нарушения, иначе всё ниже бессмысленно.
check(() => assert.deepEqual(historyFaults([{ role: 'system', content: 's' }]), []))
check(() => assert.ok(historyFaults([
  { role: 'system', content: 's' },
  { role: 'tool', tool_call_id: 'x', name: 't', content: '{}' },
])[0].includes('висит без вызова')))
check(() => assert.ok(historyFaults([
  { role: 'system', content: 's' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 't', arguments: '{}' } }] },
])[0].includes('без ответа')))

// ─── Разбор ───────────────────────────────────────────────────────────────────────────────────────

check(() => assert.deepEqual(parseSlash('/help'), { name: 'help', args: [], rest: '' }))
check(() => assert.deepEqual(parseSlash('/agent sdr'), { name: 'agent', args: ['sdr'], rest: 'sdr' }))
check(() => assert.equal(parseSlash('/AGENT SDR').name, 'agent', 'имя команды нечувствительно к регистру'))
// Аргумент команды регистр СОХРАНЯЕТ: в /model может прийти идентификатор с заглавными, а в /browse — URL.
check(() => assert.equal(parseSlash('/browse https://Example.COM/Path').rest, 'https://Example.COM/Path'))
check(() => assert.equal(parseSlash('найди клиники'), null))
check(() => assert.equal(parseSlash(''), null))
check(() => assert.equal(parseSlash('/'), null))
// «/ 5 клиник» — опечатка в запросе, а не команда с пустым именем.
check(() => assert.equal(parseSlash('/ 5 клиник'), null))
check(() => assert.equal(parseSlash('  /help  ').name, 'help', 'пробелы вокруг команды не мешают'))
check(() => assert.deepEqual(parseSlash('/export json').args, ['json']))
check(() => assert.equal(parseSlash('/model  openai/o3-mini').rest, 'openai/o3-mini', 'лишние пробелы не попадают в аргумент'))

check(() => assert.equal(canonicalName('quit'), 'exit'))
check(() => assert.equal(canonicalName('q'), 'exit'))
check(() => assert.equal(canonicalName('help'), 'help'))

// ─── Автодополнение ───────────────────────────────────────────────────────────────────────────────

// Tab на пустой команде показывает ВСЁ: человек, нажавший Tab, спрашивает «что тут есть», и молчание
// в ответ — худший из возможных ответов.
check(() => assert.equal(completeSlash('/').matches.length, COMMANDS.length))
check(() => assert.deepEqual(completeSlash('/ag').matches, ['/agent']))
check(() => assert.deepEqual(completeSlash('/e').matches.sort(), ['/exit', '/export']))
check(() => assert.deepEqual(completeSlash('/нетакой').matches, []))
// Обычная фраза автодополнением не трогается: подсказка команд посреди запроса сбивает с толку.
check(() => assert.deepEqual(completeSlash('найди клиники').matches, []))

// ─── Модели ───────────────────────────────────────────────────────────────────────────────────────

check(() => assert.deepEqual(resolveModel('claude'), { id: DEFAULT_AGENT_MODEL, local: false }))
check(() => assert.deepEqual(resolveModel('GPT4O'), { id: 'openai/gpt-4o', local: false }))
check(() => assert.deepEqual(resolveModel('gpt-4o'), { id: 'openai/gpt-4o', local: false }, 'дефис в алиасе не должен мешать'))
// Полный идентификатор проходит насквозь: каталог OpenRouter меняется быстрее списка алиасов, и
// запрещать неизвестное имя значит чинить этот список каждую неделю.
check(() => assert.deepEqual(resolveModel('openai/o3-mini'), { id: 'openai/o3-mini', local: false }))
check(() => assert.equal(resolveModel('local').local, true))
check(() => assert.ok(MODEL_ALIASES.claude && MODEL_ALIASES.gpt4o && MODEL_ALIASES.deepseek && MODEL_ALIASES.qwen))

/*
 * КЛЮЧ OPENROUTER НЕ УХОДИТ НА ЧУЖОЙ АДРЕС.
 *
 * `/model local` — это запрос на localhost. У локальной Ollama нет проверки подлинности, и отправка
 * туда ключа от платного счёта раздала бы его любому процессу, успевшему занять порт 11434.
 */
await checkAsync(async () => {
  const seen = []
  const stream = createOpenRouterStream({
    apiKey: 'секретный-ключ',
    baseUrl: LOCAL_MODEL_BASE,
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers })
      return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }
    },
  })
  for await (const _ of stream([], [], new AbortController().signal)) { /* до конца потока */ }
  assert.ok(seen[0].url.startsWith(LOCAL_MODEL_BASE), `ушли не туда: ${seen[0].url}`)
  assert.equal(seen[0].headers.Authorization, undefined, 'ключ OpenRouter ушёл на локальный адрес')
  assert.ok(!JSON.stringify(seen[0].headers).includes('секретный-ключ'))
})

// А в сам OpenRouter ключ уходить обязан, иначе запрос отвергнут.
await checkAsync(async () => {
  const seen = []
  const stream = createOpenRouterStream({
    apiKey: 'секретный-ключ',
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers })
      return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }
    },
  })
  for await (const _ of stream([], [], new AbortController().signal)) { /* до конца потока */ }
  assert.ok(seen[0].url.startsWith('https://openrouter.ai/'))
  assert.equal(seen[0].headers.Authorization, 'Bearer секретный-ключ')
})

// ─── Роли ─────────────────────────────────────────────────────────────────────────────────────────

check(() => assert.ok(AGENT_ROLES[DEFAULT_ROLE], 'роль по умолчанию должна существовать'))
check(() => assert.equal(AGENT_ROLES.general.tools, null, 'универсальная роль видит все инструменты'))
check(() => assert.equal(AGENT_ROLES.general.mission, '', 'у универсальной роли нет своей специализации'))

/*
 * У ПРОВЕРЯЮЩЕЙ РОЛИ НЕТ ДОСТУПА К БОЕВЫМ ДАННЫМ.
 *
 * Роль `qa` открывает страницы и сверяет обещанное с фактическим. Возможность отправить карточку
 * клиенту или записать в CRM ей не нужна — а случайный вызов во время проверки задел бы живых людей.
 */
check(() => {
  for (const forbidden of ['telegram_send_lead', 'crm_sync_lead']) {
    assert.ok(!AGENT_ROLES.qa.tools.includes(forbidden), `роль qa может ${forbidden}`)
    assert.ok(!AGENT_ROLES.media.tools.includes(forbidden), `роль media может ${forbidden}`)
  }
})
check(() => assert.ok(AGENT_ROLES.sdr.tools.includes('telegram_send_lead'), 'роль sdr обязана уметь отправлять лид'))
check(() => {
  for (const [name, role] of Object.entries(AGENT_ROLES)) {
    assert.equal(role.name, name, `роль ${name} названа внутри иначе`)
    assert.ok(role.title.length > 0, `у роли ${name} нет подписи`)
  }
})

function makeRegistry() {
  const registry = new ToolRegistry()
  for (const [name, permission] of [
    ['search_leads', 'read_only'], ['telegram_send_lead', 'action'],
    ['crm_sync_lead', 'action'], ['fs_export', 'read_only'], ['render_video_pitch', 'read_only'],
  ]) {
    registry.register(defineTool({
      name, description: `инструмент ${name}`, permission,
      parameters: z.object({}), execute: async () => ({ ok: true }),
    }))
  }
  return registry
}

check(() => {
  const full = makeRegistry()
  const qa = restrictRegistry(full, AGENT_ROLES.qa.tools)
  assert.ok(!qa.has('telegram_send_lead'), 'сужение не отобрало отправку у роли qa')
  assert.ok(qa.has('search_leads'))
  // Исходный реестр НЕ изменён: иначе возврат к роли general терял бы инструменты навсегда.
  assert.ok(full.has('telegram_send_lead'), 'сужение испортило исходный реестр')
})
check(() => assert.equal(restrictRegistry(makeRegistry(), null).size(), 5, 'роль без списка не сужает'))
// Роль умеет только сужать: имя ненастроенного инструмента пропускается, а не роняет запуск — иначе
// роль media была бы недоступна на машине без ffmpeg.
check(() => {
  const narrowed = restrictRegistry(makeRegistry(), ['search_leads', 'нет_такого_инструмента'])
  assert.deepEqual(narrowed.names(), ['search_leads'])
})

// ─── Заготовка сессии с настоящей группой «вызовы → результаты» ────────────────────────────────────

function seededSession() {
  const session = new AgentSession('системный промпт', {
    registry: makeRegistry(),
    stream: async function* () { yield { kind: 'text', delta: 'ответ' } },
  })
  session.messages.push(
    { role: 'user', content: 'найди клиники' },
    {
      role: 'assistant', content: 'Сейчас поищу.',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'search_leads', arguments: '{"query":"клиники"}' } },
        { id: 'c2', type: 'function', function: { name: 'search_leads', arguments: '{"query":"стоматология"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'search_leads', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: 'c2', name: 'search_leads', content: '{"ok":true}' },
    { role: 'assistant', content: 'Нашёл 12 клиник.' },
    { role: 'user', content: 'а теперь кофейни' },
    { role: 'assistant', content: 'Нашёл 4 кофейни.' },
    { role: 'user', content: 'сохрани в csv' },
    { role: 'assistant', content: 'Сохранил.' },
  )
  return session
}

check(() => assert.deepEqual(historyFaults(seededSession().messages), [], 'заготовка изначально негодна'))

function deps(session, overrides = {}) {
  let role = AGENT_ROLES[DEFAULT_ROLE]
  let model = DEFAULT_AGENT_MODEL
  return {
    session,
    registry: makeRegistry(),
    setRole: (next) => { role = next; session.setSystemPrompt(next.mission || 'универсальный промпт') },
    currentRole: () => role,
    setModel: (resolved) => { model = resolved.id; return null },
    currentModel: () => model,
    mcpStatus: () => [],
    health: async () => [{ name: 'Supabase', ok: true, detail: 'настроен' }],
    balance: async () => ({ ok: true, text: 'остаток $4.20' }),
    summarize: async () => 'Искали клиники и кофейни, нашли 12 и 4.',
    writeExport: async (name) => `/tmp/${name}`,
    ...overrides,
  }
}

const run = (session, line, overrides) => runSlash(parseSlash(line), deps(session, overrides))

// ─── /undo ────────────────────────────────────────────────────────────────────────────────────────

/*
 * Ход — это НЕ пара сообщений.
 *
 * Между вопросом человека и ответом лежат реплика модели с вызовами и результаты этих вызовов. Снять
 * «две последние реплики» значит оставить в истории результат инструмента без заказавшей его реплики.
 */
await checkAsync(async () => {
  const session = seededSession()
  const result = await run(session, '/undo')
  assert.ok(result.lines[0].includes('отменён'))
  assert.equal(session.messages.at(-1).content, 'Нашёл 4 кофейни.')
  assert.ok(!session.messages.some((one) => one.content === 'сохрани в csv'), 'ход снят не целиком')
  assert.deepEqual(historyFaults(session.messages), [])
})

// Третий /undo снимает ход с вызовами инструментов ЦЕЛИКОМ — вместе с обоими результатами.
await checkAsync(async () => {
  const session = seededSession()
  await run(session, '/undo')
  await run(session, '/undo')
  assert.deepEqual(session.messages.map((one) => one.role), ['system', 'user', 'assistant', 'tool', 'tool', 'assistant'])
  await run(session, '/undo')
  assert.deepEqual(session.messages.map((one) => one.role), ['system'], 'группа «вызовы → результаты» пережила отмену хода')
  assert.deepEqual(historyFaults(session.messages), [])
})

await checkAsync(async () => {
  const session = new AgentSession('промпт', { registry: makeRegistry(), stream: async function* () {} })
  const result = await run(session, '/undo')
  assert.ok(result.lines[0].includes('нечего'), 'на пустой истории /undo должен сказать, что отменять нечего')
  assert.equal(session.messages.length, 1, 'системный промпт снесён')
})

// ─── /clear ───────────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const session = seededSession()
  session.setSystemPrompt('промпт роли sdr')
  await run(session, '/clear')
  assert.deepEqual(session.messages.map((one) => one.role), ['system'])
  // Роль — это настройка, а не часть беседы: /clear забывает разговор, но не возвращает роль к общей.
  assert.equal(session.messages[0].content, 'промпт роли sdr', '/clear сбросил роль вместе с историей')
})

// ─── /compact ─────────────────────────────────────────────────────────────────────────────────────

/*
 * ГРАНИЦА СРЕЗА СОВПАДАЕТ С РЕПЛИКОЙ ЧЕЛОВЕКА.
 *
 * «Оставить последние N сообщений» разрезало бы группу «вызовы → результаты» пополам. Здесь граница
 * ищется по ходам, и целостность проверяется после сжатия.
 */
await checkAsync(async () => {
  const session = seededSession()
  const before = session.messages.length
  const result = await run(session, '/compact')
  assert.ok(result.lines[0].includes('сжато'), result.lines[0])
  assert.ok(session.messages.length < before, 'история не уменьшилась')
  assert.deepEqual(historyFaults(session.messages), [])
  assert.equal(session.messages[0].role, 'system', 'системный промпт потерян при сжатии')
  assert.ok(
    session.messages.some((one) => String(one.content ?? '').includes('12 и 4')),
    'пересказ не попал в историю',
  )
  // Последний ход остался ДОСЛОВНО: сжимать то, о чём говорили секунду назад, — терять точность там,
  // где она нужнее всего.
  assert.ok(session.messages.some((one) => one.content === 'а теперь кофейни'))
})

/*
 * ЦЕЛОСТНОСТЬ ПОСЛЕ СЖАТИЯ — НА РАЗНЫХ ФОРМАХ ИСТОРИИ, А НЕ НА ОДНОЙ УДОБНОЙ.
 *
 * Проверка одной заготовки здесь бесполезна: срез по числу сообщений на ней случайно попадает ровно
 * на границу хода и выглядит исправным. Группа «вызовы → результаты» должна побывать в начале, в
 * середине и в конце, а число сохраняемых ходов — меняться. Ошибка в границе среза оставляет результат
 * инструмента без заказавшей его реплики, и провайдер отвергает следующий запрос ЦЕЛИКОМ.
 */
await checkAsync(async () => {
  const toolTurn = (n) => [
    { role: 'user', content: `запрос ${n}` },
    {
      role: 'assistant', content: null,
      tool_calls: [
        { id: `t${n}a`, type: 'function', function: { name: 'search_leads', arguments: '{}' } },
        { id: `t${n}b`, type: 'function', function: { name: 'fs_export', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: `t${n}a`, name: 'search_leads', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: `t${n}b`, name: 'fs_export', content: '{"ok":true}' },
    { role: 'assistant', content: `итог ${n}` },
  ]
  const plainTurn = (n) => [
    { role: 'user', content: `вопрос ${n}` },
    { role: 'assistant', content: `ответ ${n}` },
  ]

  let cases = 0
  for (const withTools of [0, 1, 2, 3]) {
    for (const total of [3, 4, 5]) {
      if (withTools >= total) continue
      for (const keep of [1, 2, 3]) {
        const session = new AgentSession('промпт', { registry: makeRegistry(), stream: async function* () {} })
        for (let turn = 0; turn < total; turn++) {
          session.messages.push(...(turn === withTools ? toolTurn(turn) : plainTurn(turn)))
        }
        assert.deepEqual(historyFaults(session.messages), [], 'заготовка негодна до сжатия')

        const result = await session.compact(async () => 'пересказ', keep)
        const shape = `группа на ходе ${withTools} из ${total}, сохраняем ${keep}`
        assert.deepEqual(historyFaults(session.messages), [], `сжатие сломало историю: ${shape}`)
        if (result.summarized > 0) {
          // Граница среза обязана совпасть с началом хода: сразу после пересказа идёт реплика человека.
          const after = session.messages.findIndex((one) => one.content === 'пересказ')
          assert.equal(session.messages[after + 1]?.role, 'user', `срез попал не на границу хода: ${shape}`)
        }
        cases++
      }
    }
  }
  assert.ok(cases >= 20, `проверено всего ${cases} форм — мало для уверенности`)
})

// Сжимать короткий разговор нечего, и об этом надо сказать: молчаливое «готово» на неизменённой
// истории читается как успех.
await checkAsync(async () => {
  const session = new AgentSession('промпт', { registry: makeRegistry(), stream: async function* () {} })
  session.messages.push({ role: 'user', content: 'привет' }, { role: 'assistant', content: 'здравствуйте' })
  const result = await run(session, '/compact')
  assert.ok(result.lines[0].includes('нечего'))
  assert.equal(session.messages.length, 3, 'короткая история всё-таки тронута')
})

// Пересказ просят с явным запретом выдумывать: сжатие, добавившее несуществующий телефон, отравляет
// весь остаток разговора и уже ничем не отличимо от правды.
check(() => assert.ok(/[Нн]е выдумывай/.test(COMPACT_INSTRUCTION)))
check(() => assert.ok(/телефон/.test(COMPACT_INSTRUCTION), 'пересказ должен беречь конкретные данные'))

// ─── /agent ───────────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const session = seededSession()
  const result = await run(session, '/agent qa')
  assert.ok(result.lines[0].includes('qa'))
  // Промпт заменён НА МЕСТЕ: вторая системная реплика противоречила бы первой, и модель следовала бы
  // то одной, то другой.
  assert.equal(session.messages.filter((one) => one.role === 'system').length, 1)
  assert.ok(session.messages[0].content.includes('проверки'))
  assert.deepEqual(historyFaults(session.messages), [], 'смена роли повредила историю')
})

// Смена роли НЕ стирает разговор: человек переключает специализацию посреди работы, а не начинает
// заново.
await checkAsync(async () => {
  const session = seededSession()
  const before = session.turnCount
  await run(session, '/agent sdr')
  assert.equal(session.turnCount, before, 'смена роли потеряла историю')
})

await checkAsync(async () => {
  const result = await run(seededSession(), '/agent нетакой')
  assert.ok(result.lines[0].includes('нет роли'))
  assert.ok(result.lines[0].includes('general'), 'отказ должен перечислять доступные роли')
})

// Без аргумента — показать текущую и список, а не молча ничего не сделать.
await checkAsync(async () => {
  const result = await run(seededSession(), '/agent')
  assert.ok(result.lines[0].includes('сейчас'))
  assert.ok(result.lines.some((one) => one.includes('media')))
})

// Смена роли называет НОВЫЙ круг инструментов: она молча отбирает часть возможностей, и узнать об
// этом человек должен сразу, а не когда модель откажется отправить лид.
await checkAsync(async () => {
  const result = await run(seededSession(), '/agent qa')
  assert.ok(result.lines.some((one) => one.includes('инструменты')))
})

// ─── /model ───────────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const result = await run(seededSession(), '/model gpt4o')
  assert.ok(result.lines[0].includes('openai/gpt-4o'))
})
await checkAsync(async () => {
  const result = await run(seededSession(), '/model local')
  assert.ok(result.lines[0].includes('локально'), 'человек должен узнать, что запросы ушли на свою машину')
  assert.ok(result.lines[0].includes(LOCAL_MODEL_BASE))
})
// Отказ смены модели виден: молча оставленная прежняя модель означает, что человек считает счёт за
// одну, а работает другая.
await checkAsync(async () => {
  const result = await run(seededSession(), '/model qwen', { setModel: () => 'Ollama не отвечает на 11434' })
  assert.ok(result.lines[0].includes('не отвечает'))
})
await checkAsync(async () => {
  const result = await run(seededSession(), '/model')
  assert.ok(result.lines[0].includes('сейчас'))
  assert.ok(result.lines.some((one) => one.includes('claude')))
})

// ─── /browse и /scrape ────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const result = await run(seededSession(), '/browse https://example.com')
  assert.equal(result.kind, 'prompt')
  assert.ok(result.text.includes('https://example.com'))
})
await checkAsync(async () => {
  const result = await run(seededSession(), '/scrape https://example.com')
  assert.equal(result.kind, 'prompt')
  assert.ok(/JSON/.test(result.text))
  assert.ok(/[Нн]ичего не выдумывай/.test(result.text), 'извлечение без запрета выдумывать даст выдуманные телефоны')
})
// Схему НЕ подставляем молча: однажды это отправит агента не туда, куда просили.
await checkAsync(async () => {
  const result = await run(seededSession(), '/browse example.com')
  assert.equal(result.kind, 'lines')
  assert.ok(result.lines[0].includes('http'))
})
await checkAsync(async () => {
  const result = await run(seededSession(), '/browse')
  assert.ok(result.lines[0].includes('нужен адрес'))
})

// ─── /export ──────────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const written = []
  const result = await run(seededSession(), '/export json', { writeExport: async (n, b) => { written.push([n, b]); return `/tmp/${n}` } })
  assert.ok(result.lines[0].includes('session.json'))
  const parsed = JSON.parse(written[0][1])
  assert.ok(Array.isArray(parsed) && parsed.length > 1)
})
await checkAsync(async () => {
  const written = []
  await run(seededSession(), '/export', { writeExport: async (n, b) => { written.push([n, b]); return `/tmp/${n}` } })
  assert.equal(written[0][0], 'session.md', 'умолчание формата — markdown')
})
await checkAsync(async () => {
  const result = await run(seededSession(), '/export pdf')
  assert.ok(result.lines[0].includes('json или md'))
})

/*
 * ВЫГРУЗКА НЕ ВЫНОСИТ АРГУМЕНТЫ ВЫЗОВОВ.
 *
 * Файл сессии легко уходит в чат или в тикет, а в аргументах вызовов лежат телефоны найденных людей.
 * В Markdown видно ЧТО звалось, но не с какими данными.
 */
check(() => {
  const text = renderTranscript([
    { role: 'system', content: 'секретный системный промпт' },
    { role: 'user', content: 'найди клиники' },
    {
      role: 'assistant', content: 'Ищу.',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'telegram_send_lead', arguments: '{"phone":"+998901234567"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'telegram_send_lead', content: '{"ok":true}' },
  ])
  assert.ok(!text.includes('+998901234567'), 'телефон утёк в выгрузку сессии')
  assert.ok(!text.includes('секретный системный промпт'), 'системный промпт утёк в выгрузку')
  assert.ok(text.includes('telegram_send_lead'), 'из выгрузки не видно, что звалось')
  assert.ok(text.includes('найди клиники'))
})

// ─── /health, /balance, /mcp, /tools, /help ───────────────────────────────────────────────────────

await checkAsync(async () => {
  const result = await run(seededSession(), '/health', {
    health: async () => [
      { name: 'Supabase', ok: true, detail: 'настроен' },
      { name: 'FFmpeg', ok: false, detail: 'не найден в PATH' },
    ],
  })
  assert.ok(result.lines[0].includes('✓'))
  assert.ok(result.lines[1].includes('×'))
  assert.ok(result.lines[1].includes('не найден'), 'нерабочая зависимость должна объяснять причину')
})

await checkAsync(async () => {
  const result = await run(seededSession(), '/balance', { balance: async () => ({ ok: false, error: '401' }) })
  assert.ok(result.lines[0].includes('не удалось'), 'неудача запроса баланса не должна выглядеть как нулевой остаток')
})

await checkAsync(async () => {
  const result = await run(seededSession(), '/mcp')
  assert.ok(result.lines[0].includes('не настроены'))
  assert.ok(result.lines.some((one) => one.includes('NEMO_MCP_SERVERS')), 'сказать, что не настроено, но не как настроить — бесполезно')
})
await checkAsync(async () => {
  const result = await run(seededSession(), '/mcp', {
    mcpStatus: () => [{ server: 'fs', state: 'подключён', tools: ['mcp__fs__read_file'] }],
  })
  assert.ok(result.lines[0].includes('подключён'))
  assert.ok(result.lines[1].includes('mcp__fs__read_file'))
})

await checkAsync(async () => {
  const result = await run(seededSession(), '/tools')
  assert.ok(result.lines.some((one) => one.includes('действие') && one.includes('telegram_send_lead')))
  assert.ok(result.lines.some((one) => one.includes('чтение') && one.includes('search_leads')))
})

await checkAsync(async () => {
  const result = await run(seededSession(), '/help')
  for (const command of COMMANDS) {
    assert.ok(result.lines.some((one) => one.includes(`/${command.name}`)), `/help молчит про /${command.name}`)
  }
})

await checkAsync(async () => assert.equal((await run(seededSession(), '/exit')).kind, 'exit'))
await checkAsync(async () => assert.equal((await run(seededSession(), '/quit')).kind, 'exit'))

// Опечатка получает подсказку: «нет такой команды» без вариантов заставляет искать /help вручную.
await checkAsync(async () => {
  const result = await run(seededSession(), '/agnt sdr')
  assert.equal(result.kind, 'unknown')
  assert.ok(result.suggestions.includes('agent'), `подсказки: ${result.suggestions.join(', ')}`)
})

// ─── Смена реестра на сессии ──────────────────────────────────────────────────────────────────────

check(() => {
  const session = seededSession()
  setSessionRegistry(session, restrictRegistry(makeRegistry(), AGENT_ROLES.qa.tools))
  // История НЕ трогается: в ней лежат результаты инструментов, которых в новой роли нет, и это
  // нормально — они описывают прошлое, а не будущие возможности.
  assert.deepEqual(historyFaults(session.messages), [])
})

// ─── Строка состояния и проверка зависимостей ─────────────────────────────────────────────────────

/*
 * СТРОКА СОСТОЯНИЯ ГОВОРИТ, ЧТО ЕСТЬ, А НЕ ЧЕГО НЕТ.
 *
 * Раньше при старте печатался список «недоступно: браузер выключен | нет CRM_WEBHOOK_URL | нет
 * ffmpeg» — пять строк, читающихся как пять поломок. Человек начинал искать причину там, где её нет:
 * браузер выключен настройкой, а ffmpeg не нужен для поиска клиентов. Чего нет — покажет /health.
 */
check(() => assert.equal(
  toolBadges(['search_leads', 'browser_navigate_and_extract', 'browser_screenshot', 'telegram_send_lead', 'crm_sync_lead', 'fs_export']),
  '6 активны [OSM, Browser, Telegram, CRM, FFmpeg, FS]'.replace('FFmpeg, ', ''),
))
check(() => assert.equal(toolBadges([]), 'ни одного'))
// Два инструмента одного семейства дают ОДИН ярлык: «Browser, Browser» ничего не добавляет.
check(() => assert.equal(toolBadges(['browser_a', 'browser_b']), '2 активны [Browser]'))
check(() => assert.ok(toolBadges(['mcp__fs__read', 'render_video_pitch']).includes('MCP')))
check(() => assert.ok(toolBadges(['render_video_pitch']).includes('FFmpeg')))
// Незнакомое имя показывается как есть: молча пропустить его значит соврать про число инструментов.
check(() => assert.ok(toolBadges(['своё_имя']).includes('своё_имя')))

await checkAsync(async () => {
  const health = await collectHealth({}, async () => ({ ok: false, detail: 'нет' }))
  const openrouter = health.find((one) => one.name === 'OpenRouter')
  assert.equal(openrouter.ok, false)
  // Отказ называет НЕДОСТАЮЩИЙ КЛЮЧ. «Не настроен» без имени переменной заставляет читать код.
  assert.ok(openrouter.detail.includes('OPENROUTER_API_KEY'), openrouter.detail)
})

// Отказ одной проверки не отменяет остальные: «Supabase не настроен» не повод скрыть, что ffmpeg на
// месте.
await checkAsync(async () => {
  const health = await collectHealth({ OPENROUTER_API_KEY: 'k' }, async () => ({ ok: true, detail: 'найден' }))
  assert.ok(health.length >= 7, `проверок всего ${health.length}`)
  assert.ok(health.some((one) => one.ok), 'ни одна проверка не прошла')
  assert.ok(health.some((one) => !one.ok), 'проверки не различают настроенное и ненастроенное')
})

// Выключенный настройкой браузер отличается от сломанного: причина видна сразу.
await checkAsync(async () => {
  const health = await collectHealth({ SDR_BROWSER: 'off' }, async () => ({ ok: true, detail: 'найден' }))
  const browser = health.find((one) => one.name === 'Browser')
  assert.equal(browser.ok, false)
  assert.ok(browser.detail.includes('SDR_BROWSER'), browser.detail)
})

/*
 * НЕУДАЧА ЗАПРОСА БАЛАНСА НЕ ВЫГЛЯДИТ КАК НУЛЕВОЙ ОСТАТОК.
 *
 * Показать «$0.00» вместо «запрос не прошёл» значит отправить человека пополнять счёт, на котором
 * деньги есть.
 */
await checkAsync(async () => {
  const result = await fetchBalance('k', async () => ({ ok: false, status: 401 }))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('401'))
})
await checkAsync(async () => {
  const result = await fetchBalance('k', async () => { throw new Error('сеть недоступна') })
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('сеть'))
})
// Ответ без нужных полей — тоже отказ, а не остаток NaN.
await checkAsync(async () => {
  const result = await fetchBalance('k', async () => ({ ok: true, json: async () => ({ data: {} }) }))
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('total_credits'))
})
await checkAsync(async () => {
  const result = await fetchBalance('k', async () => ({
    ok: true, json: async () => ({ data: { total_credits: 10, total_usage: 5.5 } }),
  }))
  assert.ok(result.ok && result.text.includes('$4.50'), JSON.stringify(result))
})
check(() => assert.equal(fetchBalance('') instanceof Promise, true))

/*
 * ПЕРВЫЙ ответ побеждает, и он приходит СРАЗУ.
 *
 * Отсутствующая программа даёт и 'error', и 'close'. Побеждать должен 'error' — по нему видно причину
 * («ENOENT»), а из кода выхода её не восстановить. И ответ обязан прийти немедленно: /health,
 * ждущий трёхсекундный таймаут на каждой отсутствующей программе, человек считает зависшим.
 */
await checkAsync(async () => {
  const fake = () => {
    const handlers = {}
    queueMicrotask(() => {
      handlers.error?.(new Error('spawn ENOENT'))
      handlers.close?.(1)
    })
    return { on: (event, fn) => { handlers[event] = fn } }
  }
  const started = Date.now()
  const result = await probeBinary('нет-такой', ['-v'], fake)
  assert.equal(result.ok, false)
  assert.ok(result.detail.includes('ENOENT'), `причина потеряна: ${result.detail}`)
  assert.ok(Date.now() - started < 500, 'ответ ждал таймаут вместо того, чтобы прийти сразу')
})

// Молчащая программа не держит /health вечно: таймаут отвечает сам и говорит, что произошло.
await checkAsync(async () => {
  const silent = () => ({ on: () => {} })
  const started = Date.now()
  const result = await probeBinary('молчун', ['-v'], silent)
  assert.equal(result.ok, false)
  assert.ok(result.detail.includes('не ответил'), result.detail)
  assert.ok(Date.now() - started >= 2_900, 'таймаут сработал раньше срока')
})

console.log(`[OK] CLI slash commands: ${checks} assertions`)
