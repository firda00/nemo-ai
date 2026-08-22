// Оформление терминала: палитра, шапка, плашка ввода, дерево шагов, строка размышления.
//
// ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ. Оформление ломается так же тихо, как логика, и заметно это только человеку
// перед экраном: плашка уезжает за край и утаскивает перенос строки; логотип рассыпается в узком
// окне; цветные коды попадают в файл журнала и делают его нечитаемым. Ни одно из этого не роняет
// сборку — поэтому проверяется сравнением строк.
//
// ГЛАВНАЯ ПАРА ПРОВЕРОК В ФАЙЛЕ: «в терминале цвет есть» рядом с «в файле и при NO_COLOR цвета нет
// вовсе». Одна без другой бесполезна: первая проходит и на палитре, которая красит всегда.
//
// Запуск: npm run test:tui-theme
import assert from 'node:assert/strict'
import {
  PALETTE, colorLevel, createTheme, fgCode, bgCode, hexToRgb, stripCodes, toAnsi16, toAnsi256,
} from './cli/theme.ts'
import { WIDE_LOGO_MIN, header, logo, noticeBlock, shortenPath, statusLine } from './cli/banner.ts'
import { divider, reasoningLine, statusBar, treeBlock, treeLine, userBar } from './cli/hud.ts'

let checks = 0
const check = (fn) => { fn(); checks++ }

/** Поток-заглушка: isTTY задаётся, чтобы не зависеть от того, как запущен сам набор. */
const tty = (isTTY = true) => ({ isTTY })
const ENV_COLOR = { COLORTERM: 'truecolor', TERM: 'xterm-256color' }
const rich = createTheme(tty(true), ENV_COLOR)
const plain = createTheme(tty(false), {})

const hasCodes = (text) => stripCodes(text) !== text

// ── Разбор цвета ──────────────────────────────────────────────────────────────────────────────
{
  check(() => assert.deepEqual(hexToRgb('#1E222B'), { r: 30, g: 34, b: 43 }))
  check(() => assert.deepEqual(hexToRgb('1E222B'), { r: 30, g: 34, b: 43 }))
  // Короткая форма — обычная запись цвета, и отвергать её незачем.
  check(() => assert.deepEqual(hexToRgb('#abc'), { r: 170, g: 187, b: 204 }))
  // Мусор даёт чёрный, а НЕ исключение: падение посреди отрисовки шапки means пустой экран вместо
  // одного неверного оттенка.
  for (const bad of ['', '#12', 'зелёный', null, undefined, '#GGGGGG']) {
    check(() => assert.deepEqual(hexToRgb(bad), { r: 0, g: 0, b: 0 }, String(bad)))
  }
}

// ── Уровень поддержки цвета ───────────────────────────────────────────────────────────────────
{
  /*
   * NO_COLOR И НЕ-ТЕРМИНАЛ — ГЛАВНАЯ ПАРА.
   *
   * Escape-последовательности в файле журнала выглядят как «ESC[38;2;...m» и делают его
   * нечитаемым. Это не эстетика: журнал читают, когда что-то сломалось, и разбирать его глазами
   * сквозь коды — отдельная работа.
   */
  check(() => assert.equal(colorLevel(tty(true), { NO_COLOR: '1', COLORTERM: 'truecolor' }), 0))
  check(() => assert.equal(colorLevel(tty(false), ENV_COLOR), 0))
  check(() => assert.equal(colorLevel(tty(true), { TERM: 'dumb' }), 0))
  check(() => assert.equal(colorLevel(tty(true), {}), 0))

  check(() => assert.equal(colorLevel(tty(true), { COLORTERM: 'truecolor' }), 3))
  check(() => assert.equal(colorLevel(tty(true), { COLORTERM: '24bit' }), 3))
  check(() => assert.equal(colorLevel(tty(true), { WT_SESSION: 'x', TERM: 'xterm' }), 3))
  check(() => assert.equal(colorLevel(tty(true), { TERM_PROGRAM: 'iTerm.app' }), 3))
  check(() => assert.equal(colorLevel(tty(true), { TERM: 'xterm-256color' }), 2))
  check(() => assert.equal(colorLevel(tty(true), { TERM: 'xterm' }), 1))

  // FORCE_COLOR нужен записи вывода в файл при съёмке ролика: без него демонстрация выйдет серой.
  check(() => assert.equal(colorLevel(tty(false), { FORCE_COLOR: '3' }), 0, 'FORCE_COLOR не должен красить не-терминал'))
  check(() => assert.equal(colorLevel(tty(true), { FORCE_COLOR: '3' }), 3))
  check(() => assert.equal(colorLevel(tty(true), { FORCE_COLOR: '1' }), 1))
}

// ── Ступенчатая деградация ────────────────────────────────────────────────────────────────────
{
  /*
   * ЗАЧЕМ ВООБЩЕ ПОНИЖАТЬ.
   *
   * На терминале без truecolor код «38;2;r;g;b» не распознаётся и печатается КАК ТЕКСТ — прямо
   * посреди строки. Ровно поэтому chalk и делает то же самое; здесь это тридцать строк своего кода.
   */
  check(() => assert.equal(fgCode('#1E222B', 3), `${String.fromCharCode(27)}[38;2;30;34;43m`))
  check(() => assert.match(fgCode('#1E222B', 2), /\[38;5;\d+m$/))
  check(() => assert.match(fgCode('#1E222B', 1), /\[3\d m?|\[\d+m$/))
  check(() => assert.equal(fgCode('#1E222B', 0), '', 'на уровне 0 не должно быть кодов вовсе'))
  check(() => assert.equal(bgCode('#1E222B', 0), ''))

  // Фон в шестнадцати цветах — это код текста плюс десять.
  check(() => {
    const fg = Number(fgCode('#F87171', 1).match(/\[(\d+)m/)[1])
    const bg = Number(bgCode('#F87171', 1).match(/\[(\d+)m/)[1])
    assert.equal(bg, fg + 10)
  })

  /*
   * СЕРОЕ ИДЁТ ПО ШКАЛЕ (232–255), А НЕ ПО КУБУ.
   *
   * В кубе 6×6×6 серых оттенков всего шесть, в шкале — двадцать четыре. Тёмно-серый, отправленный в
   * куб, схлопывается до ближайшего из шести и становится либо чёрным, либо заметно светлее.
   */
  check(() => assert.ok(toAnsi256({ r: 40, g: 40, b: 40 }) >= 232, 'серое ушло в куб'))
  check(() => assert.ok(toAnsi256({ r: 200, g: 202, b: 199 }) >= 232, 'светло-серое ушло в куб'))
  check(() => assert.equal(toAnsi256({ r: 0, g: 0, b: 0 }), 16))
  check(() => assert.equal(toAnsi256({ r: 255, g: 255, b: 255 }), 231))

  // Насыщенный цвет — наоборот, по кубу.
  check(() => assert.ok(toAnsi256({ r: 255, g: 0, b: 0 }) < 232))

  /*
   * Подложка #1E222B серой НЕ является: у неё синий на девять пунктов выше зелёного, и на глаз это
   * видно. Она честно идёт в куб — важно лишь, что остаётся ТЁМНОЙ: подложка реплики, ставшая
   * светлой, перекрасит текст в нечитаемый.
   */
  check(() => {
    const index = toAnsi256(hexToRgb(PALETTE.inputBg))
    assert.ok(index < 232, 'подложка ошибочно отнесена к серой шкале')
    // 16 — начало куба; всё, что ниже 60, это его самый тёмный слой.
    assert.ok(index >= 16 && index < 60, `подложка перестала быть тёмной: ${index}`)
  })

  check(() => assert.equal(toAnsi16({ r: 0, g: 0, b: 0 }), 30))
  check(() => assert.ok(toAnsi16({ r: 255, g: 255, b: 255 }) > 60, 'светлое не получило яркий бит'))
}

// ── Тема: пары «красит / не красит» ───────────────────────────────────────────────────────────
{
  check(() => assert.ok(hasCodes(rich.hex(PALETTE.violet, 'Nemo'))))
  check(() => assert.equal(plain.hex(PALETTE.violet, 'Nemo'), 'Nemo'))
  check(() => assert.equal(plain.bgHex(PALETTE.inputBg, 'Nemo'), 'Nemo'))
  check(() => assert.equal(plain.gradient(PALETTE.cyan, PALETTE.violet, 'Nemo'), 'Nemo'))

  // Текст сохраняется дословно: раскраска не имеет права ничего добавить или потерять.
  check(() => assert.equal(stripCodes(rich.hex(PALETTE.violet, 'Nemo AI')), 'Nemo AI'))
  check(() => assert.equal(stripCodes(rich.gradient(PALETTE.cyan, PALETTE.violet, 'Nemo AI')), 'Nemo AI'))

  /*
   * ОДИН СИМВОЛ: ДЕЛИТЬ НЕ НА ЧТО.
   *
   * Без защиты доля считается как 0/0 = NaN, цвет становится «#NaNNaNNaN», разбор его не принимает
   * и отдаёт чёрный. Падения нет — есть чёрная буква на тёмном фоне, то есть невидимая. Проверять
   * надо ИМЕННО ЦВЕТ: отсутствие строки «NaN» в выводе достигается и таким молчаливым провалом.
   */
  check(() => assert.equal(stripCodes(rich.gradient(PALETTE.cyan, PALETTE.violet, 'N')), 'N'))
  check(() => assert.equal(
    rich.gradient(PALETTE.cyan, PALETTE.violet, 'N'),
    rich.hex(PALETTE.cyan, 'N'),
    'один символ должен взять НАЧАЛЬНЫЙ цвет, а не выродиться в чёрный',
  ))
  check(() => assert.equal(rich.gradient(PALETTE.cyan, PALETTE.violet, 'N').includes('NaN'), false))
  check(() => assert.equal(rich.gradient(PALETTE.cyan, PALETTE.violet, '').includes('NaN'), false))
  // И на длинной строке концы совпадают с заданными цветами.
  check(() => {
    const out = rich.gradient(PALETTE.cyan, PALETTE.violet, 'NEMO')
    assert.ok(out.startsWith(fgCode(PALETTE.cyan, 3)), 'градиент не начинается с первого цвета')
    assert.ok(out.includes(fgCode(PALETTE.violet, 3)), 'градиент не доходит до второго цвета')
  })
}

// ── Плашка на всю ширину ──────────────────────────────────────────────────────────────────────
{
  /*
   * ДОБИВКА СЧИТАЕТСЯ ПО ВИДИМОЙ ШИРИНЕ.
   *
   * Внутри плашки почти всегда уже есть свои коды — маркер, выделение. Считая .length, мы добавили
   * бы пробелов на длину этих кодов, подложка уехала бы за правый край и утащила перенос строки:
   * на экране это выглядит как съехавшая вниз половина интерфейса.
   */
  check(() => assert.equal(stripCodes(rich.bar(PALETTE.inputBg, 'привет', 40)).length, 40))
  check(() => {
    const inner = rich.hex(PALETTE.violet, '›') + ' привет'
    assert.equal(stripCodes(rich.bar(PALETTE.inputBg, inner, 40)).length, 40, 'добивка посчитана по .length')
  })
  // Текст длиннее окна не обрезается плашкой: резать его — дело вызывающего, а молчаливая обрезка
  // потеряла бы конец команды.
  check(() => assert.ok(stripCodes(rich.bar(PALETTE.inputBg, 'x'.repeat(50), 20)).length >= 50))
  check(() => assert.equal(plain.bar(PALETTE.inputBg, 'привет', 10), 'привет    '))

  /*
   * ФОН ПЕРЕЖИВАЕТ ВНУТРЕННИЕ СБРОСЫ ЦВЕТА.
   *
   * Разница между плашкой и её отсутствием. Внутри строки почти всегда есть свои цвета, и каждый
   * заканчивается общим сбросом ESC[0m, который гасит ВСЁ, включая фон: получается подложка под
   * первым символом и голый текст дальше.
   *
   * По коду это не видно — bar() выглядит правильно, проверка ширины проходит, а подложки нет.
   * Нашлось распечаткой настоящего вывода, поэтому и сторожится отдельно.
   */
  check(() => {
    const reset = `${String.fromCharCode(27)}[0m`
    const bg = `${String.fromCharCode(27)}[48;2;30;34;43m`
    const inner = `${rich.hex(PALETTE.violet, '›')} ${rich.hex(PALETTE.text, 'привет')}`
    const out = rich.bar(PALETTE.inputBg, inner, 40)

    // Каждый сброс, кроме последнего, обязан немедленно возвращать фон.
    const parts = out.split(reset)
    for (let i = 1; i < parts.length - 1; i += 1) {
      assert.ok(parts[i].startsWith(bg), `после сброса №${i} фон не восстановлен — плашка разорвана`)
    }
    // И заканчивается плашка именно сбросом: без него фон утечёт на следующую строку.
    assert.ok(out.endsWith(reset), 'плашка не закрыта — фон утечёт вниз по экрану')
  })
}

// ── Логотип ───────────────────────────────────────────────────────────────────────────────────
{
  /*
   * УЗКИЙ ВАРИАНТ — НЕ ЗАПАС НА ВСЯКИЙ СЛУЧАЙ.
   *
   * Широкий занимает 43 колонки. В окне на 60 — обычная ширина расколотого пополам экрана — он
   * переносится, и вместо логотипа выходит лесенка из обломков.
   */
  check(() => {
    const wide = logo(plain, 100)
    assert.equal(wide.length, 6)
    for (const line of wide) assert.ok(line.length <= 43, `строка логотипа длиннее 43: ${line.length}`)
  })
  check(() => {
    const narrow = logo(plain, 40)
    assert.equal(narrow.length, 2)
    for (const line of narrow) assert.ok(line.length <= 20)
  })
  check(() => assert.equal(logo(plain, WIDE_LOGO_MIN).length, 6))
  check(() => assert.equal(logo(plain, WIDE_LOGO_MIN - 1).length, 2))
  // Логотип раскрашен, но текст его не меняется.
  check(() => assert.ok(hasCodes(logo(rich, 100).join(''))))
  check(() => assert.deepEqual(logo(rich, 100).map(stripCodes), logo(plain, 100)))
}

// ── Путь и строка состояния ───────────────────────────────────────────────────────────────────
{
  // Полный путь к профилю — это имя пользователя на экране. При записи ролика оно уедет в интернет.
  check(() => assert.equal(shortenPath('C:/Users/firda/nemo-ai', 'C:/Users/firda'), '~/nemo-ai'))
  check(() => assert.equal(shortenPath('C:\\Users\\firda\\nemo-ai', 'C:\\Users\\firda'), '~/nemo-ai'))
  check(() => assert.equal(shortenPath('C:/Users/firda', 'C:/Users/firda'), '~'))
  // Чужой путь не трогается, и похожий на домашний — тоже: «/home/firdavs» не внутри «/home/firda».
  check(() => assert.equal(shortenPath('/opt/nemo', '/home/firda'), '/opt/nemo'))
  check(() => assert.equal(shortenPath('/home/firdavs/x', '/home/firda'), '/home/firdavs/x'))

  const state = { version: '1.0.0', model: 'gpt-4o-mini', plan: 'sdr', cwd: '~/nemo-ai' }
  check(() => assert.equal(
    stripCodes(statusLine(state, plain, 80)),
    'Nemo CLI v1.0.0 · [gpt-4o-mini · sdr] · ~/nemo-ai',
  ))

  /*
   * ПУТЬ РЕЖЕТСЯ С НАЧАЛА, А НЕ С КОНЦА.
   *
   * Конец пути говорит, где мы находимся; начало говорит, что диск называется C. Обрезав хвост, мы
   * оставили бы на экране бесполезную половину.
   */
  check(() => {
    const deep = { ...state, cwd: '~/очень/длинный/путь/до/самой/глубокой/папки/проекта' }
    const shown = stripCodes(statusLine(deep, plain, 60))
    assert.ok(shown.includes('…'), 'длинный путь не обрезан')
    assert.ok(shown.endsWith('проекта'), 'обрезали хвост вместо начала')
  })
}

// ── Блок предупреждений ───────────────────────────────────────────────────────────────────────
{
  /*
   * ЛЕВАЯ ЧЕРТА — НЕ УКРАШЕНИЕ.
   *
   * Без неё «включён автопилот» сливается с обычным выводом и читается как очередная строка
   * журнала. Черта отделяет то, что человек обязан заметить, от того, что он может пролистать.
   */
  check(() => {
    const block = noticeBlock(['Auto-pilot mode is active'], plain)
    assert.deepEqual(block, ['│ Auto-pilot mode is active'])
  })
  // Пустые строки выбрасываются: одинокая черта без текста выглядит как поломка отрисовки.
  check(() => assert.deepEqual(noticeBlock(['', '  ', 'важное'], plain), ['│ важное']))
  check(() => assert.deepEqual(noticeBlock([], plain), []))

  // Шапка целиком: логотип, состояние, предупреждения.
  check(() => {
    const out = header({ version: '1.0.0', model: 'gpt-4o-mini', plan: 'sdr', cwd: '~/nemo-ai' }, plain, {
      width: 100, notices: ['Auto-pilot mode is active'],
    }).map(stripCodes)
    assert.ok(out.some((one) => one.includes('███')), 'в шапке нет логотипа')
    assert.ok(out.some((one) => one.includes('Nemo CLI v1.0.0')))
    assert.ok(out.some((one) => one === '│ Auto-pilot mode is active'))
  })
  // Без предупреждений блока нет вовсе.
  check(() => {
    const out = header({ version: '1.0.0', model: 'm', plan: 'p', cwd: '~' }, plain, { width: 100 }).map(stripCodes)
    assert.equal(out.some((one) => one.startsWith('│')), false)
  })
}

// ── Плашка реплики человека ───────────────────────────────────────────────────────────────────
{
  const at = new Date(2026, 7, 22, 14, 5)

  check(() => {
    const bar = userBar('найди 10 клиник', at, 60, undefined, plain)
    assert.equal(bar.split('\n').length, 1)
    assert.equal(stripCodes(bar).length, 60, 'плашка не во всю ширину')
    assert.ok(stripCodes(bar).startsWith('› найди 10 клиник'))
    assert.ok(stripCodes(bar).includes('14:05'))
  })

  /*
   * МНОГОСТРОЧНАЯ ВСТАВКА — ОДИН ПРЯМОУГОЛЬНИК.
   *
   * Каждая строка получает свою плашку той же ширины, поэтому тридцать вставленных строк выглядят
   * как один блок, а не как первая строка и сироты под ней.
   */
  check(() => {
    const lines = userBar('первая\nвторая\nтретья', at, 50, undefined, plain).split('\n')
    assert.equal(lines.length, 3)
    for (const line of lines) assert.equal(stripCodes(line).length, 50)
    // Маркер только у первой: он отмечает начало вставки, а не каждую строку.
    assert.ok(stripCodes(lines[0]).startsWith('›'))
    assert.equal(stripCodes(lines[1]).startsWith('›'), false)
    // Отметка времени тоже только у первой.
    assert.equal(stripCodes(lines[1]).includes('14:05'), false)
  })

  // В узком окне время выбрасывается, а текст остаётся: втиснутая отметка съела бы то, ради чего
  // строка и печатается.
  check(() => {
    const narrow = stripCodes(userBar('очень длинная реплика человека', at, 20, undefined, plain))
    assert.equal(narrow.includes('14:05'), false)
    assert.ok(narrow.includes('очень длинная'))
  })

  // В терминале подложка есть, в файле — нет ни одного кода.
  check(() => assert.ok(hasCodes(userBar('привет', at, 40, undefined, rich))))
  check(() => assert.equal(hasCodes(userBar('привет', at, 40, undefined, plain)), false))
}

// ── Дерево шагов ──────────────────────────────────────────────────────────────────────────────
{
  check(() => assert.equal(stripCodes(treeLine('49 skills available', { last: true }, plain)), '└ 49 skills available'))
  check(() => assert.equal(stripCodes(treeLine('Checking database...', {}, plain)), '├ Checking database...'))
  // Вложенность рисуется вертикалями: без них ветка повисает в воздухе.
  check(() => assert.equal(stripCodes(treeLine('глубже', { depth: 1 }, plain)), '│ ├ глубже'))
  check(() => assert.equal(stripCodes(treeLine('ещё глубже', { depth: 2, last: true }, plain)), '│ │ └ ещё глубже'))

  check(() => {
    const block = treeBlock(['Loading skills', 'Checking database', '49 skills available'], plain).map(stripCodes)
    assert.deepEqual(block, ['├ Loading skills', '├ Checking database', '└ 49 skills available'])
  })
  // Одна ветка — сразу последняя.
  check(() => assert.deepEqual(treeBlock(['одна'], plain).map(stripCodes), ['└ одна']))
  check(() => assert.deepEqual(treeBlock([], plain), []))

  // Тон меняет цвет, но не текст: отказ и успех различаются цветом, а читаются одинаково.
  check(() => {
    const fail = treeLine('не вышло', { tone: 'fail' }, rich)
    const ok = treeLine('не вышло', { tone: 'ok' }, rich)
    assert.notEqual(fail, ok)
    assert.equal(stripCodes(fail), stripCodes(ok))
  })
}

// ── Строка размышления ────────────────────────────────────────────────────────────────────────
{
  check(() => assert.equal(
    stripCodes(reasoningLine({ elapsedMs: 2400, temperature: 0.2 }, plain)),
    '✳ Reasoning... (2.4s · temperature 0.2)',
  ))

  /*
   * TEMPERATURE ПЕЧАТАЕТСЯ ТОЛЬКО КОГДА ЗАДАНА.
   *
   * Подставленное умолчание — это число, которого никто не выбирал. По нему потом объясняют, почему
   * модель ответила именно так, и объяснение будет неверным.
   */
  check(() => assert.equal(
    stripCodes(reasoningLine({ elapsedMs: 900 }, plain)), '✳ Reasoning... (0.9s)',
  ))
  check(() => assert.equal(
    stripCodes(reasoningLine({ elapsedMs: 900, temperature: null }, plain)), '✳ Reasoning... (0.9s)',
  ))
  // Ноль — это заданное значение, а не отсутствие: детерминированный прогон надо показывать.
  check(() => assert.ok(stripCodes(reasoningLine({ elapsedMs: 100, temperature: 0 }, plain)).includes('temperature 0')))

  // Отрицательное время не бывает, но часы иногда переводят назад.
  check(() => assert.ok(stripCodes(reasoningLine({ elapsedMs: -50 }, plain)).includes('0.0s')))
  check(() => assert.ok(stripCodes(reasoningLine({ elapsedMs: 1000, label: 'Думаю' }, plain)).startsWith('✳ Думаю...')))
}

// ── Разделитель и подстрочник ─────────────────────────────────────────────────────────────────
{
  check(() => assert.equal(stripCodes(divider(30, plain)), '─'.repeat(30)))
  // Нулевая и отрицательная ширина не должны давать пустую строку без черты: окно бывает узким,
  // но разделитель либо есть, либо интерфейс разваливается.
  check(() => assert.equal(stripCodes(divider(0, plain)), '─'))

  check(() => assert.equal(
    stripCodes(statusBar({ role: 'sdr' }, plain)),
    '▸▸ sdr mode · /agent to switch · /skills',
  ))
  // «esc to cancel» показывается только когда есть что отменять: подсказка про клавишу, которая
  // сейчас ничего не делает, учит не верить подсказкам вообще.
  check(() => assert.equal(
    stripCodes(statusBar({ role: 'sdr', busy: true }, plain)),
    '▸▸ sdr mode · esc to cancel · /agent to switch · /skills',
  ))
  check(() => assert.ok(stripCodes(statusBar({ role: 'qa' }, plain)).startsWith('▸▸ qa mode')))
}

console.log(`[OK] TUI theme and header: ${checks} assertions`)
