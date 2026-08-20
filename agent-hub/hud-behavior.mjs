// Оформление терминала: строка состояния, реплика человека, подсказки ввода.
//
// ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ — ЧЕСТНОСТЬ ЦИФР И ЦЕЛОСТНОСТЬ ШИРИНЫ.
//
// 1. СЧЁТЧИК КОНТЕКСТА НЕ ДОЛЖЕН ВЫГЛЯДЕТЬ ТОЧНЫМ, КОГДА ОН ОЦЕНКА. Модель сообщает израсходованные
//    токены не всегда, а посчитать их самому нечем: токенизатор у каждой свой. Оценка по знакам
//    ошибается в полтора раза на кириллице. Цифре в строке состояния верят — значит, оценка обязана
//    быть помечена.
//
// 2. ЗНАМЕНАТЕЛЬ ДОЛЖЕН БЫТЬ ОТ ЭТОЙ МОДЕЛИ. «32k / 200k» на gpt-4o неверно: у него 128k. Предел,
//    взятый от балды, успокаивает ровно до того момента, когда разговор оборвётся на середине.
//
// 3. ШИРИНА СЧИТАЕТСЯ ПО ВИДИМЫМ ЗНАКАМ. Строка состояния выравнивается по правому краю; с .length
//    отступ уедет на длину управляющих последовательностей, и строка встанет за границу окна.

import assertStrict from 'node:assert/strict'
import {
  CONTEXT_LIMITS, INPUT_PROMPT, contextLimitFor, estimateHistoryTokens, estimateTokens,
  agentBadge, footerHints, hudLine, plural, shortCount, shortModel, toolBadge, userLine,
} from './cli/hud.ts'
import { colorsFor, visibleWidth } from './tui.mjs'

let checks = 0
const assert = new Proxy(assertStrict, {
  get: (target, key) => {
    const value = target[key]
    if (typeof value !== 'function') return value
    return (...args) => { checks++; return value.apply(target, args) }
  },
})

/** Палитра терминала: чтобы проверки не зависели от того, где их запускают. */
const paint = colorsFor({ isTTY: true })
const plain = colorsFor({ isTTY: false })

// ─── Предел контекста ─────────────────────────────────────────────────────────────────────────────

check: {
  assert.equal(contextLimitFor('anthropic/claude-sonnet-4'), 200_000)
  assert.equal(contextLimitFor('openai/gpt-4o'), 128_000, 'у gpt-4o не 200k, и подставлять их нельзя')
  // Суффикс маршрутизации OpenRouter не должен ронять поиск предела.
  assert.equal(contextLimitFor('anthropic/claude-sonnet-4:beta'), 200_000)
  // Неизвестная модель — null. Выдуманный предел успокаивает до обрыва разговора.
  assert.equal(contextLimitFor('своя/модель'), null)
  assert.ok(Object.keys(CONTEXT_LIMITS).length >= 5)
}

// ─── Оценка токенов ───────────────────────────────────────────────────────────────────────────────

/*
 * КИРИЛЛИЦА СЧИТАЕТСЯ ОТДЕЛЬНО, И ЭТО НЕ ПРИДИРКА.
 *
 * У распространённых токенизаторов латиница идёт примерно по четыре знака на токен, кириллица —
 * примерно по два. Общий делитель занижал бы русский разговор вдвое, то есть врал бы именно там, где
 * этот CLI и работает.
 */
check: {
  const latin = estimateTokens('a'.repeat(100))
  const cyrillic = estimateTokens('я'.repeat(100))
  assert.ok(cyrillic > latin * 1.5, `кириллица оценена как латиница: ${cyrillic} против ${latin}`)
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
}

// История считается вместе с аргументами вызовов: они тоже уходят в запрос и тоже стоят токенов.
check: {
  const withCalls = estimateHistoryTokens([
    { role: 'user', content: 'найди клиники' },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'search_leads', arguments: '{"query":"клиники","city":"Ташкент"}' } }] },
  ])
  const withoutCalls = estimateHistoryTokens([{ role: 'user', content: 'найди клиники' }])
  assert.ok(withCalls > withoutCalls, 'аргументы вызовов не посчитаны — счётчик занижен')
}

check: {
  assert.equal(shortCount(0), '0')
  assert.equal(shortCount(999), '999', 'ниже тысячи «0k» ничего не сообщает')
  assert.equal(shortCount(32_100), '32.1k')
  assert.equal(shortCount(200_000), '200k')
}

// ─── Строка состояния ─────────────────────────────────────────────────────────────────────────────

/*
 * ОЦЕНКА ПОМЕЧЕНА, ИЗМЕРЕНИЕ — НЕТ.
 *
 * Разница между «~32k» и «32k» — это разница между догадкой и фактом, и человек принимает по ним
 * разные решения о том, пора ли сжимать контекст.
 */
check: {
  const measured = hudLine({ model: 'openai/gpt-4o', role: 'dev', usedTokens: 32_100, estimatedTokens: 999 }, 80, plain)
  assert.ok(measured.includes('32.1k / 128k'), measured)
  assert.equal(measured.includes('~'), false, 'измеренное число помечено как оценка')

  const guessed = hudLine({ model: 'openai/gpt-4o', role: 'dev', usedTokens: null, estimatedTokens: 4_800 }, 80, plain)
  assert.ok(guessed.includes('~4.8k'), guessed)
}

// Ноль израсходованных токенов — это НЕ «не сообщили»: сразу после /clear счётчик честно нулевой.
check: {
  const zero = hudLine({ model: 'openai/gpt-4o', role: 'dev', usedTokens: 0, estimatedTokens: 5_000 }, 80, plain)
  assert.ok(zero.includes('0 / 128k'), zero)
  assert.equal(zero.includes('~'), false)
}

// У неизвестной модели знаменателя нет: показываем израсходованное и молчим об остатке.
check: {
  const unknown = hudLine({ model: 'своя/модель', role: 'qa', usedTokens: 1_200, estimatedTokens: 0 }, 80, plain)
  assert.ok(unknown.includes('1.2k токенов'), unknown)
  assert.equal(unknown.includes('/'), false, 'у неизвестной модели появился выдуманный предел')
}

// Роль и модель названы обе: без роли непонятно, почему инструмент недоступен; без модели — почему
// ответы изменились после /model.
check: {
  const line = hudLine({ model: 'anthropic/claude-sonnet-4', role: 'sdr', usedTokens: 1, estimatedTokens: 0 }, 80, plain)
  assert.ok(line.includes('sdr'))
  assert.ok(line.includes('claude-sonnet-4'))
  assert.equal(line.includes('anthropic/'), false, 'поставщик занимает место без пользы')
}
check: {
  assert.equal(shortModel('anthropic/claude-sonnet-4'), 'claude-sonnet-4')
  assert.equal(shortModel('qwen2.5:7b'), 'qwen2.5:7b', 'локальное имя без поставщика остаётся как есть')
}

// Готовность и время генерации — разные состояния, и путать их нельзя.
check: {
  assert.ok(hudLine({ model: 'x', role: 'dev', usedTokens: 1, estimatedTokens: 0 }, 80, plain).includes('готов'))
  assert.ok(hudLine({ model: 'x', role: 'dev', usedTokens: 1, estimatedTokens: 0, busyMs: 2_400 }, 80, plain).includes('2.4 с'))
}

/*
 * ВЫРАВНИВАНИЕ ПО ВИДИМЫМ ЗНАКАМ.
 *
 * Строка состояния прижата к правому краю. С .length отступ считается вместе с управляющими
 * последовательностями цвета, и в терминале строка уезжает за границу окна — тем сильнее, чем больше
 * в ней цвета.
 */
check: {
  const state = { model: 'openai/gpt-4o', role: 'dev', usedTokens: 32_100, estimatedTokens: 0 }
  for (const width of [60, 80, 120]) {
    const line = hudLine(state, width, paint)
    assert.equal(visibleWidth(line), width, `ширина ${width}: получилось ${visibleWidth(line)}`)
  }
  // Раскрашенная и голая строки занимают на экране одинаково: цвет не занимает места.
  assert.equal(visibleWidth(hudLine(state, 80, paint)), visibleWidth(hudLine(state, 80, plain)))
}

// Узкое окно не даёт отрицательный отступ и не роняет отрисовку.
check: {
  const narrow = hudLine({ model: 'anthropic/claude-sonnet-4', role: 'general', usedTokens: 199_000, estimatedTokens: 0 }, 20, plain)
  assert.equal(narrow.includes('\n'), false, 'строка состояния перенеслась на вторую строку')
}

// ─── Реплика человека ─────────────────────────────────────────────────────────────────────────────

check: {
  const line = userLine('найди 10 клиник в Ташкенте', new Date(2026, 7, 19, 9, 5), 60, plain)
  const rows = line.split(/\r?\n/)
  assert.equal(rows.length, 2, 'реплика человека — текст и черта под ним')
  assert.ok(rows[0].includes('найди 10 клиник в Ташкенте'))
  // Время с ведущими нулями: «9:5» читается как ошибка вёрстки.
  assert.ok(rows[0].includes('09:05'), rows[0])
  assert.equal(visibleWidth(rows[1]), 60, 'черта не по ширине окна')
}

// Длинная реплика не ломает вёрстку: отступ до времени не уходит в минус.
check: {
  const long = userLine('я'.repeat(300), new Date(2026, 7, 19, 14, 32), 60, plain)
  assert.equal(long.split(/\r?\n/).length, 2)
  assert.ok(long.includes('14:32'), 'время потерялось на длинной реплике')
}

// Цвет не влияет на ширину черты — иначе она разъедется относительно строки состояния.
check: {
  const painted = userLine('запрос', new Date(2026, 7, 19, 1, 2), 70, paint)
  assert.equal(visibleWidth(painted.split(/\r?\n/)[1]), 70)
}

/*
 * МНОГОСТРОЧНАЯ ВСТАВКА — ОДИН БЛОК.
 *
 * Текст подставлялся вместе с переводами строк: маркер доставался первой строке, продолжение уходило
 * вровень с левым краем (неотличимо от вывода агента), а ширина считалась по всей склейке — отметка
 * времени вставала посреди последней строки вместо правого края первой.
 *
 * Проверяется на разных формах, а не на одной удобной: пустые строки внутри вставки — обычное дело
 * при копировании кода, и потерять на них маркер значит вернуть ровно тот же разрыв блока.
 */
check: {
  for (const body of [
    'одна\nдве',
    'первая\n\nтретья',
    'a\nb\nc\nd\ne',
    'строка\n   с отступом\n\tи табом',
    'хвост с пустой строкой\n',
  ]) {
    const rows = userLine(body, new Date(2026, 7, 19, 9, 5), 60, plain).split(/\r?\n/)
    const lines = body.split(/\r?\n/)
    assert.equal(rows.length, lines.length + 1, `вставка ${JSON.stringify(body)} потеряла строки`)
    assert.ok(rows[0].startsWith('› '), 'первая строка без маркера ввода')
    assert.ok(rows[0].includes('09:05'), 'время ушло с первой строки')
    for (let i = 1; i < lines.length; i += 1) {
      assert.ok(rows[i].startsWith('│ '), `строка ${i} вставки осталась без маркера: ${JSON.stringify(rows[i])}`)
      assert.ok(rows[i].includes(lines[i]), `строка ${i} вставки потеряла текст`)
    }
    assert.ok(!rows.slice(1, -1).some((one) => one.includes('09:05')), 'время продублировалось внутри блока')
    assert.equal(visibleWidth(rows[rows.length - 1]), 60, 'черта не по ширине окна')
  }
}

/*
 * БЕЙДЖ АГЕНТА НАЗЫВАЕТ РОЛЬ.
 *
 * «✦ Nemo» без роли не отвечает на вопрос, который бейдж и существует чтобы снимать: каким кругом
 * инструментов сейчас отвечают. Роль подставляется, а не берётся из замыкания.
 */
check: {
  for (const role of ['sdr', 'general', 'qa']) {
    const badge = agentBadge(role, plain)
    assert.ok(badge.startsWith('✦ '), `бейдж без маркера: ${badge}`)
    assert.ok(badge.includes(`Nemo (${role})`), `бейдж не назвал роль ${role}: ${badge}`)
  }
  assert.equal(visibleWidth(agentBadge('sdr', paint)), visibleWidth(agentBadge('sdr', plain)), 'цвет изменил ширину бейджа')
}

// ─── Подсказки под вводом ─────────────────────────────────────────────────────────────────────────

/*
 * НАЗВАНЫ ТОЛЬКО ТЕ КЛАВИШИ, КОТОРЫЕ ДЕЙСТВИТЕЛЬНО РАБОТАЮТ.
 *
 * Подсказка о несуществующем сочетании хуже её отсутствия: человек нажимает, ничего не происходит, и
 * дальше он не верит ни одной подсказке в этом окне.
 */
check: {
  const hints = footerHints(plain)
  assert.ok(hints.includes('/help'), hints)
  assert.ok(hints.includes('Tab'), hints)
  assert.ok(hints.includes('Ctrl+C'), hints)
  assert.equal(hints.includes('\n'), false, 'подсказки заняли больше одной строки')
}

// Приглашение ввода — чистый шеврон без рамки: рамка вокруг поля ввода мешает выделять текст мышью.
check: {
  assert.equal(INPUT_PROMPT, '› ')
  assert.equal(INPUT_PROMPT.includes('┌'), false)
}

// ─── Согласование числа со словом ─────────────────────────────────────────────────────────────────

/*
 * «Найдено 3 компаний» читается как недоделка.
 *
 * Это не педантизм: интерфейс, который не умеет согласовать число со словом, выглядит собранным
 * наспех — а по нему судят и обо всём остальном, включая цифры, которым положено верить.
 */
check: {
  const форма = (n) => plural(n, 'компания', 'компании', 'компаний')
  assert.equal(форма(1), 'компания')
  assert.equal(форма(2), 'компании')
  assert.equal(форма(4), 'компании')
  assert.equal(форма(5), 'компаний')
  assert.equal(форма(0), 'компаний', 'ноль берёт третью форму, а не первую')
  // Одиннадцать–четырнадцать — исключение: по последней цифре они дали бы «11 компания».
  assert.equal(форма(11), 'компаний')
  assert.equal(форма(12), 'компаний')
  assert.equal(форма(14), 'компаний')
  assert.equal(форма(21), 'компания')
  assert.equal(форма(22), 'компании')
  assert.equal(форма(111), 'компаний', 'сотня с одиннадцатью — тоже исключение')
  assert.equal(форма(101), 'компания')
}

// Согласование действительно применено в бейдже, а не только объявлено функцией.
check: {
  assert.ok(toolBadge({ name: 'search_leads', args: {}, ok: true, result: { found: 3 }, durationMs: 1 }).includes('3 компании'))
  assert.ok(toolBadge({ name: 'search_leads', args: {}, ok: true, result: { found: 5 }, durationMs: 1 }).includes('5 компаний'))
  assert.ok(toolBadge({ name: 'search_leads', args: {}, ok: true, result: { found: 1 }, durationMs: 1 }).includes('1 компания'))
}

console.log(`[OK] HUD and terminal layout: ${checks} assertions`)
