// Примитивы интерактивного режима: ввод, выбор, спиннер.
//
// БЕЗ ЗАВИСИМОСТЕЙ, и это решение, а не экономия. Ввод текста даёт node:readline/promises из
// коробки. Выбор сделан НУМЕРОВАННЫМ, а не стрелками: стрелки требуют raw-режима терминала и молча
// ломаются там, где этот скрипт как раз и будет жить — ssh на VPS, вложенный shell, `npm run` через
// обёртку, окно без ANSI. Цифра работает везде. Спиннер — пятнадцать строк ANSI, ради которых
// тянуть пакет незачем.
//
// ГЛАВНОЕ ПРАВИЛО ФАЙЛА: ничто здесь не должно ЖДАТЬ ВВОДА, когда вводить некому. Скрипт из cron
// или из CI, повисший на невидимом вопросе, выглядит как зависший пайплайн, и разбираться в этом
// будут по таймауту через час.

import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

/** Есть ли живой терминал по обе стороны. Без него интерактив запускать нельзя. */
export function isInteractiveTerminal(input = stdin, output = stdout) {
  return Boolean(input.isTTY && output.isTTY)
}

// NO_COLOR — договорённость, которую уважают все приличные CLI. Плюс отключаем цвет, когда вывод
// уходит в файл или в конвейер: escape-последовательности в логе читать невозможно.
const useColor = () => Boolean(stdout.isTTY) && !process.env.NO_COLOR

// ESC через код символа, а не escape-последовательностью в литерале: литерал уже один раз пропал
// при правке файла, и цвета молча превратились в мусор вида «[2m» прямо в выводе.
const ESC = String.fromCharCode(27)
const CODES = { dim: '2', bold: '1', red: '31', green: '32', yellow: '33', cyan: '36', magenta: '35' }
function paint(name, text) {
  return useColor() ? `${ESC}[${CODES[name]}m${text}${ESC}[0m` : String(text)
}
export const c = Object.fromEntries(Object.keys(CODES).map((name) => [name, (text) => paint(name, text)]))

/**
 * Что делать с ответом на текстовый вопрос.
 *
 * Вынесено из самого вопроса, чтобы проверяться без терминала: пустой ввод при наличии значения по
 * умолчанию — это согласие, а не пропуск, и путать эти два случая нельзя.
 */
export function resolveInput(raw, { fallback = '', required = false, min = 0 } = {}) {
  const text = String(raw ?? '').trim()
  if (!text) {
    if (fallback) return { ok: true, value: fallback }
    return required ? { ok: false, error: 'нужно что-то ввести' } : { ok: true, value: '' }
  }
  if (min && text.length < min) return { ok: false, error: `минимум ${min} символа` }
  return { ok: true, value: text }
}

/**
 * Что делать с ответом на нумерованный выбор.
 *
 * Принимается и номер, и сам текст варианта: человек, набравший «50» вместо «3», имел в виду ровно
 * то, что написано в списке, и отказывать ему формально — грубость.
 */
export function resolveSelect(raw, options, defaultIndex = 0) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: true, index: defaultIndex, value: options[defaultIndex] }

  const asNumber = Number(text)
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return { ok: true, index: asNumber - 1, value: options[asNumber - 1] }
  }
  const byLabel = options.findIndex((one) => String(one.label ?? one).toLowerCase() === text.toLowerCase())
  if (byLabel >= 0) return { ok: true, index: byLabel, value: options[byLabel] }
  const byValue = options.findIndex((one) => String(one.value ?? one) === text)
  if (byValue >= 0) return { ok: true, index: byValue, value: options[byValue] }

  return { ok: false, error: `введите номер от 1 до ${options.length}` }
}

/** Одна строка списка вариантов. Значение по умолчанию помечено, чтобы Enter был осмысленным. */
export function renderOption(option, index, defaultIndex) {
  const label = String(option.label ?? option)
  const mark = index === defaultIndex ? c.green('●') : c.dim('○')
  const suffix = index === defaultIndex ? c.dim(' (Enter)') : ''
  return `   ${mark} ${c.bold(String(index + 1))}) ${label}${suffix}`
}

/** Диалог с человеком. Держит один readline на всю сессию — по одному на вопрос текут дескрипторы. */
export class Ask {
  // Потоки принимаются параметрами, чтобы проверять диалог БЕЗ терминала: главный баг этого файла —
  // спиннер, не погашенный перед вопросом, — иначе воспроизводится только руками и возвращается.
  constructor(input = stdin, output = stdout, options = {}) {
    this.output = output
    // completer — функция строки, возвращающая [совпадения, исходная строка]: это форма, которую ждёт
    // readline. Передаётся снаружи, потому что список команд знает CLI, а не отрисовка.
    this.rl = readline.createInterface({ input, output, completer: options.completer })
    // Ctrl+C посреди вопроса — обычный способ уйти, а не сбой. Без этого Node печатает трассировку.
    this.rl.on('SIGINT', () => { this.output.write(`\n${c.dim('прервано')}\n`); process.exit(130) })
  }

  close() { this.rl.close() }

  /** Сырая строка от человека. Спиннер гасится ЗДЕСЬ — до того, как readline получит терминал. */
  async line(prompt) {
    stopActiveSpinner()
    return await this.rl.question(prompt)
  }

  async text(question, options = {}) {
    for (;;) {
      const hint = options.fallback ? c.dim(` [${options.fallback}]`) : ''
      const raw = await this.line(`${c.cyan('?')} ${question}${hint}\n${c.magenta('❯')} `)
      const verdict = resolveInput(raw, options)
      if (verdict.ok) return verdict.value
      this.output.write(`  ${c.red('×')} ${verdict.error}\n`)
    }
  }

  async select(question, options, defaultIndex = 0) {
    stopActiveSpinner()
    this.output.write(`${c.cyan('?')} ${question}\n`)
    for (const [index, option] of options.entries()) this.output.write(`${renderOption(option, index, defaultIndex)}\n`)
    for (;;) {
      const raw = await this.line(`${c.magenta('❯')} `)
      const verdict = resolveSelect(raw, options, defaultIndex)
      if (verdict.ok) return verdict.value
      this.output.write(`  ${c.red('×')} ${verdict.error}\n`)
    }
  }
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Единственный бегущий спиннер на процесс.
 *
 * Нужен ради ОДНОГО бага, который иначе возвращается снова и снова: спиннер, забытый включённым,
 * продолжает писать в ту же строку, где readline ждёт ввод, и набранный текст расползается по
 * экрану. Полагаться на то, что каждый путь выхода (включая ветки ошибок) не забудет остановить
 * таймер, нельзя — забыли уже дважды. Поэтому останов гарантируется здесь, а не в вызывающем коде:
 * любой вопрос человеку сначала гасит спиннер.
 */
let active = null

export function stopActiveSpinner() {
  if (!active) return
  active.silence()
  active = null
}

/**
 * Спиннер, который не портит вывод.
 *
 * В НЕ-терминале не анимирует ВООБСЕ, а печатает обычные строки: escape-последовательности и
 * возврат каретки в файле журнала превращают его в кашу, а именно в журнал этот вывод и попадёт,
 * когда прогон запустят из cron.
 */
export class Spinner {
  constructor(output = stdout) {
    this.output = output
    this.animated = Boolean(output.isTTY) && !process.env.NO_COLOR
    this.timer = null
    this.frame = 0
    this.text = ''
    this.settled = false
  }

  start(text) {
    this.text = text
    this.settled = false
    // Второй спиннер поверх первого — две анимации в одной строке. Гасим предыдущий.
    stopActiveSpinner()
    if (!this.animated) { this.output.write(`… ${text}\n`); return this }
    active = this
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length
      this.output.write(`\r${ESC}[2K${c.cyan(FRAMES[this.frame])} ${this.text}`)
    }, 80)
    // unref: висящий таймер не должен держать процесс живым, если работа уже кончилась.
    this.timer.unref?.()
    return this
  }

  /**
   * Остановить БЕЗ итоговой строки и стереть бегущую.
   *
   * Нужно перед вопросом человеку: строка спиннера должна исчезнуть, а не остаться «✓ Готовлюсь»
   * над приглашением ввода. Отчёт о результате печатает succeed/fail, а это — просто тишина.
   */
  silence() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.animated) this.output.write(`\r${ESC}[2K`)
    if (active === this) active = null
    return this
  }

  update(text) {
    this.text = text
    if (!this.animated) this.output.write(`… ${text}\n`)
    return this
  }

  /**
   * Останавливает анимацию и оставляет ОДНУ итоговую строку вместо бегущей.
   *
   * Повторный вызов ничего не печатает. Иначе путь через платформу отчитывался дважды: сам прогон
   * уже написал «✓ Готово. Найдено 14…», а вызывающий код добавлял вторую итоговую строку под ней.
   */
  stop(mark, text) {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (active === this) active = null
    if (this.settled) return this
    this.settled = true
    const line = `${mark} ${text ?? this.text}`
    if (this.animated) this.output.write(`\r${ESC}[2K${line}\n`)
    else this.output.write(`${line}\n`)
    return this
  }

  succeed(text) { return this.stop(c.green('✓'), text) }
  fail(text) { return this.stop(c.red('×'), text) }
}

/** Рамка вокруг заголовка — чтобы шаги опросника не сливались с логом прогона. */
export function banner(title, subtitle = '') {
  const line = '─'.repeat(Math.max(title.length, subtitle.length) + 2)
  const out = [c.dim(`┌${line}┐`), ` ${c.bold(title)}`]
  if (subtitle) out.push(` ${c.dim(subtitle)}`)
  out.push(c.dim(`└${line}┘`))
  return out.join('\n')
}

/**
 * Видимая ширина строки: без escape-последовательностей цвета.
 *
 * Без этого рамка разъезжается ровно там, где в неё попал цвет: 'ESC[32m✓ESC[0m' занимает на
 * экране один знак, а .length считает девять, и правая стенка уезжает на восемь позиций.
 */
// Регексп собирается из ESC, а не пишется литералом: литеральный управляющий байт в исходнике
// уже один раз пропал при правке этого же файла, и цвета превратились в мусор в выводе.
const ANSI = new RegExp(ESC + '\[[0-9;]*m', 'g')

export function visibleWidth(text) {
  return [...String(text ?? '').replace(ANSI, '')].length
}

function padVisible(text, width) {
  const gap = Math.max(0, width - visibleWidth(text))
  return `${text}${' '.repeat(gap)}`
}

/**
 * Двухколоночная панель состояния в рамке.
 *
 * Левая колонка — про этот запуск (аккаунт, баланс, шлюз), правая — что делать дальше. Человек,
 * открывший CLI впервые, должен увидеть и то, чем он располагает, и как начать, не читая README.
 */
export function dashboard({ title, left = [], right = [], leftWidth = 31, rightWidth = 45 }) {
  const rows = Math.max(left.length, right.length)
  const titleText = ` ${title} `
  // Внутренняя ширина строки: пробел + левая колонка + разделитель + пробел + правая колонка.
  // Считается ОДИН раз и используется всеми тремя видами строк — иначе верхняя граница расходится с
  // нижней на один знак, и рамка выглядит покосившейся.
  const inner = leftWidth + rightWidth + 3
  const topFill = '─'.repeat(Math.max(0, inner - visibleWidth(titleText)))
  const out = [c.dim(`┌${titleText}${topFill}┐`)]
  for (let index = 0; index < rows; index++) {
    const l = padVisible(left[index] ?? '', leftWidth)
    const r = padVisible(right[index] ?? '', rightWidth)
    out.push(`${c.dim('│')} ${l}${c.dim('│')} ${r}${c.dim('│')}`)
  }
  out.push(c.dim(`└${'─'.repeat(leftWidth + 1)}┴${'─'.repeat(rightWidth + 1)}┘`))
  return out.join('\n')
}

/** Компактное меню одной строкой: клавиши слева, действия справа, разделитель — вертикальная черта. */
export function statusMenu(items) {
  return items.map(({ key, label }) => `${c.bold(`[${key}]`)} ${label}`).join(c.dim(' │ '))
}

