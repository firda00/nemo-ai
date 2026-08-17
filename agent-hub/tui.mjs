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
  constructor() {
    this.rl = readline.createInterface({ input: stdin, output: stdout })
    // Ctrl+C посреди вопроса — обычный способ уйти, а не сбой. Без этого Node печатает трассировку.
    this.rl.on('SIGINT', () => { stdout.write(`\n${c.dim('прервано')}\n`); process.exit(130) })
  }

  close() { this.rl.close() }

  async text(question, options = {}) {
    for (;;) {
      const hint = options.fallback ? c.dim(` [${options.fallback}]`) : ''
      const placeholder = options.placeholder ? `\n   ${c.dim(`например: ${options.placeholder}`)}` : ''
      const raw = await this.rl.question(`\n${c.cyan('?')} ${c.bold(question)}${hint}${placeholder}\n   `)
      const verdict = resolveInput(raw, options)
      if (verdict.ok) return verdict.value
      stdout.write(`   ${c.red('×')} ${verdict.error}\n`)
    }
  }

  async select(question, options, defaultIndex = 0) {
    stdout.write(`\n${c.cyan('?')} ${c.bold(question)}\n`)
    for (const [index, option] of options.entries()) stdout.write(`${renderOption(option, index, defaultIndex)}\n`)
    for (;;) {
      const raw = await this.rl.question('   ')
      const verdict = resolveSelect(raw, options, defaultIndex)
      if (verdict.ok) return verdict.value
      stdout.write(`   ${c.red('×')} ${verdict.error}\n`)
    }
  }
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

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
  }

  start(text) {
    this.text = text
    if (!this.animated) { this.output.write(`… ${text}\n`); return this }
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length
      this.output.write(`\r${ESC}[2K${c.cyan(FRAMES[this.frame])} ${this.text}`)
    }, 80)
    // unref: висящий таймер не должен держать процесс живым, если работа уже кончилась.
    this.timer.unref?.()
    return this
  }

  update(text) {
    this.text = text
    if (!this.animated) this.output.write(`… ${text}\n`)
    return this
  }

  /** Останавливает анимацию и оставляет ОДНУ итоговую строку вместо бегущей. */
  stop(mark, text) {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
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
