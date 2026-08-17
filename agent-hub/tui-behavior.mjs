// Интерактивный режим: разбор ответов, спиннер, выгрузка.
//
// Проверяется всё, что можно проверить БЕЗ терминала, — и это почти всё, потому что разбор ответов
// вынесен из самих вопросов именно для этого. Главное здесь: интерактив не должен включаться там,
// где спрашивать некого, а спиннер не должен сыпать escape-последовательностями в файл журнала.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Spinner, banner, isInteractiveTerminal, renderOption, resolveInput, resolveSelect } from './tui.mjs'
import { clipboardCommand, csvCell, exportFileName, toCsv, toJson, writeExport } from './lead-export.mjs'

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

console.log('[OK] TUI behaviour: 58 assertions')
