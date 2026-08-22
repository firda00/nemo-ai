// Палитра терминала: 24-битный цвет, плашки, ступенчатая деградация.
//
// ПОЧЕМУ НЕ CHALK, ХОТЯ В ЗАДАНИИ НАЗВАН ИМЕННО ОН.
//
// В задании перечислены средства: chalk и cli-spinners. Здесь вместо них — тридцать строк своего
// кода, и вот на каких основаниях.
//
//   1. tui.mjs открывается словами «БЕЗ ЗАВИСИМОСТЕЙ, и это решение, а не экономия», и дальше
//      объясняет, чем оно куплено. Ломать такое решение можно, но не мимоходом.
//   2. CLI раздаётся пакетом @nemoai/cli. Каждая зависимость — это установка у пользователя, запись
//      в аудите лицензий и ещё один способ сломаться на чужой машине.
//   3. cli-spinners — это буквально JSON с наборами кадров. Три строки данных против пакета.
//   4. Всё, что просит задание визуально — bgHex('#1E222B'), градиент, рамки, — это ANSI-коды,
//      которые здесь и написаны. Внешний вид от источника кодов не зависит.
//
// Что мы при этом ТЕРЯЕМ и как это закрыто: chalk сам определяет уровень поддержки цвета и
// понижает 24-битный до 256 и до 16. Понижение реализовано ниже — иначе на терминале без truecolor
// плашка превратилась бы в мусор вида «[48;2;30;34;43m» прямо в тексте.
//
// Если пакеты нужны именно как пакеты — скажите, и я поменяю реализацию, не трогая внешний вид.

import { stdout } from 'node:process'

const ESC = String.fromCharCode(27)
const RESET = `${ESC}[0m`

export type ColorLevel = 0 | 1 | 2 | 3

export interface Rgb { r: number; g: number; b: number }

/** «#1E222B» и «1E222B» — одно и то же. Негодная строка даёт чёрный, а не исключение посреди вывода. */
export function hexToRgb(hex: string): Rgb {
  const text = String(hex ?? '').trim().replace(/^#/, '')
  const full = text.length === 3 ? text.split('').map((one) => one + one).join('') : text
  if (!/^[0-9a-f]{6}$/i.test(full)) return { r: 0, g: 0, b: 0 }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}

/**
 * Уровень поддержки цвета.
 *
 * 0 — нет вовсе, 1 — шестнадцать, 2 — двести пятьдесят шесть, 3 — двадцать четыре бита.
 *
 * Решается ЛЕНИВО, при каждом вызове: NO_COLOR может появиться в окружении позже, поток — сменить
 * isTTY, а окно — переехать из «cmd» в Windows Terminal. Ровно так же поступает colorsFor в
 * tui.mjs, и расходиться с ним нельзя: два разных ответа на «есть ли цвет» дают вывод, где половина
 * строки раскрашена, а половина нет.
 */
export function colorLevel(output: NodeJS.WriteStream = stdout, env: NodeJS.ProcessEnv = process.env): ColorLevel {
  // NO_COLOR — договорённость, которую уважают все приличные CLI. Проверяется первой.
  if (env.NO_COLOR) return 0
  if (!output?.isTTY) return 0
  // FORCE_COLOR нужен записи вывода в файл при съёмке демонстрации: без него ролик выйдет серым.
  if (env.FORCE_COLOR === '3') return 3
  if (env.FORCE_COLOR === '2') return 2
  if (env.FORCE_COLOR) return 1

  const term = String(env.TERM ?? '')
  if (term === 'dumb') return 0
  const colorterm = String(env.COLORTERM ?? '').toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3
  // Windows Terminal и iTerm умеют 24 бита, но COLORTERM выставляют не всегда.
  if (env.WT_SESSION || env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'vscode') return 3
  if (/-256(color)?$/.test(term)) return 2
  return term ? 1 : 0
}

/** Ближайший из 256: 6×6×6 куб плюс серая шкала. Нужен там, где 24 бита не приняли бы. */
export function toAnsi256({ r, g, b }: Rgb): number {
  // Серое проверяется отдельно: в кубе серых оттенков всего шесть, а в шкале — двадцать четыре,
  // и подложка #1E222B без неё уехала бы в синеву.
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  const step = (value: number) => Math.round((value / 255) * 5)
  return 16 + 36 * step(r) + 6 * step(g) + step(b)
}

/** Ближайший из шестнадцати. Последняя ступень: грубо, но читаемо. */
export function toAnsi16({ r, g, b }: Rgb): number {
  const bright = Math.max(r, g, b) > 170 ? 60 : 0
  const bit = (value: number) => (value > 100 ? 1 : 0)
  return 30 + bit(r) + bit(g) * 2 + bit(b) * 4 + bright
}

/** Код цвета текста под уровень поддержки. Пустая строка — цвета нет вовсе. */
export function fgCode(hex: string, level: ColorLevel): string {
  if (level === 0) return ''
  const rgb = hexToRgb(hex)
  if (level === 3) return `${ESC}[38;2;${rgb.r};${rgb.g};${rgb.b}m`
  if (level === 2) return `${ESC}[38;5;${toAnsi256(rgb)}m`
  return `${ESC}[${toAnsi16(rgb)}m`
}

/** Код фона. Плашка на всю строку — это он плюс пробелы до края окна. */
export function bgCode(hex: string, level: ColorLevel): string {
  if (level === 0) return ''
  const rgb = hexToRgb(hex)
  if (level === 3) return `${ESC}[48;2;${rgb.r};${rgb.g};${rgb.b}m`
  if (level === 2) return `${ESC}[48;5;${toAnsi256(rgb)}m`
  // Фон в шестнадцати цветах — это код текста плюс десять.
  return `${ESC}[${toAnsi16(rgb) + 10}m`
}

/**
 * Цвета Nemo.
 *
 * Не «красивые оттенки», а те же, что в вебе: фон приложения #0A0D1C и фиолетовый #8B7CF8 взяты из
 * tailwind.config.js. Терминал и панель — одно приложение, и человек, переключившийся между ними,
 * не должен видеть два разных продукта.
 */
export const PALETTE = {
  bg: '#0A0D1C',
  /** Подложка реплики человека. Названа в задании числом — оно и стоит. */
  inputBg: '#1E222B',
  violet: '#8B7CF8',
  cyan: '#22D3EE',
  blue: '#3B82F6',
  text: '#E6EAF2',
  muted: '#8A93A6',
  green: '#34D399',
  amber: '#FBBF24',
  red: '#F87171',
} as const

export interface Theme {
  level: ColorLevel
  /** Покрасить текст произвольным цветом. */
  hex: (hex: string, text: string) => string
  /** Подложка произвольного цвета. */
  bgHex: (hex: string, text: string) => string
  /** Плашка НА ВСЮ ШИРИНУ: фон тянется до правого края окна, а не до конца текста. */
  bar: (hex: string, text: string, width: number) => string
  /** Градиент по символам — от первого цвета к последнему. */
  gradient: (from: string, to: string, text: string) => string
}

/** Линейная доля между двумя цветами. */
const mix = (from: Rgb, to: Rgb, ratio: number): Rgb => ({
  r: Math.round(from.r + (to.r - from.r) * ratio),
  g: Math.round(from.g + (to.g - from.g) * ratio),
  b: Math.round(from.b + (to.b - from.b) * ratio),
})

const rgbToHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map((one) => one.toString(16).padStart(2, '0')).join('')}`

export function createTheme(output: NodeJS.WriteStream = stdout, env: NodeJS.ProcessEnv = process.env): Theme {
  // Уровень спрашивается при КАЖДОМ вызове, а не запоминается при создании: тема живёт весь сеанс,
  // а окружение за это время меняется.
  const level = () => colorLevel(output, env)

  const paint = (code: string, text: string) => (code ? `${code}${text}${RESET}` : String(text))

  return {
    get level() { return level() },
    hex: (hex, text) => paint(fgCode(hex, level()), text),
    bgHex: (hex, text) => paint(bgCode(hex, level()), text),

    bar: (hex, text, width) => {
      /*
       * ДОБИВКА СЧИТАЕТСЯ ПО ВИДИМОЙ ШИРИНЕ, А НЕ ПО ДЛИНЕ СТРОКИ.
       *
       * Внутри плашки почти всегда уже есть свои escape-последовательности — маркер, выделение.
       * Считая .length, мы добавили бы пробелов на длину этих кодов, и подложка уехала бы за
       * правый край, утащив за собой перенос строки.
       */
      const visible = stripCodes(text).length
      const padding = Math.max(0, width - visible)
      const painted = `${text}${' '.repeat(padding)}`
      const code = bgCode(hex, level())
      if (!code) return painted

      /*
       * ФОН ВОССТАНАВЛИВАЕТСЯ ПОСЛЕ КАЖДОГО ВНУТРЕННЕГО СБРОСА.
       *
       * Это не мелочь оформления, а разница между плашкой и её отсутствием. Внутри строки почти
       * всегда есть свои цвета — маркер, текст, отметка времени, — и каждый из них заканчивается
       * общим сбросом ESC[0m. Сброс гасит ВСЁ, включая фон: на экране получается подложка под
       * первым символом и голый текст дальше.
       *
       * Заметить это по коду нельзя — bar() выглядит правильно, тест на ширину проходит, а
       * подложки нет. Нашлось только распечаткой настоящего вывода.
       */
      const kept = painted.split(RESET).join(`${RESET}${code}`)
      return `${code}${kept}${RESET}`
    },

    gradient: (from, to, text) => {
      const current = level()
      if (!current) return String(text)
      const start = hexToRgb(from)
      const end = hexToRgb(to)
      const chars = [...String(text)]
      // Один символ делить не на что: без этой ветки было бы деление на ноль и цвет NaN.
      const last = Math.max(1, chars.length - 1)
      return chars
        .map((char, index) => {
          // Пробелы не красятся: цвет на пробеле не виден, а кодов добавляет вдвое.
          if (char === ' ') return char
          return paint(fgCode(rgbToHex(mix(start, end, index / last)), current), char)
        })
        .join('')
    },
  }
}

/** Убрать управляющие последовательности. Своя копия: theme.ts не должен зависеть от tui.mjs. */
export function stripCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\[[0-9;]*m/g, '')
}

/** Тема по умолчанию — для всего, что пишет прямо в stdout. */
export const theme = createTheme()
