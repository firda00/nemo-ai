// Шапка терминала: логотип, строка состояния, блок предупреждений.
//
// ЧИСТЫЕ ФУНКЦИИ, ВОЗВРАЩАЮЩИЕ СТРОКИ. Ничего не печатают и не спрашивают окружение сами — ширина,
// тема, версия и путь приходят снаружи. Иначе шапку можно было бы проверить только запуском
// терминала, а «logo рисуется криво при ширине 60» — это как раз то, что находят не глазами.

import { PALETTE, type Theme } from './theme.ts'

/*
 * ЛОГОТИП В ДВУХ РАЗМЕРАХ.
 *
 * Широкий занимает 43 колонки. В окне на 60 колонок — а это обычная ширина расколотого пополам
 * экрана — он переносится, и вместо логотипа получается лесенка из обломков. Поэтому рядом лежит
 * узкий вариант, и выбор идёт по фактической ширине окна, а не по надежде.
 */
const WIDE = [
  '███╗   ██╗ ███████╗ ███╗   ███╗  ██████╗ ',
  '████╗  ██║ ██╔════╝ ████╗ ████║ ██╔═══██╗',
  '██╔██╗ ██║ █████╗   ██╔████╔██║ ██║   ██║',
  '██║╚██╗██║ ██╔══╝   ██║╚██╔╝██║ ██║   ██║',
  '██║ ╚████║ ███████╗ ██║ ╚═╝ ██║ ╚██████╔╝',
  '╚═╝  ╚═══╝ ╚══════╝ ╚═╝     ╚═╝  ╚═════╝ ',
]

const NARROW = [
  '█▄ █ █▀▀ █▀▄▀█ █▀█',
  '█ ▀█ ██▄ █ ▀ █ █▄█',
]

/** Ширина, ниже которой широкий логотип переносится и рассыпается. */
export const WIDE_LOGO_MIN = 46

export interface BannerState {
  version: string
  model: string
  /** Тариф или роль — то, что человек хочет видеть рядом с моделью. */
  plan: string
  /** Текущая папка, уже сокращённая до ~. */
  cwd: string
}

/**
 * Логотип с градиентом от голубого к фиолетовому.
 *
 * Градиент идёт ПО СТРОКАМ, а не по символам внутри строки: посимвольный на блочном шрифте даёт
 * рябь — соседние клетки одной буквы оказываются разного оттенка, и буква разваливается.
 */
export function logo(theme: Theme, width = 80): string[] {
  const art = width >= WIDE_LOGO_MIN ? WIDE : NARROW
  const last = Math.max(1, art.length - 1)
  return art.map((line, index) => {
    const ratio = index / last
    // Смешивание руками, а не gradient(): здесь нужен один цвет на всю строку.
    const from = PALETTE.cyan
    const to = PALETTE.violet
    return theme.hex(ratio < 0.5 ? from : to, line)
  })
}

/** Домашний каталог сворачивается в «~»: полный путь к профилю — это имя пользователя на экране. */
export function shortenPath(full: string, home: string): string {
  const path = String(full ?? '').replace(/\\/g, '/')
  const base = String(home ?? '').replace(/\\/g, '/').replace(/\/$/, '')
  if (base && (path === base || path.startsWith(`${base}/`))) return `~${path.slice(base.length)}`
  return path
}

/**
 * Строка состояния под логотипом: `Nemo CLI v1.0.0 · [модель/план] · ~/папка`.
 *
 * Путь при нехватке места режется С НАЧАЛА: конец пути говорит, где мы находимся, а начало — что
 * диск называется C. Обрезав хвост, мы оставили бы на экране бесполезную половину.
 */
export function statusLine(state: BannerState, theme: Theme, width = 80): string {
  const head = `Nemo CLI v${state.version}`
  const middle = `[${state.model} · ${state.plan}]`
  const dot = theme.hex(PALETTE.muted, ' · ')

  const fixed = head.length + middle.length + 6
  const room = Math.max(8, width - fixed)
  const path = state.cwd.length > room ? `…${state.cwd.slice(-(room - 1))}` : state.cwd

  return [
    theme.hex(PALETTE.text, head),
    theme.hex(PALETTE.violet, middle),
    theme.hex(PALETTE.muted, path),
  ].join(dot)
}

/**
 * Блок предупреждений с левой границей.
 *
 * Левая черта — не украшение: без неё предупреждение сливается с обычным выводом, и «включён
 * автопилот» читается как очередная строка журнала. Черта отделяет то, что человек обязан заметить,
 * от того, что он может пролистать.
 */
export function noticeBlock(lines: readonly string[], theme: Theme, tone: 'warn' | 'info' = 'warn'): string[] {
  const color = tone === 'warn' ? PALETTE.amber : PALETTE.cyan
  return lines
    .filter((one) => String(one ?? '').trim())
    .map((one) => `${theme.hex(color, '│')} ${theme.hex(PALETTE.text, one)}`)
}

/**
 * Вся шапка одной пачкой строк.
 *
 * Возвращает массив, а не склеенный текст: вызывающий сам решает, печатать её целиком или добавить
 * что-то между блоками. Склейка внутри лишила бы его этой возможности и ничего не упростила.
 */
export function header(state: BannerState, theme: Theme, options: {
  width?: number
  notices?: readonly string[]
} = {}): string[] {
  const width = options.width ?? 80
  const out = ['', ...logo(theme, width), '', statusLine(state, theme, width)]
  const notices = options.notices ?? []
  if (notices.length) out.push('', ...noticeBlock(notices, theme))
  out.push('')
  return out
}
