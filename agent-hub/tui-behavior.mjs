// Интерактивный режим: разбор ответов, спиннер, выгрузка.
//
// Проверяется всё, что можно проверить БЕЗ терминала, — и это почти всё, потому что разбор ответов
// вынесен из самих вопросов именно для этого. Главное здесь: интерактив не должен включаться там,
// где спрашивать некого, а спиннер не должен сыпать escape-последовательностями в файл журнала.

import assertStrict from 'node:assert/strict'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import {
  Ask, Spinner, banner, colorsFor, dashboard, isInteractiveTerminal, renderOption, resolveInput, resolveSelect,
  stripAnsi, visibleWidth,
} from './tui.mjs'
import { clipboardCommand, csvCell, exportFileName, toCsv, toJson, writeExport } from './lead-export.mjs'

/**
 * Счётчик проверок.
 *
 * Раньше в итоговой строке стояло число литералом. Оно перестало сходиться с действительностью на
 * первой же дописанной проверке, а строка при этом продолжала уверенно докладывать прежнее — то есть
 * врать. Считаем вызовы, а не помним их количество.
 */
let checks = 0
const assert = new Proxy(assertStrict, {
  get: (target, key) => {
    const value = target[key]
    if (typeof value !== 'function') return value
    return (...args) => { checks++; return value.apply(target, args) }
  },
})

// --- Живой терминал: оба конца обязательны --------------------------------------------------------
// Скрипт из cron, повисший на невидимом вопросе, выглядит как зависший пайплайн, и разбираться в
// этом будут по таймауту через час.

assert.equal(isInteractiveTerminal({ isTTY: true }, { isTTY: true }), true)
assert.equal(isInteractiveTerminal({ isTTY: false }, { isTTY: true }), false, 'ввода нет — спрашивать нельзя')
assert.equal(isInteractiveTerminal({ isTTY: true }, { isTTY: false }), false, 'вывода нет — вопрос не увидят')
assert.equal(isInteractiveTerminal({}, {}), false)

// --- Текстовый ответ ------------------------------------------------------------------------------

assert.deepEqual(resolveInput('стоматология', {}), { ok: true, value: 'стоматология' })
assert.deepEqual(resolveInput('  Ташкент  ', {}), { ok: true, value: 'Ташкент' }, 'пробелы по краям срезаются')

// Пустой ввод при наличии значения по умолчанию — СОГЛАСИЕ, а не пропуск. Путать эти два случая
// нельзя: человек нажал Enter, потому что предложенное его устроило.
assert.deepEqual(resolveInput('', { fallback: 'Ташкент' }), { ok: true, value: 'Ташкент' })
assert.deepEqual(resolveInput('   ', { fallback: 'Ташкент' }), { ok: true, value: 'Ташкент' })

// Обязательное поле без значения по умолчанию — переспросить, а не пропустить дальше пустым.
assert.equal(resolveInput('', { required: true }).ok, false)
assert.equal(resolveInput('', { required: true }).error, 'нужно что-то ввести')
// Необязательное — пустая строка законна.
assert.deepEqual(resolveInput('', {}), { ok: true, value: '' })
// Минимальная длина: «а» как ниша даст мусорный запрос к чужому API.
assert.equal(resolveInput('а', { min: 2 }).ok, false)
assert.equal(resolveInput('ав', { min: 2 }).ok, true)

// --- Нумерованный выбор ---------------------------------------------------------------------------

const LIMITS = [{ label: '10', value: 10 }, { label: '25', value: 25 }, { label: '50', value: 50 }]

assert.deepEqual(resolveSelect('1', LIMITS, 1), { ok: true, index: 0, value: LIMITS[0] })
assert.deepEqual(resolveSelect('3', LIMITS, 1), { ok: true, index: 2, value: LIMITS[2] })
// Enter — значение по умолчанию, и оно помечено в списке, чтобы это было видно.
assert.deepEqual(resolveSelect('', LIMITS, 1), { ok: true, index: 1, value: LIMITS[1] })
// Человек, набравший «50» вместо «3», имел в виду ровно то, что написано в списке. Отказывать
// формально — грубость, а не строгость.
assert.deepEqual(resolveSelect('50', LIMITS, 1), { ok: true, index: 2, value: LIMITS[2] })
assert.deepEqual(resolveSelect('25', LIMITS, 1), { ok: true, index: 1, value: LIMITS[1] })

// Подпись целиком — отдельный путь разбора, и его надо проверять на списке, где подпись НЕ равна
// значению. На LIMITS выше «50» совпадает и с подписью, и со значением, поэтому та проверка не
// отличает один путь от другого: мутационный прогон это и показал.
{
  const labelled = [
    { label: '10 — быстрая проверка', value: 10 },
    { label: '25 — обычный прогон', value: 25 },
  ]
  assert.deepEqual(resolveSelect('25 — обычный прогон', labelled, 0), { ok: true, index: 1, value: labelled[1] })
  assert.deepEqual(resolveSelect('10 — БЫСТРАЯ проверка', labelled, 1), { ok: true, index: 0, value: labelled[0] },
    'регистр подписи не важен — человек не обязан повторять её точно')
  // Значение при этом тоже принимается: оба пути живы независимо.
  assert.deepEqual(resolveSelect('25', labelled, 0), { ok: true, index: 1, value: labelled[1] })
}

// Мимо списка — переспросить с указанием границ, а не молча взять первое.
for (const bad of ['0', '4', '-1', 'да', '1.5']) {
  const verdict = resolveSelect(bad, LIMITS, 1)
  assert.equal(verdict.ok, false, `«${bad}» — не выбор`)
  assert.ok(verdict.error.includes('от 1 до 3'))
}

// Работает и на простом массиве строк, не только на {label,value}.
assert.deepEqual(resolveSelect('2', ['a', 'b', 'c'], 0), { ok: true, index: 1, value: 'b' })

// Значение по умолчанию помечено — иначе Enter выглядит как «ничего не выбрал».
assert.ok(renderOption(LIMITS[1], 1, 1).includes('Enter'))
assert.equal(renderOption(LIMITS[0], 0, 1).includes('Enter'), false)

// --- Спиннер в НЕ-терминале не анимирует ----------------------------------------------------------
// Возврат каретки и escape-последовательности в файле журнала превращают его в кашу, а именно в
// журнал этот вывод и попадёт, когда прогон запустят из cron.

{
  const written = []
  const fake = { isTTY: false, write: (text) => { written.push(text); return true } }
  const spinner = new Spinner(fake)
  spinner.start('этап 1')
  spinner.update('этап 2')
  spinner.succeed('готово')
  const all = written.join('')
  assert.equal(all.includes('\r'), false, 'без возврата каретки')
  assert.equal(all.includes(String.fromCharCode(27)), false, 'без escape-последовательностей')
  assert.ok(all.includes('этап 1') && all.includes('этап 2') && all.includes('готово'), 'но все строки на месте')
  assert.equal(spinner.timer, null, 'таймер не запускался — нечего оставлять висеть')
}

/*
 * ЦВЕТ СЛЕДУЕТ ЗА ПОТОКОМ, В КОТОРЫЙ ПИШУТ, А НЕ ЗА ТЕРМИНАЛОМ ПОД ПРОЦЕССОМ.
 *
 * Проверка выше («без escape-последовательностей») зависела от того, ГДЕ её запускают: цвет решался
 * по process.stdout, а не по потоку спиннера. В конвейере stdout не TTY, цвета нет, проверка
 * проходит; в настоящем терминале цвет включается, попадает в подменённый поток — и та же проверка
 * падает. Один и тот же код, разный результат, и по стектрейсу причину не увидеть.
 *
 * Пара ниже от окружения НЕ зависит: оба потока подменены, и решение принимается по их собственному
 * isTTY. Именно эта пара ловит возврат к глобальному решению о цвете.
 */
{
  const NO_COLOR = process.env.NO_COLOR
  delete process.env.NO_COLOR
  try {
    const quiet = []
    new Spinner({ isTTY: false, write: (text) => { quiet.push(text); return true } }).start('шаг').succeed('готово')
    assert.equal(
      quiet.join('').includes(String.fromCharCode(27)), false,
      'цвет попал в не-терминальный поток: в файле журнала это мусор вида ESC[32m',
    )

    /*
     * ИЩЕМ ИМЕННО КОД ЦВЕТА, А НЕ ЛЮБОЙ ESC.
     *
     * В терминальном режиме спиннер и без всякого цвета пишет очистку строки — а это тоже ESC. Первая
     * версия проверки искала любой управляющий байт и потому проходила даже с полностью отключённой
     * раскраской: мутационный прогон это и показал.
     */
    const painted = []
    new Spinner({ isTTY: true, write: (text) => { painted.push(text); return true } }).succeed('готово')
    assert.ok(
      painted.join('').includes(`${String.fromCharCode(27)}[32m`),
      'в терминальный поток не попал код зелёного — раскраска отключилась целиком',
    )

    // NO_COLOR сильнее живого терминала: договорённость, которую уважают все приличные CLI.
    process.env.NO_COLOR = '1'
    const respected = []
    new Spinner({ isTTY: true, write: (text) => { respected.push(text); return true } }).succeed('готово')
    assert.equal(respected.join('').includes(String.fromCharCode(27) + '[32m'), false, 'NO_COLOR не соблюдён')
  } finally {
    if (NO_COLOR === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = NO_COLOR
  }
}

/*
 * ВИДИМАЯ ШИРИНА: СНИМАЕТСЯ НЕ ТОЛЬКО ЦВЕТ.
 *
 * Ширина считается по знакам, которые человек видит на экране: 'ESC[32m✓ESC[0m' занимает одну
 * позицию, а .length считает девять, и правая стенка рамки уезжает на восемь.
 *
 * Прежняя версия ловила лишь раскраску `ESC[…m`. Этого хватало ровно до того, как в выводе появилась
 * очистка строки `ESC[2K`: её она считала за четыре видимых знака. Проверки ниже перебирают виды
 * последовательностей, а не один удобный.
 */
{
  const E = String.fromCharCode(27)
  const BEL = String.fromCharCode(7)
  const cases = [
    ['обычный текст без управляющих знаков', 'обычный текст', 13],
    ['раскраска', `${E}[32m✓${E}[0m`, 1],
    ['очистка строки — то, из-за чего расширяли', `\r${E}[2Kтекст`, 6],
    ['перемещение курсора', `${E}[1;5Hтекст`, 5],
    ['заголовок окна, завершённый BEL', `${E}]0;заголовок${BEL}x`, 1],
    ['заголовок окна, завершённый ST', `${E}]0;заголовок${E}\\x`, 1],
    ['переключатель набора знаков', `${E}(Bтекст`, 5],
    ['восьмибитный CSI вместо ESC[', '32mтекст', 5],
    ['пустая строка', '', 0],
    ['null и undefined', null, 0],
    // Квадратная скобка без ESC — это обычный текст, и съедать его нельзя.
    ['текст, похожий на управляющий', '[2K это просто текст', 20],
  ]
  for (const [name, input, expected] of cases) {
    assert.equal(visibleWidth(input), expected, `видимая ширина: ${name}`)
  }
  // Рамка не разъезжается: строка с цветом и очисткой занимает столько же, сколько её голый текст.
  assert.equal(visibleWidth(`${E}[2m│${E}[0m`), visibleWidth('│'))
}

// Сама палитра: решение принимается по isTTY ПЕРЕДАННОГО потока и ни по чему больше.
{
  const NO_COLOR = process.env.NO_COLOR
  delete process.env.NO_COLOR
  try {
    assert.equal(colorsFor({ isTTY: false }).green('✓'), '✓')
    assert.ok(colorsFor({ isTTY: true }).green('✓').includes(String.fromCharCode(27)))
    // Ни undefined, ни отсутствующий поток не должны включать цвет и не должны падать.
    assert.equal(colorsFor(undefined).green('✓').includes(String.fromCharCode(27)), Boolean(process.stdout.isTTY))
    assert.equal(colorsFor({}).green('✓'), '✓')
    process.env.NO_COLOR = '1'
    assert.equal(colorsFor({ isTTY: true }).green('✓'), '✓', 'NO_COLOR не соблюдён палитрой')
  } finally {
    if (NO_COLOR === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = NO_COLOR
  }
}

/*
 * Диалог пишет в СВОЙ поток и палитру берёт по нему же — та же причина, что у спиннера.
 *
 * Пара обязательна и здесь. Проверка только на не-терминальном потоке была бы такой же
 * средозависимой, как исходный дефект: в конвейере она проходит при любой реализации, потому что
 * глобальный stdout там тоже не терминал. Терминальный случай — единственный, который отличает
 * «палитра по своему потоку» от «палитра по process.stdout».
 */
{
  const NO_COLOR = process.env.NO_COLOR
  delete process.env.NO_COLOR
  const quietOut = new PassThrough()
  const paintedOut = new PassThrough()
  paintedOut.isTTY = true
  const quiet = new Ask(new PassThrough(), quietOut)
  const painted = new Ask(new PassThrough(), paintedOut)
  try {
    assert.equal(quietOut.isTTY, undefined, 'PassThrough внезапно стал терминалом — проверка потеряла смысл')
    assert.equal(quiet.c.green('✓'), '✓', 'диалог красит вывод в не-терминальный поток')
    assert.ok(
      painted.c.green('✓').includes(String.fromCharCode(27)),
      'диалог не красит терминальный поток — значит смотрит не на него',
    )
  } finally {
    quiet.close()
    painted.close()
    if (NO_COLOR === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = NO_COLOR
  }
}

// В терминале — одна итоговая строка вместо бегущей, а таймер обязательно остановлен.
{
  const written = []
  const fake = { isTTY: true, write: (text) => { written.push(text); return true } }
  const previous = process.env.NO_COLOR
  delete process.env.NO_COLOR
  const spinner = new Spinner(fake)
  spinner.start('идёт')
  assert.notEqual(spinner.timer, null, 'в терминале анимация запускается')
  spinner.succeed('кончилось')
  assert.equal(spinner.timer, null, 'после остановки таймера нет — иначе процесс не завершится')
  if (previous !== undefined) process.env.NO_COLOR = previous
}

assert.ok(banner('Nemo SDR', 'подзаголовок').includes('Nemo SDR'))

// --- CSV: экранирование по RFC 4180 ---------------------------------------------------------------
// Файл откроют в Excel. Кавычки удваиваются, а не гасятся слешем; перевод строки внутри питча
// обязывает взять ячейку в кавычки, иначе одна строка станет двумя.

assert.equal(csvCell('Дента'), 'Дента')
assert.equal(csvCell('Дента, филиал'), '"Дента, филиал"')
assert.equal(csvCell('Клиника "Смайл"'), '"Клиника ""Смайл"""')
assert.equal(csvCell('строка1\nстрока2'), '"строка1\nстрока2"')
assert.equal(csvCell('точка;с;запятой'), '"точка;с;запятой"', 'Excel в русской локали делит по «;»')
assert.equal(csvCell(null), '')
assert.equal(csvCell(undefined), '')
assert.equal(csvCell(0), '0', 'ноль — это значение, а не пустота')

{
  const lead = {
    name: 'Дента', city: 'Ташкент', phone: '+998712003040', website: 'https://d.uz',
    address: null, rating: 4.7, reviews: 12,
    enrichment: { emails: ['a@b.uz'], socials: { telegram: 'https://t.me/x', instagram: null } },
    score: { score: 85, status: 'HOT', reason: 'Причина, с запятой', key_decision_maker: null, icebreaker_pitch: 'Питч "в кавычках"' },
  }
  const csv = toCsv([lead])
  // BOM: без него Excel на Windows читает UTF-8 как ANSI, и русский текст превращается в вопросы
  // ещё до того, как владелец успеет что-то заподозрить.
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'BOM на месте')
  assert.ok(csv.includes('\r\n'), 'переводы строк CRLF, как ждёт Excel')
  assert.ok(csv.includes('"Причина, с запятой"'))
  assert.ok(csv.includes('"Питч ""в кавычках"""'))
  assert.ok(csv.includes('icebreaker'), 'колонка с питчем есть — за ней и приходят')

  // Пустой список — только заголовок, а не пустой файл: по нему видно, что выгрузка сработала.
  const empty = toCsv([])
  assert.ok(empty.includes('name,city'))
  assert.equal(empty.split('\r\n').filter(Boolean).length, 1)

  assert.deepEqual(JSON.parse(toJson([lead]))[0].name, 'Дента')
  assert.deepEqual(JSON.parse(toJson([])), [])
}

// Имя файла со отметкой времени: второй прогон не должен затирать первый.
{
  const a = exportFileName('csv', new Date('2026-08-17T12:00:00Z'))
  const b = exportFileName('csv', new Date('2026-08-17T12:00:01Z'))
  assert.notEqual(a, b, 'разные секунды — разные файлы')
  assert.ok(a.endsWith('.csv'))
  assert.equal(a.includes(':'), false, 'двоеточие в имени файла Windows не принимает')
}

// Запись на диск — с настоящим файлом, а не с моком: путь и кодировка тоже часть поведения.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-export-'))
  const file = writeExport([{ name: 'Дента', enrichment: {}, score: null }], 'csv', dir)
  assert.ok(fs.existsSync(file))
  assert.ok(fs.readFileSync(file, 'utf8').includes('Дента'), 'русский текст читается обратно')
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- Буфер обмена: команда под систему -------------------------------------------------------------

assert.deepEqual(clipboardCommand('win32'), { command: 'clip', args: [] })
assert.deepEqual(clipboardCommand('darwin'), { command: 'pbcopy', args: [] })
assert.equal(clipboardCommand('linux').command, 'xclip')

// --- Спиннер и вопрос не делят одну строку --------------------------------------------------------
//
// ЭТО ГЛАВНЫЙ БАГ ФАЙЛА, и он возвращался дважды: спиннер, оставленный включённым, каждые 80 мс
// перезаписывает строку, в которой readline уже ждёт ввод, и набранный человеком текст расползается
// по экрану. Проверяется на поддельном терминале — иначе баг ловится только руками.

/** Поток, который выглядит терминалом и запоминает всё, что в него написали. */
function fakeTty() {
  const stream = new PassThrough()
  stream.isTTY = true
  stream.written = ''
  stream.on('data', (chunk) => { stream.written += String(chunk) })
  return stream
}

{
  const out = fakeTty()
  const spinner = new Spinner(out)
  spinner.start('Поиск…')
  assert.notEqual(spinner.timer, null, 'на терминале спиннер должен анимировать')

  // Вопрос человеку гасит анимацию САМ, а не надеется на вызывающий код.
  const ask = new Ask(new PassThrough(), out)
  const answer = ask.line('❯ ')
  assert.equal(spinner.timer, null, 'спиннер погашен ДО того, как readline получил терминал')

  const before = out.written.length
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(out.written.length, before, 'после останова спиннер не должен дописывать кадры')

  ask.rl.write('стоматология\n')
  assert.equal(await answer, 'стоматология', 'ответ дошёл целиком, без вмешательства спиннера')
  ask.close()
}

// silence() убирает бегущую строку и НЕ печатает итог: перед вопросом «✓ Готовлюсь» над приглашением
// ввода — мусор, а не отчёт.
{
  const out = fakeTty()
  const spinner = new Spinner(out).start('Готовлюсь')
  // Ждём настоящий кадр: без него стирать нечего, и проверка «строка стёрта» проходит сама собой,
  // ничего не проверяя.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(out.written.includes('Готовлюсь'), 'кадр действительно напечатан')

  spinner.silence()
  assert.equal(out.written.includes('✓'), false, 'итога быть не должно — отчитываются succeed/fail')
  // Последнее, что ушло в терминал, — возврат каретки и очистка строки. Иначе текст спиннера
  // останется висеть над приглашением ввода.
  assert.ok(out.written.endsWith(`\r${String.fromCharCode(27)}[2K`), 'бегущая строка стёрта последним действием')
}

// Повторный итог не печатается: путь через платформу отчитывается сам, и вызывающий код добавлял
// вторую строку под первой.
{
  const out = fakeTty()
  const spinner = new Spinner(out).start('Работаю')
  spinner.succeed('Готово: найдено 4')
  const afterFirst = out.written
  spinner.succeed('Готово: найдено 4')
  assert.equal(out.written, afterFirst, 'второй succeed молчит')
}

// А ошибку после silence() напечатать МОЖНО: гашение перед вопросом не означает, что отчитываться
// больше не о чем.
{
  const out = fakeTty()
  const spinner = new Spinner(out).start('Работаю')
  spinner.silence()
  spinner.fail('город не найден')
  assert.ok(out.written.includes('город не найден'))
}

// Второй спиннер гасит первый: две анимации в одной строке дают кашу из перезаписанных кадров.
{
  const out = fakeTty()
  const first = new Spinner(out).start('Первый')
  const second = new Spinner(out).start('Второй')
  assert.equal(first.timer, null, 'первый остановлен')
  assert.notEqual(second.timer, null, 'второй работает')
  second.silence()
}

// В НЕ-терминале анимации нет вовсе: возврат каретки в файле журнала превращает его в кашу, а
// именно в журнал этот вывод и попадёт из cron.
{
  const plain = new PassThrough()
  plain.written = ''
  plain.on('data', (chunk) => { plain.written += String(chunk) })
  const spinner = new Spinner(plain).start('Поиск…')
  assert.equal(spinner.timer, null)
  assert.equal(plain.written.includes(String.fromCharCode(27)), false, 'никаких escape-последовательностей в журнале')
  assert.ok(plain.written.includes('Поиск…'), 'но сам этап в журнале виден')
}

/*
 * ЯЧЕЙКА ШИРЕ КОЛОНКИ НЕ ИМЕЕТ ПРАВА СДВИГАТЬ РАМКУ.
 *
 * padVisible умел только добивать пробелами. Строка «Инструменты: 5 активны [OSM, Browser,
 * run_qa_audit, FS]» в колонку на 31 знак не влезала — и выталкивала разделитель вправо: в живом
 * запуске шапка выглядела покосившейся ровно на одной строке из четырёх, и чем больше инструментов
 * подключено, тем сильнее.
 *
 * Проверяется РАВЕНСТВО ШИРИН всех строк панели, а не наличие многоточия: многоточие — способ,
 * ровная рамка — цель. И отдельно проверяется, что обрезка не рубит escape-последовательность
 * пополам: в терминал тогда уходит мусор, а цвет растекается на остаток строки.
 */
check: {
  const paint = colorsFor({ isTTY: true })
  for (const cells of [
    ['Инструменты: 5 активны [OSM, Browser, run_qa_audit, FS]'],
    ['я'.repeat(200)],
    [paint.magenta('очень длинная раскрашенная строка, которая не влезает в колонку')],
    [`${paint.green('зелёное')} и ${paint.red('красное')} вперемешку, и всё это длиннее колонки`],
    [''],
    ['короткая'],
  ]) {
    const panel = dashboard({ title: 'т', left: cells, right: ['правая колонка'] })
    const widths = [...new Set(panel.split('\n').map((one) => visibleWidth(one)))]
    assert.equal(widths.length, 1, `рамка разъехалась на ${JSON.stringify(cells[0]).slice(0, 60)}: ширины ${widths}`)
    // Оборванная последовательность оставила бы в видимом тексте хвост вида «[35m».
    const body = panel.split('\n')[1]
    assert.equal(/\[\d+m/.test(stripAnsi(body)), false, `escape-последовательность разрублена: ${JSON.stringify(body)}`)
  }
}

// Цвет внутри обрезанной ячейки закрыт сбросом — иначе он растечётся на соседнюю колонку.
check: {
  const paint = colorsFor({ isTTY: true })
  const panel = dashboard({ title: 'т', left: [paint.magenta('я'.repeat(80))], right: ['правая'] })
  const row = panel.split('\n')[1]
  const afterClip = row.slice(row.indexOf('…'))
  assert.ok(afterClip.includes(`${String.fromCharCode(27)}[0m`), 'после обрезки нет сброса цвета')
}

console.log(`[OK] TUI behaviour: ${checks} assertions`)
