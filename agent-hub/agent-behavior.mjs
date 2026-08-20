// Агентный цикл: сборка вызовов из потока, граница прав, предел шагов, отрисовка.
//
// ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ — ЧЕТЫРЕ ВЕЩИ, И КАЖДАЯ ЛОМАЕТСЯ ТИХО:
//
//   1. СБОРКА ФРАГМЕНТОВ ПО index. Аргументы приходят кусками строки, и при двух параллельных вызовах
//      порядок элементов между фрагментами меняется. Сборка по позиции в массиве склеила бы аргументы
//      разных инструментов, а JSON.parse затем выдал бы ошибку разбора — по ней невозможно понять,
//      что произошло.
//
//   2. ССЫЛКА tool_call_id. Результат возвращается сообщением с тем же идентификатором, что прислала
//      модель. Потерянный id — отказ следующего запроса с сообщением про несоответствие сообщений.
//
//   3. ПОДТВЕРЖДЕНИЕ ДЕЙСТВИЙ. Модель предлагает вызов по тексту, который писала не она: содержимое
//      чужого сайта, чужая карточка компании. Отправка сообщения живому человеку и запись в чужую CRM
//      не должны происходить по такому основанию.
//
//   4. ПАРНОСТЬ СОБЫТИЙ. tool_start рисует открытую рамку, tool_end закрывает её итогом. Пропущенное
//      закрытие оставляет висящий короб — так и было при отказе подтвердить действие, пока это не
//      всплыло на прогоне.
//
// Модель здесь подменена сценарием: цикл проверяется без сети, без ключа и за миллисекунды.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  AgentSession, MAX_STEPS, ToolCallAccumulator, buildAgentSystemPrompt, createOpenRouterStream,
  formatToolResult, parseToolArguments,
} from './agent-runtime.ts'
import { ToolRegistry, defineTool } from './tools/registry.ts'
import {
  buildFsExportTool, buildPlatformRegistry, safeExportName, SearchLeadsParams,
} from './tools/platform.ts'
import { createRenderer, formatArgs, runningLabel } from './nemo-ui.mjs'
import { groupSummary, humanBytes, seconds, shortUrl, thoughtBadge, toolBadge } from './cli/hud.ts'
import { visibleWidth } from './tui.mjs'

let checks = 0
const check = (fn) => { fn(); checks++ }
const checkAsync = async (fn) => { await fn(); checks++ }

// ─── Сборка фрагментов вызова ─────────────────────────────────────────────────────────────────────

check(() => {
  const acc = new ToolCallAccumulator()
  acc.push({ kind: 'tool_delta', index: 0, id: 'c1', name: 'search_leads', argsDelta: '{"que' })
  acc.push({ kind: 'tool_delta', index: 0, argsDelta: 'ry":"кофейни"}' })
  const calls = acc.finish()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].function.arguments, '{"query":"кофейни"}')
})

/*
 * ДВА ПАРАЛЛЕЛЬНЫХ ВЫЗОВА, фрагменты вперемешку.
 *
 * Главная проверка файла. Сборка по позиции в массиве склеила бы «{"que» первого вызова с «mat":"csv"}»
 * второго — и разбор аргументов упал бы с ошибкой, по которой не догадаться о причине.
 */
check(() => {
  const acc = new ToolCallAccumulator()
  acc.push({ kind: 'tool_delta', index: 0, id: 'a', name: 'search_leads', argsDelta: '{"que' })
  acc.push({ kind: 'tool_delta', index: 1, id: 'b', name: 'fs_export', argsDelta: '{"for' })
  acc.push({ kind: 'tool_delta', index: 1, argsDelta: 'mat":"csv"}' })
  acc.push({ kind: 'tool_delta', index: 0, argsDelta: 'ry":"кофейни"}' })
  const calls = acc.finish()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].function.name, 'search_leads')
  assert.equal(calls[0].function.arguments, '{"query":"кофейни"}')
  assert.equal(calls[1].function.name, 'fs_export')
  assert.equal(calls[1].function.arguments, '{"format":"csv"}')
})

// Идентификатор и имя приходят один раз: перезапись их пустой строкой из следующих фрагментов теряет
// id, а без него следующий запрос отвергается целиком.
check(() => {
  const acc = new ToolCallAccumulator()
  acc.push({ kind: 'tool_delta', index: 0, id: 'keep', name: 'tool', argsDelta: '{' })
  acc.push({ kind: 'tool_delta', index: 0, argsDelta: '}' })
  assert.equal(acc.finish()[0].id, 'keep')
})
// Порядок выдачи — по индексам, а не по времени прихода фрагментов.
check(() => {
  const acc = new ToolCallAccumulator()
  acc.push({ kind: 'tool_delta', index: 2, id: 'c', name: 'третий' })
  acc.push({ kind: 'tool_delta', index: 0, id: 'a', name: 'первый' })
  assert.deepEqual(acc.finish().map((one) => one.function.name), ['первый', 'третий'])
})
check(() => assert.equal(new ToolCallAccumulator().finish().length, 0))
check(() => assert.equal(new ToolCallAccumulator().isEmpty, true))
// Фрагмент без имени — это мусор в потоке, а не вызов: звать инструмент без имени нечем.
check(() => {
  const acc = new ToolCallAccumulator()
  acc.push({ kind: 'tool_delta', index: 0, argsDelta: '{}' })
  assert.equal(acc.finish().length, 0)
})
// Вызов без аргументов законен: у инструмента может не быть параметров.
check(() => {
  const acc = new ToolCallAccumulator()
  acc.push({ kind: 'tool_delta', index: 0, id: 'x', name: 'ping' })
  assert.equal(acc.finish()[0].function.arguments, '{}')
})

// ─── Разбор аргументов ────────────────────────────────────────────────────────────────────────────

check(() => assert.deepEqual(parseToolArguments('{"a":1}'), { ok: true, args: { a: 1 } }))
check(() => assert.deepEqual(parseToolArguments(''), { ok: true, args: {} }))
// Модель регулярно оборачивает JSON в ```json вопреки формату протокола.
check(() => assert.deepEqual(parseToolArguments('```json\n{"a":1}\n```'), { ok: true, args: { a: 1 } }))
check(() => assert.equal(parseToolArguments('{обрыв').ok, false))
// Массив вместо объекта — не аргументы: у инструментов именованные параметры.
check(() => assert.equal(parseToolArguments('[1,2]').ok, false))
check(() => assert.equal(parseToolArguments('"строка"').ok, false))

// ─── Результат инструмента для модели ─────────────────────────────────────────────────────────────

check(() => assert.equal(
  formatToolResult({ ok: true, name: 'x', result: { found: 3 }, durationMs: 10 }),
  '{"ok":true,"result":{"found":3}}',
))
check(() => {
  const failed = formatToolResult({ ok: false, name: 'x', code: 'timeout', error: 'не ответил', durationMs: 10 })
  assert.ok(failed.includes('"ok":false'))
  assert.ok(failed.includes('timeout'), 'код отказа нужен модели для решения, повторять ли вызов')
})

/*
 * Длинный результат обрезается и ПОМЕЧАЕТСЯ обрезанным.
 *
 * Страница сайта на двести килобайт съедает контекст и стоит денег. Но молчаливая обрезка хуже: модель
 * принимает обрывок за полные данные и делает вывод по половине списка.
 */
check(() => {
  const huge = formatToolResult({ ok: true, name: 'x', result: { text: 'я'.repeat(50_000) }, durationMs: 1 })
  assert.ok(huge.length < 13_000)
  assert.ok(huge.includes('ОБРЕЗАН'), 'обрезка без пометки заставит модель считать обрывок полными данными')
})

// ─── Цикл ─────────────────────────────────────────────────────────────────────────────────────────

function makeRegistry() {
  const registry = new ToolRegistry()
  const calls = []
  registry.register(defineTool({
    name: 'search_leads', description: 'Найти компании', permission: 'read_only',
    parameters: z.object({ query: z.string().min(2), city: z.string().optional() }),
    execute: async (args) => { calls.push(`search:${args.query}`); return { found: 3, hot: 1 } },
  }))
  registry.register(defineTool({
    name: 'telegram_send_lead', description: 'Отправить карточку', permission: 'action',
    parameters: z.object({ leadName: z.string() }),
    execute: async (args) => { calls.push(`send:${args.leadName}`); return { sent: true } },
  }))
  return { registry, calls }
}

/** Мок модели: сценарий — массив шагов, каждый шаг это список фрагментов потока. */
function scriptedStream(script) {
  let step = 0
  return async function* () { for (const chunk of script[step++] ?? []) yield chunk }
}

const TEXT_ONLY = [[{ kind: 'text', delta: 'Я Nemo, ' }, { kind: 'text', delta: 'помогаю искать клиентов.' }]]

// Вопрос о себе НЕ должен звать инструменты: опрос справочника в ответ на «кто ты» стоит денег и
// выглядит глупо.
await checkAsync(async () => {
  const { registry, calls } = makeRegistry()
  const session = new AgentSession('sys', { registry, stream: scriptedStream(TEXT_ONLY) })
  const answer = await session.send('кто ты?')
  assert.equal(answer, 'Я Nemo, помогаю искать клиентов.')
  assert.deepEqual(calls, [])
  assert.deepEqual(session.messages.map((one) => one.role), ['system', 'user', 'assistant'])
})

// Полный цикл: вызов инструмента, результат обратно в модель, финальный текст.
await checkAsync(async () => {
  const { registry, calls } = makeRegistry()
  const script = [
    [{ kind: 'tool_delta', index: 0, id: 'c1', name: 'search_leads', argsDelta: '{"query":"стоматология","city":"Ташкент"}' }],
    [{ kind: 'text', delta: 'Нашёл 3 компании, одна горячая.' }],
  ]
  const session = new AgentSession('sys', { registry, stream: scriptedStream(script) })
  const answer = await session.send('найди стоматологии в Ташкенте')
  assert.equal(answer, 'Нашёл 3 компании, одна горячая.')
  assert.deepEqual(calls, ['search:стоматология'])
  // Порядок ролей задан протоколом: реплика с вызовами ДО их результатов, иначе следующий запрос
  // отвергается.
  assert.deepEqual(session.messages.map((one) => one.role), ['system', 'user', 'assistant', 'tool', 'assistant'])
})

// Идентификатор результата совпадает с тем, что прислала модель.
await checkAsync(async () => {
  const { registry } = makeRegistry()
  const script = [
    [{ kind: 'tool_delta', index: 0, id: 'call_xyz', name: 'search_leads', argsDelta: '{"query":"кофейни"}' }],
    [{ kind: 'text', delta: 'готово' }],
  ]
  const session = new AgentSession('sys', { registry, stream: scriptedStream(script) })
  await session.send('найди')
  const toolMessage = session.messages.find((one) => one.role === 'tool')
  assert.equal(toolMessage.tool_call_id, 'call_xyz', 'потерянный id ломает следующий запрос целиком')
  const assistant = session.messages.find((one) => one.role === 'assistant' && one.tool_calls)
  assert.equal(assistant.tool_calls[0].id, 'call_xyz')
})

// ─── Граница прав ─────────────────────────────────────────────────────────────────────────────────

const SEND_SCRIPT = [
  [{ kind: 'tool_delta', index: 0, id: 'c1', name: 'telegram_send_lead', argsDelta: '{"leadName":"Дента"}' }],
  [{ kind: 'text', delta: 'Готово.' }],
]

await checkAsync(async () => {
  const { registry, calls } = makeRegistry()
  const asked = []
  const session = new AgentSession('sys', {
    registry, stream: scriptedStream(SEND_SCRIPT),
    confirm: async (name) => { asked.push(name); return true },
  })
  await session.send('отправь карточку')
  assert.deepEqual(asked, ['telegram_send_lead'], 'действие выполнено без вопроса человеку')
  assert.deepEqual(calls, ['send:Дента'])
})

/*
 * Отказ человека НЕ выполняет действие и СООБЩАЕТСЯ модели результатом.
 *
 * Молчание вместо результата хуже отказа: модель, не получив ответа, отчитается об отправке как о
 * сделанной, и человек узнает правду через день по отсутствию реакции клиента.
 */
await checkAsync(async () => {
  const { registry, calls } = makeRegistry()
  const session = new AgentSession('sys', {
    registry, stream: scriptedStream(SEND_SCRIPT), confirm: async () => false,
  })
  await session.send('отправь карточку')
  assert.deepEqual(calls, [], 'действие выполнено вопреки отказу')
  const toolMessage = session.messages.find((one) => one.role === 'tool')
  assert.ok(toolMessage.content.includes('отклонил'), 'модель не узнала об отказе')
  assert.ok(toolMessage.content.includes('"ok":false'))
})

// Без функции подтверждения действия недоступны вовсе: спросить некого, а выполнять по решению модели
// нельзя.
await checkAsync(async () => {
  const { registry, calls } = makeRegistry()
  const session = new AgentSession('sys', { registry, stream: scriptedStream(SEND_SCRIPT) })
  await session.send('отправь карточку')
  assert.deepEqual(calls, [])
  assert.ok(session.messages.find((one) => one.role === 'tool').content.includes('permission_denied'))
})

// Чтение выполняется БЕЗ вопросов: спрашивать на каждый поиск значит приучить жать «да» не глядя — и
// тем обесценить подтверждение там, где оно нужно.
await checkAsync(async () => {
  const { registry } = makeRegistry()
  const asked = []
  const script = [
    [{ kind: 'tool_delta', index: 0, id: 'c1', name: 'search_leads', argsDelta: '{"query":"кофейни"}' }],
    [{ kind: 'text', delta: 'готово' }],
  ]
  const session = new AgentSession('sys', {
    registry, stream: scriptedStream(script), confirm: async (name) => { asked.push(name); return true },
  })
  await session.send('найди')
  assert.deepEqual(asked, [], 'чтение не должно требовать подтверждения')
})

// ─── Отказы ───────────────────────────────────────────────────────────────────────────────────────

// Негодные аргументы уходят модели результатом: она перевызывает инструмент исправленным. Исключение
// оборвало бы весь ответ.
await checkAsync(async () => {
  const { registry } = makeRegistry()
  const script = [
    [{ kind: 'tool_delta', index: 0, id: 'c1', name: 'search_leads', argsDelta: '{обрыв' }],
    [{ kind: 'text', delta: 'исправляюсь' }],
  ]
  const session = new AgentSession('sys', { registry, stream: scriptedStream(script) })
  assert.equal(await session.send('найди'), 'исправляюсь')
  assert.ok(session.messages.find((one) => one.role === 'tool').content.includes('invalid_arguments'))
})

// Несуществующий инструмент: модель узнаёт список доступных и может выбрать из него.
await checkAsync(async () => {
  const { registry } = makeRegistry()
  const script = [
    [{ kind: 'tool_delta', index: 0, id: 'c1', name: 'нет_такого', argsDelta: '{}' }],
    [{ kind: 'text', delta: 'понял' }],
  ]
  const session = new AgentSession('sys', { registry, stream: scriptedStream(script) })
  await session.send('сделай что-нибудь')
  const content = session.messages.find((one) => one.role === 'tool').content
  assert.ok(content.includes('tool_not_found'))
  assert.ok(content.includes('search_leads'), 'без перечисления доступного модель выдумает второе имя')
})

// Отказ модели не роняет сессию: история цела, человек может повторить.
await checkAsync(async () => {
  const { registry } = makeRegistry()
  const session = new AgentSession('sys', {
    registry,
    stream: async function* () { throw new Error('OpenRouter ответил 503') },
  })
  const answer = await session.send('найди')
  assert.ok(answer.includes('503'), 'причина отказа должна дойти до человека')
  assert.ok(session.messages.length >= 2, 'история потеряна')
})

/*
 * ПРЕДЕЛ ШАГОВ: модель, зовущая инструмент бесконечно, останавливается.
 *
 * И останавливается ЗАМЕТНО. Молча оборванная цепочка выглядит как ответ, хотя работа не доделана, и
 * человек уходит с неверным представлением о результате.
 */
await checkAsync(async () => {
  const { registry, calls } = makeRegistry()
  let step = 0
  const session = new AgentSession('sys', {
    registry,
    maxSteps: 4,
    // Модель всегда зовёт инструмент и никогда не отвечает текстом.
    stream: async function* () {
      yield { kind: 'tool_delta', index: 0, id: `c${step++}`, name: 'search_leads', argsDelta: '{"query":"кофейни"}' }
    },
  })
  const answer = await session.send('ищи бесконечно')
  assert.equal(calls.length, 4, `инструмент вызван ${calls.length} раз при пределе 4`)
  assert.ok(answer.includes('4 шагов'), 'остановка должна быть названа, а не молчаливой')
})

check(() => assert.ok(MAX_STEPS >= 4 && MAX_STEPS <= 30, 'предел должен быть конечным и осмысленным'))

// Несколько вызовов на одном шаге обрабатываются все, и у каждого свой результат.
await checkAsync(async () => {
  const { registry, calls } = makeRegistry()
  const script = [
    [
      { kind: 'tool_delta', index: 0, id: 'a', name: 'search_leads', argsDelta: '{"query":"кофейни"}' },
      { kind: 'tool_delta', index: 1, id: 'b', name: 'search_leads', argsDelta: '{"query":"пекарни"}' },
    ],
    [{ kind: 'text', delta: 'оба готовы' }],
  ]
  const session = new AgentSession('sys', { registry, stream: scriptedStream(script) })
  await session.send('найди то и другое')
  assert.deepEqual(calls, ['search:кофейни', 'search:пекарни'])
  assert.equal(session.messages.filter((one) => one.role === 'tool').length, 2)
})

// Текст и вызов на одном шаге: модель часто объясняет, что собирается делать, и тут же зовёт.
await checkAsync(async () => {
  const { registry } = makeRegistry()
  const seen = []
  const script = [
    [{ kind: 'text', delta: 'Сейчас поищу. ' }, { kind: 'tool_delta', index: 0, id: 'c1', name: 'search_leads', argsDelta: '{"query":"кофейни"}' }],
    [{ kind: 'text', delta: 'Нашёл.' }],
  ]
  const session = new AgentSession('sys', {
    registry, stream: scriptedStream(script),
    onEvent: (event) => { if (event.type === 'text') seen.push(event.delta) },
  })
  await session.send('найди')
  assert.deepEqual(seen, ['Сейчас поищу. ', 'Нашёл.'], 'текст перед вызовом инструмента потерян')
})

// ─── Парность событий ─────────────────────────────────────────────────────────────────────────────
//
// tool_start рисует открытую рамку, tool_end закрывает её. Пропущенное закрытие оставляет висящий
// короб — так и было при отказе подтвердить действие, пока это не всплыло на прогоне.

const collectEvents = async (confirmResult) => {
  const { registry } = makeRegistry()
  const events = []
  const session = new AgentSession('sys', {
    registry, stream: scriptedStream(SEND_SCRIPT),
    confirm: async () => confirmResult,
    onEvent: (event) => { if (event.type === 'tool_start' || event.type === 'tool_end') events.push(event.type) },
  })
  await session.send('отправь')
  return events
}
await checkAsync(async () => assert.deepEqual(await collectEvents(true), ['tool_start', 'tool_end']))
await checkAsync(async () => assert.deepEqual(await collectEvents(false), ['tool_start', 'tool_end'],
  'при отказе рамка осталась открытой'))

// Негодные аргументы: рамка тоже обязана закрыться.
await checkAsync(async () => {
  const { registry } = makeRegistry()
  const events = []
  const script = [
    [{ kind: 'tool_delta', index: 0, id: 'c1', name: 'search_leads', argsDelta: '{битый' }],
    [{ kind: 'text', delta: 'ладно' }],
  ]
  const session = new AgentSession('sys', {
    registry, stream: scriptedStream(script),
    onEvent: (event) => { if (event.type.startsWith('tool_')) events.push(event.type) },
  })
  await session.send('найди')
  assert.deepEqual(events, ['tool_start', 'tool_end'])
})

// ─── Системный промпт ─────────────────────────────────────────────────────────────────────────────

check(() => {
  const prompt = buildAgentSystemPrompt({ toolNames: ['search_leads', 'fs_export'], hasConfirm: true })
  assert.ok(prompt.includes('search_leads'), 'модель должна знать список инструментов')
  // Три запрета, каждый закрывает свой способ навредить.
  assert.ok(prompt.includes('НЕ сообщай о выполненном действии'), 'нет запрета отчитываться о невыполненном')
  assert.ok(prompt.includes('НЕ выдумывай телефоны'), 'нет запрета выдумывать данные')
  assert.ok(prompt.includes('САМ извлекай параметры'), 'нет требования не переспрашивать очевидное')
})
check(() => assert.ok(buildAgentSystemPrompt({ toolNames: [], hasConfirm: false }).includes('недоступны')))

/*
 * ПРОМПТ НЕ ЗАПРЕЩАЕТ МОДЕЛИ ДУМАТЬ.
 *
 * Здесь была строка «всё, чего нет в результатах инструментов, ты не знаешь». Написанная против
 * выдуманных телефонов, она читалась буквально и шире: на просьбу написать тест или объяснить ошибку
 * модель отвечала, что у неё нет подходящего инструмента. Запрет выдумывать ФАКТЫ О ЧУЖИХ
 * ОРГАНИЗАЦИЯХ превратился в запрет рассуждать.
 */
check(() => {
  const prompt = buildAgentSystemPrompt({ toolNames: ['search_leads'], hasConfirm: true })
  assert.ok(
    !/чего нет в результатах\s+инструментов, ты не знаешь/.test(prompt),
    'вернулась строка, запрещающая модели знать что-либо без инструмента',
  )
  assert.ok(/писать код и тесты/.test(prompt), 'в промпте не сказано, что код можно писать без инструментов')
  assert.ok(/инструменты для этого НЕ нужны/i.test(prompt), 'нет прямого разрешения работать без инструментов')
  assert.ok(
    /действие во внешнем мире/.test(prompt),
    'не проведена граница, за которой инструмент действительно нужен',
  )
})

// Запрет выдумывать СОХРАНЁН, но сужен до фактов о конкретных организациях и людях.
check(() => {
  const prompt = buildAgentSystemPrompt({ toolNames: ['search_leads'], hasConfirm: true })
  assert.ok(/НЕ выдумывай телефоны/.test(prompt), 'пропал запрет выдумывать контакты')
  assert.ok(
    /На общие знания,\s+код и рассуждения это не распространяется/.test(prompt),
    'запрет выдумывать снова распространён на код и общие знания',
  )
})

/*
 * «ЧТО ТЫ УМЕЕШЬ» ОТВЕЧАЕТСЯ ПО СВОЕЙ РОЛИ.
 *
 * Модель, перечисляющая чужие возможности, обещает то, чего у неё нет: человек просит открыть сайт в
 * роли media и получает отказ после обещания.
 */
check(() => {
  const prompt = buildAgentSystemPrompt({ toolNames: ['render_video_pitch'], hasConfirm: true })
  assert.ok(/по СВОЕЙ роли/.test(prompt), 'нет требования отвечать в рамках своей роли')
  assert.ok(/Других у тебя нет/.test(prompt), 'модель не предупреждена, что список инструментов исчерпывающий')
  assert.ok(prompt.includes('render_video_pitch'))
  assert.ok(!prompt.includes('search_leads'), 'в промпт роли попал чужой инструмент')
})

// Без инструментов промпт всё равно разрешает работать: пустой список — не повод отказываться.
check(() => {
  const bare = buildAgentSystemPrompt({ toolNames: [], hasConfirm: false })
  assert.ok(/Это не мешает отвечать/.test(bare), 'без инструментов модель решит, что работать нечем')
})

// ─── Инструменты платформы ────────────────────────────────────────────────────────────────────────

/*
 * ИМЯ ФАЙЛА ИЗ ОТВЕТА МОДЕЛИ — ЧУЖАЯ СТРОКА.
 *
 * `../../.secrets.local` в этом поле не теория: имя попадает в путь на диске, и без обрезки инструмент
 * сохранения отчётов превращается в запись куда угодно.
 */
check(() => assert.equal(safeExportName('../../.secrets.local', 'csv'), '_secrets.csv'))
// Свойство, ради которого всё это: что бы ни прислали, получается ГОЛОЕ имя без переходов по каталогам.
check(() => {
  for (const attack of ['../../.secrets.local', '..\\..\\.env', '/etc/passwd', 'a/../../b', './../x']) {
    const name = safeExportName(attack, 'csv')
    assert.equal(path.basename(name), name, `${attack} дал путь, а не имя: ${name}`)
    assert.ok(!name.includes('..'), `${attack} сохранил переход вверх: ${name}`)
  }
})
check(() => assert.equal(safeExportName('C:\\Windows\\system32\\evil', 'json'), 'evil.json'))
check(() => assert.equal(safeExportName('отчёт по лидам', 'markdown'), 'отчёт_по_лидам.md'))
check(() => assert.equal(safeExportName('', 'csv'), 'export.csv'))
check(() => assert.equal(safeExportName('a'.repeat(300), 'csv').length <= 84, true))
check(() => assert.equal(safeExportName('report.txt', 'csv'), 'report.csv', 'расширение задаёт формат'))
check(() => assert.equal(safeExportName('a/b/c', 'json'), 'c.json', 'путь схлопывается до имени'))

await checkAsync(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nemo-export-'))
  try {
    const tool = buildFsExportTool({ directory: dir })
    const result = await tool.execute({ format: 'csv', filename: '../../побег', content: 'а,б\n1,2' }, {})
    assert.equal(path.dirname(result.path), dir, 'файл записан вне отведённого каталога')
    assert.ok(await fs.stat(result.path))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/*
 * Инструмент без зависимости НЕ РЕГИСТРИРУЕТСЯ.
 *
 * Зарегистрированный, но неработающий модель увидит, предложит человеку и вызовет — а получит отказ.
 * Дальше попробует ещё раз и объяснит, что «сервис недоступен»: всё это стоит токенов и времени.
 */
check(() => {
  const { registry, skipped } = buildPlatformRegistry({})
  assert.deepEqual(registry.names(), ['fs_export'], 'зарегистрировано лишнее без зависимостей')
  assert.ok(skipped.some((one) => one.includes('search_leads')))
  assert.ok(skipped.some((one) => one.includes('telegram_send_lead')))
})

check(() => {
  const { registry } = buildPlatformRegistry({
    runPipeline: async () => ({}), sendCard: async () => ({ ok: true }),
    syncLead: async () => ({ ok: true }), render: async () => ({}),
  })
  assert.deepEqual(registry.names().sort(), ['crm_sync_lead', 'fs_export', 'render_video_pitch', 'search_leads', 'telegram_send_lead'])
})

/*
 * ПРАВА: что выходит за пределы разговора, требует подтверждения.
 *
 * fs_export и render_video_pitch помечены чтением намеренно: их эффект локален и обратим удалением
 * файла. Спрашивать на каждое сохранение отчёта — верный способ приучить человека жать «да» не глядя,
 * и тогда он так же нажмёт «да» на отправке карточки не тому клиенту.
 */
check(() => {
  const { registry } = buildPlatformRegistry({
    runPipeline: async () => ({}), sendCard: async () => ({ ok: true }),
    syncLead: async () => ({ ok: true }), render: async () => ({}),
  })
  assert.equal(registry.get('telegram_send_lead').permission, 'action')
  assert.equal(registry.get('crm_sync_lead').permission, 'action')
  assert.equal(registry.get('search_leads').permission, 'read_only')
  assert.equal(registry.get('fs_export').permission, 'read_only')
  assert.equal(registry.get('render_video_pitch').permission, 'read_only')
})

// Поиск и рендер длятся минутами: стандартный предел реестра оборвал бы их на первой компании.
check(() => {
  const { registry } = buildPlatformRegistry({ runPipeline: async () => ({}), render: async () => ({}) })
  assert.ok(registry.get('search_leads').timeoutMs > 60_000)
  assert.ok(registry.get('render_video_pitch').timeoutMs > 60_000)
})

check(() => assert.equal(SearchLeadsParams.parse({ query: 'кофейни', city: 'Бухара' }).limit, 15))
check(() => assert.equal(SearchLeadsParams.safeParse({ query: 'к', city: 'Бухара' }).success, false))
check(() => assert.equal(SearchLeadsParams.safeParse({ query: 'кофейни' }).success, false, 'без города искать негде'))

// ─── Отрисовка ────────────────────────────────────────────────────────────────────────────────────

check(() => assert.equal(formatArgs({ query: 'стоматология', city: 'Ташкент' }), 'Ниша: стоматология | Город: Ташкент'))
// Пустые значения не показываются: строка «Сайт: | Телефон:» ничего не сообщает.
check(() => assert.equal(formatArgs({ query: 'кофейни', website: '', phone: null }), 'Ниша: кофейни'))
check(() => assert.equal(formatArgs({}), 'без параметров'))
check(() => assert.ok(formatArgs({ scenes: [1, 2, 3] }).includes('3 шт.'), 'массив показывается числом, а не целиком'))

/*
 * БЕЙДЖ ВЫЗОВА — ОДНА СТРОКА, И ОТКАЗ В НЕЙ ВИДЕН ВСЕГДА.
 *
 * Рамки в четыре строки на каждый вызов занимали двадцать строк экрана на цепочке из пяти, и ответ
 * модели терялся среди служебной графики. Печатать бейдж только при успехе заманчиво — вывод чище, —
 * но тогда неудавшийся вызов исчезает бесследно, и человек считает, что всё прошло.
 */
check(() => {
  const good = toolBadge({ name: 'search_leads', args: {}, ok: true, result: { found: 14, hot: 4 }, durationMs: 22_100 })
  assert.equal(good.includes('\n'), false, 'бейдж занял больше одной строки')
  assert.ok(good.includes('14'))
  assert.ok(good.includes('22.1 с'), 'в бейдже нет времени вызова')
})
check(() => {
  const bad = toolBadge({ name: 'telegram_send_lead', args: {}, ok: false, error: 'permission_denied: отклонено', durationMs: 5 })
  assert.ok(bad.includes('отклонено'), 'отказ не назван')
  assert.ok(bad.includes('✖'), 'отказ не помечен')
  assert.equal(bad.includes('✓'), false, 'отказ помечен как успех')
})
// Длинное значение не переносит бейдж на вторую строку: перенос ломает построчное чтение вывода.
check(() => {
  const long = toolBadge({
    name: 'browser_navigate_and_extract',
    args: { url: 'https://' + 'x'.repeat(300) + '.uz/very/long/path' },
    ok: true, result: {}, durationMs: 1_000,
  })
  assert.equal(long.includes('\n'), false)
  assert.ok(visibleWidth(long) < 100, `бейдж шире окна: ${visibleWidth(long)}`)
})

// Известные инструменты описываются своими словами, незнакомый — хотя бы именем: молчать нельзя.
check(() => assert.ok(toolBadge({ name: 'fs_export', args: {}, ok: true, result: { path: '/tmp/leads.csv', bytes: 2458 }, durationMs: 5 }).includes('leads.csv')))
check(() => assert.ok(toolBadge({ name: 'fs_export', args: {}, ok: true, result: { path: 'a.csv', bytes: 2458 }, durationMs: 5 }).includes('2.4 КБ')))
check(() => assert.ok(toolBadge({ name: 'своё_имя', args: {}, ok: true, result: {}, durationMs: 5 }).includes('своё_имя')))

check(() => assert.equal(seconds(1_800), '1.8 с'))
check(() => assert.equal(humanBytes(0), '0 Б'))
check(() => assert.equal(humanBytes(2458), '2.4 КБ'))
check(() => assert.equal(humanBytes(-1), '?', 'отрицательный размер — это сбой, а не «0 Б»'))
check(() => assert.equal(shortUrl('https://stomaservice.uz/'), 'stomaservice.uz'))
check(() => assert.ok(shortUrl('https://' + 'y'.repeat(80) + '.uz').length <= 44))

// «Думал N с» — тускло и одной строкой: это справка, а не событие.
check(() => assert.ok(thoughtBadge(1_800).includes('1.8 с')))

/*
 * СВОДКА ЦЕПОЧКИ появляется от трёх вызовов.
 *
 * На двух она дублирует то, что человек уже прочитал двумя строками выше. С третьей начинается
 * список, который хочется свернуть.
 */
check(() => assert.equal(groupSummary([{ name: 'fs_export', args: {}, ok: true, durationMs: 1 }]), null))
check(() => assert.equal(groupSummary([
  { name: 'fs_export', args: {}, ok: true, durationMs: 1 },
  { name: 'search_leads', args: {}, ok: true, durationMs: 1 },
]), null))
check(() => {
  const summary = groupSummary([
    { name: 'browser_navigate_and_extract', args: {}, ok: true, durationMs: 1 },
    { name: 'fs_export', args: {}, ok: true, durationMs: 1 },
    { name: 'fs_export', args: {}, ok: true, durationMs: 1 },
  ])
  assert.ok(summary.includes('×2'), 'повторы не свёрнуты: ' + summary)
  assert.equal(summary.includes('\n'), false, 'сводка заняла больше одной строки')
})
// Отказ в сводке назван отдельно: растворённый среди успехов, он успокаивает зря.
check(() => {
  const summary = groupSummary([
    { name: 'fs_export', args: {}, ok: true, durationMs: 1 },
    { name: 'fs_export', args: {}, ok: true, durationMs: 1 },
    { name: 'telegram_send_lead', args: {}, ok: false, error: 'x', durationMs: 1 },
  ])
  assert.ok(summary.includes('отказов 1'), summary)
})

// Бегущая строка называет, ЧТО именно делается: «search_leads» человеку ничего не сообщает.
check(() => assert.ok(runningLabel('search_leads', { query: 'клиники', city: 'Ташкент' }).includes('клиники')))
check(() => assert.ok(runningLabel('browser_navigate_and_extract', { url: 'https://a.uz' }).includes('a.uz')))
// Город через разделитель: подставлять предлог к имени в именительном падеже даёт «в Ташкент».
check(() => assert.equal(runningLabel('search_leads', { query: 'клиники', city: 'Ташкент' }).includes('в Ташкент'), false))

// Перед бейджем нужен перевод строки — но только если до этого шёл текст, иначе бейдж приклеивается
// к последнему слову ответа.
check(() => {
  let out = ''
  const renderer = createRenderer((text) => { out += text }, () => {}, () => ({ silence: () => {} }))
  renderer.onEvent({ type: 'text', delta: 'Сейчас поищу.' })
  renderer.onEvent({ type: 'tool_start', name: 'search_leads', args: { query: 'кофейни' }, step: 1 })
  assert.ok(out.includes('Сейчас поищу.\n'), 'бейдж приклеился к тексту')
})
check(() => {
  let out = ''
  const renderer = createRenderer((text) => { out += text }, () => {}, () => ({ silence: () => {} }))
  renderer.onEvent({ type: 'error', message: 'сеть недоступна' })
  assert.ok(out.includes('сеть недоступна'))
})

// ─── Поток OpenRouter ─────────────────────────────────────────────────────────────────────────────

/** Ответ сервера событиями SSE, разрезанный на куски по границам, которые ломают наивный разбор. */
function sseResponse(chunks) {
  return {
    ok: true,
    body: {
      getReader() {
        let index = 0
        return {
          read: async () => index < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[index++]) }
            : { done: true, value: undefined },
        }
      },
    },
  }
}

await checkAsync(async () => {
  const stream = createOpenRouterStream({
    apiKey: 'k',
    // Разрез ПОСРЕДИ строки данных: именно так приходит поток по сети, и наивный разбор здесь
    // получает обрезанный JSON и обрывает ответ на середине.
    fetchImpl: async () => sseResponse([
      // Разрез ПОСРЕДИ строки данных и ПОСРЕДИ слова: границы кусков определяет сеть, а не формат.
      'data: {"choices":[{"delta":{"content":"При',
      'вет"}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_leads","arg',
      'uments":"{\\"query\\":\\"кофейни\\"}"}}]}}]}\ndata: [DONE]\n',
    ]),
  })
  const collected = []
  for await (const chunk of stream([], [], new AbortController().signal)) collected.push(chunk)
  assert.ok(collected.some((one) => one.kind === 'text' && one.delta === 'Привет'))
  const toolDelta = collected.find((one) => one.kind === 'tool_delta')
  assert.equal(toolDelta.name, 'search_leads')
  assert.equal(toolDelta.argsDelta, '{"query":"кофейни"}')
  assert.equal(toolDelta.index, 0)
})

// Отказ сервера объясняется телом ответа: «OpenRouter ответил 401» без подробностей чинится дольше.
await checkAsync(async () => {
  const stream = createOpenRouterStream({
    apiKey: 'k',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'no credits', body: null }),
  })
  await assert.rejects(async () => {
    for await (const _ of stream([], [], new AbortController().signal)) { /* до первого фрагмента */ }
  }, /401.*no credits/s)
})

console.log(`[OK] Agent runtime behaviour: ${checks} assertions`)
