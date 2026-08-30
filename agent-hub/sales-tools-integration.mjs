// Инструменты разбора звонка и автодозвона — ЦЕЛИКОМ, от реестра до ответа модели.
//
// Модульные проверки лежат отдельно (sales-qa-behavior, dialer-behavior) и стерегут чистые функции.
// Здесь проверяется то, чего они увидеть не могут: попал ли инструмент в реестр, с каким правом, кому
// он выдан по роли и что вернётся, когда МОДЕЛЬ СОВРЁТ.
//
// Два разрыва, которые закрываются именно тут:
//
//   1. Верификатор цитат работает — но если его результат не доходит до ответа инструмента, наверху
//      всё равно окажется красивая оценка. Проверяется сквозь: выдуманная цитата → ноль в итоге.
//   2. Запреты набора работают — но если dialer_queue_lead зарегистрирован как read_only, реестр
//      выполнит его без подтверждения, и все запреты внутри окажутся за уже открытой дверью.

import assert from 'node:assert/strict'
import { ToolRegistry, restrictRegistry } from './tools/registry.ts'
import { buildAnalyzeCallTool, buildDialerQueueTool, buildDialerStatusTool } from './tools/sales-tools.ts'
import { buildPlatformRegistry } from './tools/platform.ts'
import { Dialer } from './modules/dialer/queue.ts'
import { buildDialer } from './modules/dialer/from-env.ts'
import { DEFAULT_PLAYBOOK, PlaybookCatalog } from './modules/sales-qa/playbook.ts'
import { AGENT_ROLES } from './cli/roles.ts'

let checks = 0
const check = (fn) => { fn(); checks++ }
const checkAsync = async (fn) => { await fn(); checks++ }

const TRANSCRIPT = [
  '0:02 Менеджер: Здравствуйте, меня зовут Азиз, компания «Каскад», звоню по заявке с сайта.',
  '0:09 Клиент: Да, здравствуйте.',
  '0:11 Менеджер: Вам удобно сейчас говорить пару минут?',
  '0:14 Клиент: Да, говорите.',
  '0:18 Менеджер: Расскажите, какую задачу вы сейчас решаете со складом?',
  '0:25 Клиент: У нас теряются остатки между магазином и складом.',
  '0:40 Менеджер: Тогда начнём с синхронизации остатков — это как раз про потерю между точками.',
  '1:05 Клиент: Дорого, наверное.',
  '1:08 Менеджер: Понимаю. Давайте посчитаем на ваших объёмах, сколько стоит сама потеря.',
  '1:30 Менеджер: Договорились: в четверг в 11:00 я пришлю расчёт и наберу вас.',
].join('\n')

/**
 * Настоящие цитаты — по одной на каждый этап, вместе с ОТМЕТКОЙ, в которой они сказаны.
 *
 * Отметка обязана быть верной: доказательство проверяется не только на наличие слов в расшифровке,
 * но и на то, что они сказаны в названный момент.
 */
const REAL = {
  1: ['меня зовут Азиз, компания «Каскад»', '0:02'],
  2: ['Вам удобно сейчас говорить пару минут?', '0:11'],
  3: ['какую задачу вы сейчас решаете со складом', '0:18'],
  4: ['начнём с синхронизации остатков', '0:40'],
  5: ['Давайте посчитаем на ваших объёмах', '1:08'],
  // Внутри фразы стоит «11:00» — время, названное в речи. Разметкой оно не считается, иначе цитата
  // разорвалась бы посередине.
  6: ['в четверг в 11:00 я пришлю расчёт', '1:30'],
}

/** Выдумка: гладко, правдоподобно, в расшифровке этого нет. */
const FAKE = 'Я подготовлю коммерческое предложение до конца недели'

/** Все шесть этапов «выполнены». Цитату и отметку задаёт вызывающий. */
const stagesAll = (evidenceFor) => [1, 2, 3, 4, 5, 6].map((id) => {
  const [quote, timestamp] = evidenceFor(id)
  return { stageId: id, status: 'done', score: 3, evidence: { quote, timestamp }, note: '' }
})

/** Честное доказательство этапа. */
const real = (id) => REAL[id]
/** Выдумка с правдоподобной отметкой. */
const fake = (id) => [FAKE, REAL[id][1]]

/** Заглушка модели: отдаёт заготовленные ответы по порядку и считает вызовы. */
const scriptedModel = (...answers) => {
  const calls = []
  const ask = async (prompt) => {
    calls.push(prompt)
    return answers[Math.min(calls.length - 1, answers.length - 1)]
  }
  ask.calls = calls
  return ask
}

const asJson = (payload) => JSON.stringify(payload)

// ── ПРАВА: набор номера не должен уметь пройти как чтение ─────────────────────────────────────────

check(() => {
  const dialer = new Dialer({ salt: 's' })
  assert.equal(buildAnalyzeCallTool({ ask: async () => '{}' }).permission, 'read_only')
  assert.equal(buildDialerStatusTool({ dialer }).permission, 'read_only')
  // Ради этой строки написан весь файл: 'read_only' здесь означал бы обзвон без подтверждения.
  assert.equal(buildDialerQueueTool({ dialer }).permission, 'action')
})

// Реестр отказывает в постановке в очередь, пока право не выдано ИМЕННО этому инструменту.
await checkAsync(async () => {
  const dialer = new Dialer({ salt: 's', settings: { enabled: true } })
  const reg = new ToolRegistry().register(buildDialerQueueTool({ dialer }))

  const denied = await reg.call('dialer_queue_lead', { lead_id: 'L1', phone: '+998901234567' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'permission_denied')

  // Право на соседнее действие не открывает это: список сверяется по имени.
  const other = await reg.call('dialer_queue_lead', { lead_id: 'L1', phone: '+998901234567' }, { allowedActions: ['telegram_send_lead'] })
  assert.equal(other.code, 'permission_denied')
})

// Отказ по праву наступает ДО разбора аргументов: иначе сообщение об ошибке подсказывает, как
// подобрать поля к запрещённому действию.
await checkAsync(async () => {
  const dialer = new Dialer({ salt: 's', settings: { enabled: true } })
  const reg = new ToolRegistry().register(buildDialerQueueTool({ dialer }))
  const outcome = await reg.call('dialer_queue_lead', { мусор: 1 })
  assert.equal(outcome.code, 'permission_denied')
})

// Чтение состояния права не требует — иначе человек не сможет узнать, что творится в очереди.
await checkAsync(async () => {
  const dialer = new Dialer({ salt: 's' })
  const reg = new ToolRegistry().register(buildDialerStatusTool({ dialer }))
  const outcome = await reg.call('dialer_status', {})
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result.mode, 'симуляция')
})

// ── СКВОЗНАЯ ПРОВЕРКА ЦИТАТ: враньё модели не должно доехать до ответа ────────────────────────────

await checkAsync(async () => {
  const ask = scriptedModel(asJson({
    stages: stagesAll(fake),
    criteria: [{ code: 'clarity', score: 3, evidence: null, note: '' }],
    summary: 'Отличный разговор, менеджер провёл все этапы.',
    recommendations: ['Так держать'],
  }))
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})

  assert.equal(out.scorePercent, 0, 'шесть выдуманных цитат не дают ни одного балла')
  assert.equal(out.unconfirmed.length, 6)
  assert.ok(out.stages.every((one) => one.status === 'unverified' && one.evidence === null))
  // Пересказ модели остаётся, но балл ему не подчиняется: человек видит и слова, и ноль рядом.
  assert.match(out.summary, /Отличный разговор/)
})

// Честный разбор проходит целиком — иначе проверка «всё обнуляй» была бы бессмысленно строгой.
await checkAsync(async () => {
  const ask = scriptedModel(asJson({
    stages: stagesAll(real),
    criteria: [{ code: 'listening', score: 3, evidence: { quote: REAL[3][0], timestamp: REAL[3][1] }, note: '' }],
    summary: 'Разговор проведён по сценарию.',
    recommendations: [],
  }))
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})

  assert.equal(out.scorePercent, 100)
  assert.equal(out.unconfirmed.length, 0)
  assert.equal(ask.calls.length, 1, 'подтверждённый разбор не требует второго прохода')
})

// Смешанный случай: подтверждается ровно то, что подтвердилось. Веса 1,1,2,2,1,2 — сумма 9.
// Подтверждены этапы 1 и 6 на 3 балла: (1*3 + 2*3) / (9*3) = 9/27 = 33 %.
await checkAsync(async () => {
  const honest = new Set([1, 6])
  const ask = scriptedModel(asJson({
    stages: stagesAll((id) => (honest.has(id) ? real(id) : fake(id))),
    criteria: [],
  }), asJson({ stages: stagesAll((id) => (honest.has(id) ? real(id) : fake(id))), criteria: [] }))
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})

  assert.equal(out.scorePercent, 33)
  assert.deepEqual(out.unconfirmed.map((one) => one.stageId), [2, 3, 4, 5])
  assert.deepEqual(out.weakStages, [2, 3, 4, 5])
})

// «Частично» — та же дверь, и она тоже закрыта. Без этого модель просто перестала бы писать «done».
await checkAsync(async () => {
  const ask = scriptedModel(asJson({
    stages: [{ stageId: 1, status: 'partial', score: 2, evidence: { quote: FAKE, timestamp: '0:02' }, note: '' }],
    criteria: [],
  }))
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})
  assert.equal(out.stages.find((one) => one.stageId === 1).status, 'unverified')
  assert.equal(out.scorePercent, 0)
})

// ── ВТОРОЙ ПРОХОД: шанс исправиться, а не право быть принятым на слово ────────────────────────────

// Модель соврала, ей вернули список неподтверждённого — и она нашла настоящие цитаты. Берём лучшее.
await checkAsync(async () => {
  const ask = scriptedModel(
    asJson({ stages: stagesAll(fake), criteria: [] }),
    asJson({ stages: stagesAll(real), criteria: [] }),
  )
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})

  assert.equal(ask.calls.length, 2)
  assert.match(ask.calls[1], /ПРЕДЫДУЩИЙ ОТВЕТ ОТКЛОНЁН ЧАСТИЧНО/)
  assert.match(ask.calls[1], /этап 3/)
  assert.equal(out.scorePercent, 100)
  assert.equal(out.unconfirmed.length, 0)
})

// Модель соврала дважды — второй ответ НЕ принимается, даже если написан увереннее.
await checkAsync(async () => {
  const ask = scriptedModel(
    asJson({ stages: stagesAll(fake), criteria: [], summary: 'первый' }),
    asJson({ stages: stagesAll((id) => [`${FAKE} точно`, REAL[id][1]]), criteria: [], summary: 'второй, ещё убедительнее' }),
  )
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})
  assert.equal(out.scorePercent, 0)
  assert.equal(out.unconfirmed.length, 6)
})

// Второй проход, ухудшивший результат, отбрасывается: иначе повторная попытка могла бы СНЯТЬ уже
// подтверждённый этап и оценка зависела бы от настроения модели.
await checkAsync(async () => {
  const ask = scriptedModel(
    asJson({ stages: stagesAll((id) => (id === 1 ? real(1) : fake(id))), criteria: [] }),
    asJson({ stages: stagesAll(fake), criteria: [] }),
  )
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})
  assert.equal(out.stages.find((one) => one.stageId === 1).status, 'done')
  assert.equal(out.unconfirmed.length, 5)
})

// Второй проход упал по сети — первый отчёт обязан уцелеть. Уточнение не должно превращаться в
// источник отказов: к моменту его отправки пригодный отчёт уже есть.
await checkAsync(async () => {
  let call = 0
  const ask = async () => {
    call += 1
    if (call === 1) return asJson({ stages: stagesAll((id) => (id === 1 ? real(1) : fake(id))), criteria: [] })
    throw new Error('ECONNRESET')
  }
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})
  assert.equal(call, 2)
  assert.equal(out.stages.find((one) => one.stageId === 1).status, 'done')
  assert.equal(out.unconfirmed.length, 5)
  // Второго ОТВЕТА не было, и отчёт об этом честен: поле означает «уточнение состоялось», а не
  // «уточнение отправлено».
  assert.equal(out.secondPass, false)
  assert.equal(out.error, undefined, 'неудачное уточнение превратилось в отказ инструмента')
})

/*
 * Второй проход, «улучшивший» отчёт объявлением этапов неприменимыми, НЕ принимается.
 *
 * По числу неподтверждённых он действительно лучше — их ноль. По сути это оценка из ничего: модель
 * просто вынесла всё, что не смогла подтвердить, из знаменателя.
 */
await checkAsync(async () => {
  const ask = scriptedModel(
    asJson({ stages: stagesAll((id) => (id === 1 ? real(1) : fake(id))), criteria: [] }),
    asJson({
      stages: [
        { stageId: 1, status: 'done', score: 3, evidence: { quote: REAL[1][0], timestamp: REAL[1][1] }, note: '' },
        ...[2, 3, 4, 5, 6].map((id) => ({ stageId: id, status: 'not_applicable', score: 0, evidence: null, note: '' })),
      ],
      criteria: [],
    }),
  )
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})
  assert.equal(out.unconfirmed.length, 5, 'принят ответ, вынесший неподтверждённое из знаменателя')
  assert.equal(out.stages.filter((one) => one.status === 'not_applicable').length, 0)
})

// Огромная расшифровка второго прохода не получает: он отправляет её заново, то есть удваивает
// входные токены, а подтверждённых этапов прибавляет один-два.
await checkAsync(async () => {
  const padding = `\n9:59 Клиент: ${'да, понятно. '.repeat(4000)}`
  const ask = scriptedModel(asJson({ stages: stagesAll(fake), criteria: [] }))
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT + padding }, {})
  assert.ok(TRANSCRIPT.length + padding.length > 40_000)
  assert.equal(ask.calls.length, 1, 'на огромной расшифровке сделан второй проход')
  assert.equal(out.secondPass, false)
  assert.equal(out.scorePercent, 0)
})

// Сигнал прерывания доходит до модели: без него истёкший таймаут инструмента снимает ожидание, а
// запрос продолжает идти и тратить деньги за ответ, которого никто не ждёт.
await checkAsync(async () => {
  const seen = []
  const ask = async (_prompt, signal) => {
    seen.push(signal)
    return asJson({ stages: stagesAll(real), criteria: [] })
  }
  const controller = new AbortController()
  await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, { signal: controller.signal })
  assert.equal(seen[0], controller.signal, 'модель вызвана без сигнала прерывания')
})

// ── ОТВЕТ МОДЕЛИ НЕ ВСЕГДА JSON ───────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const body = asJson({ stages: stagesAll(real), criteria: [] })
  const ask = scriptedModel(`Вот разбор:\n\`\`\`json\n${body}\n\`\`\`\nГотов пояснить.`)
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})
  assert.equal(out.scorePercent, 100)
})

// Разметка блока бывает какой угодно. Терять готовый разбор из-за трёх лишних букв нельзя.
await checkAsync(async () => {
  const body = asJson({ stages: stagesAll(real), criteria: [] })
  for (const fence of ['```', '```JSON', '```text', '```json ']) {
    const ask = scriptedModel(`Разбор:\n${fence}\n${body}\n\`\`\`\nГотово.`)
    const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})
    assert.equal(out.scorePercent, 100, `не разобрано при разметке ${fence}`)
  }
})

// Блок разобран РАЗМЕТКОЙ, а не «от первой скобки до последней»: модель дописывает пояснение, и в
// нём тоже бывают скобки. Срез по скобкам захватил бы и пояснение — и разбор пропал бы целиком.
await checkAsync(async () => {
  const body = asJson({ stages: stagesAll(real), criteria: [] })
  const ask = scriptedModel(
    `Разбор ниже.\n\`\`\`text\n${body}\n\`\`\`\nОтдельно отмечу: этап {4} стоит переслушать {с 0:40}.`,
  )
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})
  assert.equal(out.scorePercent, 100)
})

/*
 * Объект неверной ФОРМЫ — тоже отказ, а не исключение.
 *
 * `{"stages":{}}` формально объект. Разбор по нему падал на попытке пройтись по stages, и вместо
 * честного «модель вернула не то» человек получал исключение, читаемое как поломка платформы.
 */
await checkAsync(async () => {
  for (const answer of ['{"stages":{},"criteria":[]}', '{"criteria":[]}', '{"stages":"нет"}']) {
    const out = await buildAnalyzeCallTool({ ask: scriptedModel(answer) }).execute({ transcript: TRANSCRIPT }, {})
    assert.ok(out.error, `${answer} принят за отчёт`)
  }
})

/*
 * Второй проход сравнивается по ВЕСУ исключённого, а не по количеству.
 *
 * В сценарии с несколькими условными этапами можно исключить лёгкий и вместо него тяжёлый:
 * количество то же, знаменатель заметно меньше, итог выше.
 */
await checkAsync(async () => {
  const catalog = new PlaybookCatalog([{
    id: 'два-условных', title: 'Два условных этапа', language: 'ru',
    stages: [
      { id: 1, title: 'Представление', expectation: 'Менеджер представился.', weight: 1 },
      { id: 2, title: 'Лёгкий условный', expectation: 'Может не случиться.', weight: 1, optional: true },
      { id: 3, title: 'Тяжёлый условный', expectation: 'Тоже может не случиться.', weight: 5, optional: true },
    ],
    criteria: [],
  }])
  const done = { stageId: 1, status: 'done', score: 3, evidence: { quote: REAL[1][0], timestamp: REAL[1][1] }, note: '' }
  const na = (id) => ({ stageId: id, status: 'not_applicable', score: 0, evidence: null, note: '' })
  const missed = (id) => ({ stageId: id, status: 'missed', score: 0, evidence: null, note: '' })

  /*
   * ЧИСЛО ИСКЛЮЧЁННЫХ ЭТАПОВ В ОБОИХ ОТВЕТАХ ОДИНАКОВО — РОВНО ОДИН.
   *
   * Иначе проверка не различала бы сравнение по весу и по количеству: она отвергала бы второй ответ
   * при любом из двух правил, и подмена лёгкого этапа тяжёлым осталась бы незамеченной.
   */
  const ask = scriptedModel(
    // Первый: исключён ЛЁГКИЙ условный (вес 1), тяжёлый заявлен без цитаты.
    asJson({
      stages: [done, na(2), { stageId: 3, status: 'done', score: 3, evidence: { quote: FAKE, timestamp: '0:11' }, note: '' }],
      criteria: [],
    }),
    // Второй: неподтверждённых нет — но из знаменателя вынесен ТЯЖЁЛЫЙ (вес 5) вместо лёгкого.
    // Исключённых по-прежнему один. По количеству это «лучше», по весу — оценка из ничего.
    asJson({ stages: [done, missed(2), na(3)], criteria: [] }),
  )
  const out = await buildAnalyzeCallTool({ ask, catalog }).execute({ transcript: TRANSCRIPT, playbook_id: 'два-условных' }, {})
  assert.equal(out.unconfirmed.length, 1, 'принят ответ, обменявший лёгкий исключённый этап на тяжёлый')
  assert.equal(out.stages.find((one) => one.stageId === 3).status, 'unverified')
})

// JSON.parse принимает и строку, и число, и null — отчётом они не становятся. Проверяется и без
// разметки (там просто нет фигурных скобок), и внутри блока — там разбор доходит до значения.
await checkAsync(async () => {
  const answers = ['"готово"', '42', 'null', '[]', '```json\n"готово"\n```', '```json\nnull\n```', '```json\n42\n```']
  for (const answer of answers) {
    const out = await buildAnalyzeCallTool({ ask: scriptedModel(answer) }).execute({ transcript: TRANSCRIPT }, {})
    assert.ok(out.error, `${JSON.stringify(answer)} принят за отчёт`)
    assert.equal(out.scorePercent, undefined)
  }
})

// Не-JSON возвращается ОШИБКОЙ, а не пустым отчётом: пустой отчёт — это ноль процентов, и менеджера
// накажут за сбой разбора.
await checkAsync(async () => {
  const ask = scriptedModel('Извините, расшифровка слишком короткая.')
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT }, {})
  assert.ok(out.error)
  assert.equal(out.scorePercent, undefined)
})

// Незнакомый сценарий — отказ со списком доступных, а не молчаливый переход на базовый.
await checkAsync(async () => {
  const ask = scriptedModel('{}')
  const out = await buildAnalyzeCallTool({ ask }).execute({ transcript: TRANSCRIPT, playbook_id: 'нет-такого' }, {})
  assert.match(out.error, /нет-такого/)
  assert.deepEqual(out.available.map((one) => one.id), [DEFAULT_PLAYBOOK.id])
  assert.equal(ask.calls.length, 0, 'модель не спрашивают, пока сценарий не найден')
})

// Сценарий заказчика подхватывается по идентификатору, а не подменяется базовым.
await checkAsync(async () => {
  const catalog = new PlaybookCatalog([DEFAULT_PLAYBOOK, {
    id: 'support-ru', title: 'Обращение в поддержку', language: 'ru',
    stages: [{ id: 1, title: 'Приветствие', expectation: 'Оператор представился.', weight: 1 }],
    criteria: [{ code: 'tone', title: 'Тон', expectation: 'Вежливо.' }],
  }])
  const ask = scriptedModel(asJson({
    stages: [{ stageId: 1, status: 'done', score: 3, evidence: { quote: REAL[1][0], timestamp: REAL[1][1] }, note: '' }],
    criteria: [],
  }))
  const out = await buildAnalyzeCallTool({ ask, catalog }).execute({ transcript: TRANSCRIPT, playbook_id: 'support-ru' }, {})
  assert.equal(out.playbook.id, 'support-ru')
  assert.equal(out.scorePercent, 100)
  assert.match(ask.calls[0], /Обращение в поддержку/)
})

// ── АВТОДОЗВОН СКВОЗЬ ИНСТРУМЕНТ ──────────────────────────────────────────────────────────────────

const PHONE = '+998901234567'
const inHours = () => new Date('2026-08-20T09:00:00Z') // 14:00 в Ташкенте
const okDialer = (extra = {}) => {
  const dialer = new Dialer({ salt: 'соль', now: inHours, settings: { enabled: true, ...extra } })
  dialer.allow(PHONE)
  return dialer
}

// Из коробки — отказ. Даже с правом на действие и в рабочие часы.
await checkAsync(async () => {
  const dialer = new Dialer({ salt: 'соль', now: inHours })
  const out = await buildDialerQueueTool({ dialer }).execute({ lead_id: 'L1', phone: PHONE }, {})
  assert.equal(out.queued, false)
  assert.equal(out.reason, 'disabled')
  assert.equal(dialer.status().queue.length, 0)
})

// Включено, но номера нет в белом списке — отказ. Белый список включён по умолчанию.
await checkAsync(async () => {
  const dialer = new Dialer({ salt: 'соль', now: inHours, settings: { enabled: true } })
  const out = await buildDialerQueueTool({ dialer }).execute({ lead_id: 'L1', phone: PHONE }, {})
  assert.equal(out.reason, 'not_allowlisted')
  assert.equal(out.detail, '***4567', 'в отказе только последние цифры')
})

// Разрешённый номер встаёт в очередь — и остаётся симуляцией, пока человек не подтвердил.
await checkAsync(async () => {
  const dialer = okDialer()
  const out = await buildDialerQueueTool({ dialer }).execute({ lead_id: 'L1', phone: PHONE }, {})
  assert.equal(out.queued, true)
  assert.equal(out.mode, 'симуляция')
  assert.equal(out.phone, '***4567')
  assert.equal(JSON.stringify(out).includes('998901234567'), false, 'полного номера в ответе нет')
})

// Инструмент НЕ УМЕЕТ включать боевой режим: у него нет такого поля, а лишнее поле отсекает схема.
await checkAsync(async () => {
  const dialer = okDialer({ dryRun: false })
  const reg = new ToolRegistry().register(buildDialerQueueTool({ dialer }))
  const out = await reg.call(
    'dialer_queue_lead',
    { lead_id: 'L1', phone: PHONE, confirmation: 'ЗВОНИТЬ ПО-НАСТОЯЩЕМУ', live: true },
    { allowedActions: ['dialer_queue_lead'] },
  )
  assert.equal(out.ok, true)
  assert.equal(out.result.mode, 'симуляция', 'подтверждение через аргументы модели не проходит')
  assert.equal(dialer.status().canPlaceRealCalls, false)
})

// Даже когда человек подтвердил и симуляция снята, без способа набора звонков не будет — и очередь
// честно скажет «симуляция», а не сделает вид, что дозванивается.
await checkAsync(async () => {
  const dialer = okDialer({ dryRun: false })
  assert.equal(dialer.confirmLiveMode('ЗВОНИТЬ ПО-НАСТОЯЩЕМУ'), true)
  const out = await buildDialerStatusTool({ dialer }).execute({}, {})
  assert.equal(out.canPlaceRealCalls, false)
  assert.equal(out.mode, 'симуляция')
})

// Способ набора ЕСТЬ, симуляция снята — и всё равно «симуляция», пока человек не подтвердил фразой.
// Это единственный случай, где подтверждение остаётся последним запретом: остальные уже сняты.
await checkAsync(async () => {
  const placed = []
  let clock = inHours()
  const dialer = new Dialer({
    salt: 'соль', now: () => clock, settings: { enabled: true, dryRun: false },
    place: async (input) => { placed.push(input.leadId); return { ok: true, externalId: 'call_1' } },
  })
  dialer.allow(PHONE)

  const queued = await buildDialerQueueTool({ dialer }).execute({ lead_id: 'L1', phone: PHONE }, {})
  assert.equal(queued.mode, 'симуляция')
  assert.equal((await buildDialerStatusTool({ dialer }).execute({}, {})).canPlaceRealCalls, false)

  // И проверка не декоративная: прогон очереди не должен ничего набрать.
  const run = await dialer.run(new Map([['L1', PHONE]]))
  assert.equal(run.placed, 0)
  assert.equal(run.simulated, 1)
  assert.deepEqual(placed, [], 'без подтверждения человеком набора не происходит')

  // После подтверждения — набирает. Иначе запрет был бы просто поломкой.
  // Часы сдвигаются: симуляция засчитала попытку, и пауза между попытками теперь настоящая.
  assert.equal(dialer.confirmLiveMode('ЗВОНИТЬ ПО-НАСТОЯЩЕМУ'), true)
  clock = new Date(clock.getTime() + 3 * 3_600_000)
  const next = await buildDialerQueueTool({ dialer }).execute({ lead_id: 'L2', phone: PHONE }, {})
  assert.equal(next.mode, 'боевой')
  const run2 = await dialer.run(new Map([['L2', PHONE]]))
  assert.equal(run2.placed, 1)
  assert.deepEqual(placed, ['L2'])
})

// Неверная фраза подтверждения НЕ включает боевой режим и не притворяется, что включила.
await checkAsync(async () => {
  const dialer = new Dialer({
    salt: 'соль', now: inHours, settings: { enabled: true, dryRun: false },
    place: async () => ({ ok: true, externalId: 'x' }),
  })
  dialer.allow(PHONE)
  assert.equal(dialer.confirmLiveMode('да'), false)
  assert.equal(dialer.confirmLiveMode('ЗВОНИТЬ'), false)
  const out = await buildDialerStatusTool({ dialer }).execute({}, {})
  assert.equal(out.liveConfirmed, false)
  assert.equal(out.mode, 'симуляция')
})

/*
 * СУТОЧНЫЙ ПРЕДЕЛ РАБОТАЕТ ИМЕННО ЧЕРЕЗ ИНСТРУМЕНТ.
 *
 * Это главный случай, ради которого проверка стоит здесь, а не только в модульном наборе. У
 * dialer_queue_lead нет и не должно быть полей «попыток сегодня» и «когда звонили в прошлый раз»:
 * их прислала бы модель. Пока их считал вызывающий, оба ограничения через инструмент не работали
 * никогда — проверка выполнялась, видела ноль и пропускала.
 */
await checkAsync(async () => {
  let clock = inHours()
  const dialer = new Dialer({
    salt: 'соль', now: () => clock,
    settings: { enabled: true, maxDailyAttempts: 2, minRetryIntervalHours: 1 },
  })
  dialer.allow(PHONE)
  const tool = buildDialerQueueTool({ dialer })
  const queue = (lead) => tool.execute({ lead_id: lead, phone: PHONE }, {})

  assert.equal((await queue('L1')).queued, true)
  await dialer.run(new Map([['L1', PHONE]]))

  const tooSoon = await queue('L2')
  assert.equal(tooSoon.reason, 'too_soon', 'пауза между попытками не работает через инструмент')

  clock = new Date(clock.getTime() + 2 * 3_600_000)
  assert.equal((await queue('L3')).queued, true)
  await dialer.run(new Map([['L3', PHONE]]))

  clock = new Date(clock.getTime() + 2 * 3_600_000)
  const limited = await queue('L4')
  assert.equal(limited.reason, 'daily_limit', 'суточный предел не работает через инструмент')
  assert.equal(limited.detail, '2')
})

// Состояние очереди не отдаёт номеров целиком — его показывают человеку и пишут в журнал.
await checkAsync(async () => {
  const dialer = okDialer()
  await buildDialerQueueTool({ dialer }).execute({ lead_id: 'L1', phone: PHONE }, {})
  const out = await buildDialerStatusTool({ dialer }).execute({}, {})
  assert.equal(JSON.stringify(out).includes('998901234567'), false)
  assert.equal(out.queue[0].phone, '***4567')
})

// ── СБОРКА ИЗ ОКРУЖЕНИЯ: сомнение читается как «не звонить» ───────────────────────────────────────

// Без соли автодозвона нет вовсе. Соль нужна не для красоты: без неё белый список пришлось бы
// хранить открытыми номерами — перечнем людей, которым собираются звонить.
check(() => {
  assert.equal(buildDialer({}), null)
  assert.equal(buildDialer({ NEMO_DIALER_SALT: '   ' }), null)
  assert.equal(buildDialer({ NEMO_DIALER_ENABLED: '1', NEMO_DIALER_ALLOWLIST: PHONE }), null)
})

// Соль есть — автодозвон собирается, но ВЫКЛЮЧЕННЫМ и в симуляции.
check(() => {
  const dialer = buildDialer({ NEMO_DIALER_SALT: 'с' })
  assert.equal(dialer.settings.enabled, false)
  assert.equal(dialer.settings.dryRun, true)
  assert.equal(dialer.settings.allowlistOnly, true)
  assert.equal(dialer.status().mode, 'симуляция')
})

// «Включено» — только явное согласие. `0`, `нет`, пустая строка и мусор включением не считаются.
check(() => {
  for (const value of ['1', 'true', 'YES', 'да']) {
    assert.equal(buildDialer({ NEMO_DIALER_SALT: 'с', NEMO_DIALER_ENABLED: value }).settings.enabled, true, value)
  }
  for (const value of ['0', 'false', 'нет', '', ' ', 'off', 'вкл']) {
    assert.equal(buildDialer({ NEMO_DIALER_SALT: 'с', NEMO_DIALER_ENABLED: value }).settings.enabled, false, value)
  }
})

// Симуляция снимается ТОЛЬКО точным false. Опечатка в значении не должна снимать защиту.
check(() => {
  assert.equal(buildDialer({ NEMO_DIALER_SALT: 'с', NEMO_DIALER_DRY_RUN: 'false' }).settings.dryRun, false)
  for (const value of ['0', 'no', 'нет', '', 'fasle', 'true', undefined]) {
    assert.equal(buildDialer({ NEMO_DIALER_SALT: 'с', NEMO_DIALER_DRY_RUN: value }).settings.dryRun, true, String(value))
  }
})

// Белый список хранится отпечатками: полного номера в объекте нет ни в каком виде.
await checkAsync(async () => {
  const dialer = buildDialer({
    NEMO_DIALER_SALT: 'с', NEMO_DIALER_ENABLED: '1',
    NEMO_DIALER_ALLOWLIST: `${PHONE}, +998 90 111 22 33; +998901112234`,
  }, { now: inHours })
  assert.equal(dialer.status().allowlistSize, 3)
  assert.equal(JSON.stringify(dialer.status()).includes('998901234567'), false)

  const out = await buildDialerQueueTool({ dialer }).execute({ lead_id: 'L1', phone: PHONE }, {})
  assert.equal(out.queued, true)
})

// Обрывок номера в белый список не попадает: разрешение звонить по нему — это разрешение звонить
// неизвестно куда.
check(() => {
  const dialer = buildDialer({ NEMO_DIALER_SALT: 'с', NEMO_DIALER_ALLOWLIST: '12345, +998901234567' })
  assert.equal(dialer.status().allowlistSize, 1)
})

/*
 * ПРОБЕЛ ВНУТРИ НОМЕРА — НЕ РАЗДЕЛИТЕЛЬ.
 *
 * Номера записывают с пробелами, и разбиение по пробелу превращает один номер в пять обрывков. Все
 * они короче семи цифр, все отсеиваются — и белый список оказывается пуст. Снаружи это выглядит как
 * «автодозвон почему-то никому не звонит», а не как ошибка разбора настройки.
 */
check(() => {
  const spaced = buildDialer({ NEMO_DIALER_SALT: 'с', NEMO_DIALER_ALLOWLIST: '+998 90 111 22 33' })
  assert.equal(spaced.status().allowlistSize, 1)

})

// Разрешение не зависит от того, КАК записан номер: в белом списке с пробелами, в лиде — слитно.
await checkAsync(async () => {
  const dialer = buildDialer(
    { NEMO_DIALER_SALT: 'с', NEMO_DIALER_ENABLED: '1', NEMO_DIALER_ALLOWLIST: '+998 90 111 22 33' },
    { now: inHours },
  )
  const out = await buildDialerQueueTool({ dialer }).execute({ lead_id: 'L1', phone: '998901112233' }, {})
  assert.equal(out.queued, true, 'один и тот же номер в двух записях дал разные отпечатки')
})

// Мусор в окне работы и в поясе — ОСТАНОВКА, а не молчаливое умолчание: человек уверен, что сузил
// окно, а оно осталось прежним, и это стоит звонка в шесть утра.
check(() => {
  /*
   * ОЖИДАЕМОЕ СООБЩЕНИЕ ПРОВЕРЯЕТСЯ РЕГУЛЯРКОЙ, А НЕ СТРОКОЙ.
   *
   * assert.throws со вторым аргументом-строкой считает её ПОЯСНЕНИЕМ к проверке, а не образцом
   * ошибки, и проходит на любом исключении. В таком виде проверка молча одобрила бы, например,
   * «Cannot read properties of null» — то есть падение вместо объяснения.
   */
  const bad = [
    [{ NEMO_DIALER_HOURS: '9-21' }, /NEMO_DIALER_HOURS.*9-21/],
    [{ NEMO_DIALER_HOURS: '09:00' }, /NEMO_DIALER_HOURS/],
    [{ NEMO_DIALER_HOURS: '25:00-26:00' }, /NEMO_DIALER_HOURS/],
    [{ NEMO_DIALER_HOURS: 'весь день' }, /NEMO_DIALER_HOURS/],
    [{ NEMO_DIALER_TIMEZONE: 'Asia/Ташкент' }, /NEMO_DIALER_TIMEZONE.*неизвестен/],
    [{ NEMO_DIALER_MAX_DAILY: 'три' }, /NEMO_DIALER_MAX_DAILY/],
    [{ NEMO_DIALER_MAX_DAILY: '-1' }, /NEMO_DIALER_MAX_DAILY/],
    [{ NEMO_DIALER_MAX_DAILY: '2.5' }, /NEMO_DIALER_MAX_DAILY/],
  ]
  for (const [extra, expected] of bad) {
    assert.throws(() => buildDialer({ NEMO_DIALER_SALT: 'с', ...extra }), expected)
  }
})

check(() => {
  const dialer = buildDialer({
    NEMO_DIALER_SALT: 'с', NEMO_DIALER_HOURS: '10:30-19:45',
    NEMO_DIALER_TIMEZONE: 'Europe/Moscow', NEMO_DIALER_MAX_DAILY: '5',
  })
  assert.equal(dialer.settings.workHoursStart, '10:30')
  assert.equal(dialer.settings.workHoursEnd, '19:45')
  assert.equal(dialer.settings.timeZone, 'Europe/Moscow')
  assert.equal(dialer.settings.maxDailyAttempts, 5)
})

// Чёрный список перевешивает белый: номер, попавший в оба, не набирается.
await checkAsync(async () => {
  const dialer = buildDialer({
    NEMO_DIALER_SALT: 'с', NEMO_DIALER_ENABLED: '1',
    NEMO_DIALER_ALLOWLIST: PHONE, NEMO_DIALER_BLOCKLIST: PHONE,
  }, { now: inHours })
  const out = await buildDialerQueueTool({ dialer }).execute({ lead_id: 'L1', phone: PHONE }, {})
  assert.equal(out.queued, false)
  assert.equal(out.reason, 'blacklisted')
})

// ── РЕЕСТР: ненастроенного инструмента не существует ──────────────────────────────────────────────

check(() => {
  const { registry, skipped } = buildPlatformRegistry({})
  assert.equal(registry.has('analyze_sales_call'), false)
  assert.equal(registry.has('dialer_queue_lead'), false)
  assert.equal(registry.has('dialer_status'), false)
  assert.ok(skipped.some((one) => one.startsWith('analyze_sales_call')))
  assert.ok(skipped.some((one) => one.startsWith('dialer_queue_lead')))
})

check(() => {
  const { registry } = buildPlatformRegistry({ askModel: async () => '{}', dialer: new Dialer({ salt: 's' }) })
  assert.equal(registry.has('analyze_sales_call'), true)
  assert.equal(registry.has('dialer_queue_lead'), true)
  assert.equal(registry.has('dialer_status'), true)
})

// Разбор звонка не зависит от браузера: без Playwright он всё равно доступен.
check(() => {
  const { registry } = buildPlatformRegistry({ askModel: async () => '{}' })
  assert.equal(registry.has('run_qa_audit'), false)
  assert.equal(registry.has('analyze_sales_call'), true)
})

// Модель видит только то, что ей разрешено сейчас: без права на действие очередь ей не показывают.
check(() => {
  const { registry } = buildPlatformRegistry({ askModel: async () => '{}', dialer: new Dialer({ salt: 's' }) })
  const visible = registry.describeForOpenRouter({}).map((one) => one.function.name)
  assert.ok(visible.includes('analyze_sales_call'))
  assert.ok(visible.includes('dialer_status'))
  assert.equal(visible.includes('dialer_queue_lead'), false)

  const withRight = registry.describeForOpenRouter({ allowedActions: ['dialer_queue_lead'] }).map((one) => one.function.name)
  assert.ok(withRight.includes('dialer_queue_lead'))
})

// ── РОЛИ: кому что досталось ──────────────────────────────────────────────────────────────────────

const fullRegistry = () => buildPlatformRegistry({
  askModel: async () => '{}',
  dialer: new Dialer({ salt: 's' }),
}).registry

check(() => {
  const qa = restrictRegistry(fullRegistry(), AGENT_ROLES.qa.tools)
  assert.equal(qa.has('analyze_sales_call'), true, 'разбор звонка — прямая работа проверяющего')
  // Проверяющий не звонит: у роли, которая оценивает работу, не должно быть возможности эту работу
  // делать. Иначе оценка перестаёт быть внешней.
  assert.equal(qa.has('dialer_queue_lead'), false)
  assert.equal(qa.has('dialer_status'), false)
})

check(() => {
  const sdr = restrictRegistry(fullRegistry(), AGENT_ROLES.sdr.tools)
  assert.equal(sdr.has('dialer_queue_lead'), true)
  assert.equal(sdr.has('dialer_status'), true)
  // И наоборот: продавец не выставляет себе оценку за собственный разговор.
  assert.equal(sdr.has('analyze_sales_call'), false)
})

// Роль без списка (general) получает весь реестр — включая новые инструменты.
check(() => {
  const general = restrictRegistry(fullRegistry(), AGENT_ROLES.general.tools)
  assert.equal(general.has('analyze_sales_call'), true)
  assert.equal(general.has('dialer_queue_lead'), true)
})

// Роли, которым звонить нечем и незачем, не должны получить очередь по недосмотру.
check(() => {
  for (const name of ['dev', 'marketing', 'media']) {
    const role = AGENT_ROLES[name]
    if (!role) continue
    const narrowed = restrictRegistry(fullRegistry(), role.tools)
    assert.equal(narrowed.has('dialer_queue_lead'), false, `у роли ${name} не должно быть автодозвона`)
  }
})

// Роли рассказывают о новых возможностях словами: инструмент, о котором не сказано в задании роли,
// модель зовёт заметно реже.
check(() => {
  assert.match(AGENT_ROLES.qa.mission, /analyze_sales_call/)
  assert.match(AGENT_ROLES.sdr.mission, /dialer_queue_lead/)
  // И главное — предупреждение про симуляцию, чтобы модель не докладывала «обзваниваю».
  assert.match(AGENT_ROLES.sdr.mission, /СИМУЛЯЦ/)
})

console.log(`[OK] Sales tools integration: ${checks} assertions`)
