// Оформление терминала: строка состояния, реплики человека, бейджи вызовов, подсказки ввода.
//
// ЗДЕСЬ ТОЛЬКО ЧИСТЫЕ ФУНКЦИИ «данные → строка». Ни одна из них не пишет в терминал сама. Это
// позволяет проверять оформление сравнением строк, без запуска CLI, — а оформление ломается ровно так
// же тихо, как логика: рамка разъезжается, счётчик врёт, бейдж молчит об ошибке.
//
// ЧТО ЗДЕСЬ ЛЕГКО СДЕЛАТЬ НЕЧЕСТНО:
//
// 1. СЧЁТЧИК КОНТЕКСТА, КОТОРЫЙ ВЫГЛЯДИТ ТОЧНЫМ. Модель сообщает израсходованные токены не всегда, а
//    посчитать их самому нечем: токенизатор у каждой модели свой. Оценка по знакам ошибается в полтора
//    раза на кириллице. Показывать её без пометки — врать цифрой, которой верят.
//
// 2. ЗНАМЕНАТЕЛЬ ОТ ДРУГОЙ МОДЕЛИ. «32k / 200k» на gpt-4o неверно: у него 128k. Предел, взятый от
//    балды, успокаивает ровно до того момента, когда разговор оборвётся на середине.
//
// 3. БЕЙДЖ, МОЛЧАЩИЙ ОБ ОТКАЗЕ. Однострочный бейдж заманчиво печатать только при успехе — строка
//    короче, вывод чище. Тогда неудавшийся вызов исчезает бесследно, и человек считает, что всё прошло.

import { c as defaultColors, stripAnsi, visibleWidth } from '../tui.mjs'
import { PALETTE, theme as defaultTheme, type Theme } from './theme.ts'

type Palette = typeof defaultColors

// ─── Контекстное окно ─────────────────────────────────────────────────────────────────────────────

/**
 * Известные пределы контекста, в токенах.
 *
 * Списком, а не одним числом: у моделей они разные, и общий знаменатель означал бы неверную цифру для
 * всех, кроме одной. Неизвестная модель показывается БЕЗ знаменателя — «сколько израсходовано» честно,
 * «сколько осталось» без предела не существует.
 */
export const CONTEXT_LIMITS: Record<string, number> = {
  'anthropic/claude-sonnet-4': 200_000,
  'anthropic/claude-3.5-sonnet': 200_000,
  'anthropic/claude-3.7-sonnet': 200_000,
  'openai/gpt-4o': 128_000,
  'openai/gpt-4o-mini': 128_000,
  'openai/o3-mini': 200_000,
  'deepseek/deepseek-chat': 64_000,
  'qwen/qwen-2.5-72b-instruct': 32_000,
}

export function contextLimitFor(model: string): number | null {
  const exact = CONTEXT_LIMITS[model]
  if (exact) return exact
  // Идентификаторы OpenRouter бывают с суффиксом версии или маршрутизации: anthropic/claude-sonnet-4:beta.
  const base = model.split(':')[0]
  return CONTEXT_LIMITS[base] ?? null
}

/**
 * Грубая оценка числа токенов.
 *
 * ТОЛЬКО когда модель не сообщила настоящее число. Токенизатор у каждой модели свой, и повторять его
 * здесь — заводить вторую реализацию, которая разойдётся с первой молча.
 *
 * Кириллица считается отдельно и НЕ случайно: латиница у распространённых токенизаторов идёт примерно
 * по четыре знака на токен, кириллица — примерно по два. Общий делитель занижал бы русский разговор
 * вдвое, то есть врал бы именно там, где этот CLI и работает.
 */
export function estimateTokens(text: string): number {
  const source = String(text ?? '')
  if (!source) return 0
  let cyrillic = 0
  for (const ch of source) if (ch >= 'Ѐ' && ch <= 'ӿ') cyrillic += 1
  const other = [...source].length - cyrillic
  return Math.ceil(cyrillic / 2 + other / 4)
}

/** Сколько токенов занимает история. Служебные поля вызовов считаются: они тоже уходят в запрос. */
export function estimateHistoryTokens(messages: readonly { content?: unknown; tool_calls?: unknown }[]): number {
  let total = 0
  for (const message of messages) {
    total += estimateTokens(typeof message.content === 'string' ? message.content : '')
    if (message.tool_calls) total += estimateTokens(JSON.stringify(message.tool_calls))
  }
  return total
}

/** Короткая запись числа: 32k вместо 32000. Ниже тысячи — как есть, «0k» ничего не сообщает. */
export function shortCount(value: number): string {
  if (value < 1_000) return String(value)
  const thousands = value / 1_000
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, '')}k`
}

export interface HudState {
  model: string
  role: string
  /** Токены из ответа модели. null — их не сообщили, и тогда показывается оценка с пометкой «~». */
  usedTokens: number | null
  estimatedTokens: number
  /** Что показывать справа: готовность или время текущей генерации. */
  busyMs?: number | null
}

/**
 * Строка состояния.
 *
 * Возвращает СТРОКУ, а не печатает: пришпилить её к первой строке терминала нельзя без захвата
 * области прокрутки, а захват ломает выделение мышью, копирование и изменение размера окна. Поэтому
 * строка печатается на границах хода — так же, как это делают Claude Code и Codex CLI.
 */
export function hudLine(state: HudState, width = 80, palette: Palette = defaultColors): string {
  const limit = contextLimitFor(state.model)
  const exact = state.usedTokens !== null
  const used = exact ? state.usedTokens! : state.estimatedTokens
  // Знак «~» перед оценкой — не украшение: без него цифре верят как измеренной.
  const context = limit === null
    ? `${exact ? '' : '~'}${shortCount(used)} токенов`
    : `${exact ? '' : '~'}${shortCount(used)} / ${shortCount(limit)}`

  const status = state.busyMs === null || state.busyMs === undefined
    ? 'готов'
    : `${(state.busyMs / 1000).toFixed(1)} с`

  const parts = [
    palette.dim(`[${context}]`),
    palette.dim(`[${state.role} · ${shortModel(state.model)}]`),
    state.busyMs ? palette.cyan(`[${status}]`) : palette.dim(`[${status}]`),
  ]
  const line = parts.join(' ')
  // Выравнивание по ПРАВОМУ краю считается по видимой ширине: с .length отступ уедет на длину
  // управляющих последовательностей, и строка встанет за границу окна.
  const pad = Math.max(0, width - visibleWidth(line))
  return `${' '.repeat(pad)}${line}`
}

/** Имя модели без поставщика: в строке состояния место дороже полноты. */
export function shortModel(model: string): string {
  return String(model ?? '').split('/').pop() ?? String(model ?? '')
}

// ─── Реплика человека ─────────────────────────────────────────────────────────────────────────────

/**
 * Реплика человека: маркер, текст, время справа, тонкая черта под ней.
 *
 * Время нужно не для красоты: в длинной сессии по нему видно, что прогон занял сорок минут, — а без
 * него все реплики выглядят одинаково свежими.
 */
export function userLine(text: string, at: Date, width = 80, palette: Palette = defaultColors): string {
  const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  /*
   * ВСТАВКА В НЕСКОЛЬКО СТРОК — ОДИН БЛОК, А НЕ ПЕРВАЯ СТРОКА И СИРОТЫ ПОД НЕЙ.
   *
   * Раньше текст подставлялся целиком, вместе с переводами строк. Маркер «›» доставался только
   * первой строке, продолжение уходило вровень с левым краем — неотличимо от вывода агента, — а
   * ширина считалась по всей склейке разом, из-за чего отметка времени вставала посреди последней
   * строки вместо правого края первой.
   *
   * Первая строка несёт маркер и время, продолжение — тихую вертикаль: видно, где вставка началась
   * и где кончилась, даже если вставили тридцать строк.
   */
  const lines = String(text).split('\n')
  const bright = (one: string) => palette.bold(palette.cyan(one))
  const head = `${palette.magenta('›')} ${bright(lines[0] ?? '')}`
  const pad = Math.max(1, width - visibleWidth(head) - stamp.length)
  return [
    `${head}${' '.repeat(pad)}${palette.dim(stamp)}`,
    ...lines.slice(1).map((one) => `${palette.dim('│')} ${bright(one)}`),
    palette.dim('─'.repeat(Math.max(1, width))),
  ].join('\n')
}

/**
 * Бейдж ответа агента: `✦ Nemo (sdr)`.
 *
 * Печатается один раз за ход, перед первым текстом. Без него реплика модели начиналась с голого
 * текста вплотную к вводу человека, и в длинной ленте эти два голоса сливались в один.
 */
export function agentBadge(role: string, palette: Palette = defaultColors): string {
  return `${palette.cyan('✦')} ${palette.bold(`Nemo (${role})`)}`
}

// ─── Бейджи вызовов ───────────────────────────────────────────────────────────────────────────────

export interface ToolBadgeInput {
  name: string
  args: Record<string, unknown>
  ok: boolean
  result?: unknown
  error?: string
  durationMs: number
}

/** Секунды с одним знаком: «2.1 с». Миллисекунды в глазах человека — шум. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} с`
}

/**
 * Человеческий размер файла. Байты выше килобайта нечитаемы, а «0.0 KB» скрывает пустой файл.
 */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

/**
 * Однострочный бейдж завершённого вызова.
 *
 * ОТКАЗ ПОКАЗЫВАЕТСЯ ВСЕГДА, и это главное правило здесь. Печатать бейдж только при успехе заманчиво:
 * вывод чище. Тогда неудавшийся вызов исчезает бесследно, и человек считает, что всё прошло, — а
 * узнаёт правду через день, по отсутствию реакции клиента.
 */
export function toolBadge(input: ToolBadgeInput, palette: Palette = defaultColors): string {
  const mark = input.ok ? palette.green('✓') : palette.red('✖')
  const detail = input.ok ? successDetail(input) : `${input.error ?? 'не получилось'}`.slice(0, 90)
  return `${palette.dim('✦')} ${mark} ${detail} ${palette.dim(`· ${seconds(input.durationMs)}`)}`
}

/**
 * Согласование существительного с числом.
 *
 * «Найдено 3 компаний» читается как недоделка, и это не педантизм: интерфейс, который не умеет
 * согласовать число со словом, выглядит собранным наспех — а по нему судят и обо всём остальном.
 * Правило русского языка: 1 — первая форма, 2–4 — вторая, 0 и 5–20 — третья, дальше по последней цифре.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(count))
  const lastTwo = abs % 100
  if (lastTwo >= 11 && lastTwo <= 14) return many
  const last = abs % 10
  if (last === 1) return one
  if (last >= 2 && last <= 4) return few
  return many
}

/** Что писать в бейдже об успешном вызове. Известные инструменты — своими словами, прочие — именем. */
function successDetail(input: ToolBadgeInput): string {
  const result = (input.result ?? {}) as Record<string, unknown>
  if (input.name === 'search_leads') {
    const found = typeof result.found === 'number' ? result.found : null
    const hot = typeof result.hot === 'number' ? result.hot : null
    const noun = found === null ? 'компаний' : plural(found, 'компания', 'компании', 'компаний')
    return `Найдено ${found ?? '?'} ${noun}${hot === null ? '' : `, горячих ${hot}`}`
  }
  if (input.name.startsWith('browser_')) {
    const url = String(input.args.url ?? result.finalUrl ?? '')
    return `Открыт ${shortUrl(url)}`
  }
  if (input.name === 'run_qa_audit') {
    return `Аудит ${shortUrl(String(input.args.url ?? ''))} — здоровье ${result.score ?? '?'}%`
  }
  if (input.name === 'fs_export') {
    const path = String(result.path ?? '')
    const bytes = typeof result.bytes === 'number' ? result.bytes : null
    return `Сохранён ${baseName(path)}${bytes === null ? '' : ` [${humanBytes(bytes)}]`} · fs_export`
  }
  if (input.name === 'telegram_send_lead') return `Карточка отправлена · ${input.args.leadName ?? ''}`.trim()
  if (input.name === 'crm_sync_lead') return `Записано в CRM · ${input.args.leadName ?? ''}`.trim()
  if (input.name === 'render_video_pitch') return 'Ролик собран · render_video_pitch'
  return input.name
}

/** Адрес без схемы и хвоста: в одну строку помещается домен и начало пути, остальное — шум. */
export function shortUrl(url: string, max = 44): string {
  const bare = String(url ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return bare.length <= max ? bare : `${bare.slice(0, max - 1)}…`
}

function baseName(target: string): string {
  return String(target ?? '').split(/[\\/]/).pop() ?? String(target ?? '')
}

/** Бейдж размышления: сколько модель думала до первого слова или первого вызова. */
export function thoughtBadge(ms: number, palette: Palette = defaultColors): string {
  return palette.dim(`✦ Думал ${seconds(ms)}`)
}

/**
 * Сводка цепочки вызовов одной строкой.
 *
 * Показывается ТОЛЬКО когда вызовов было много: на двух она дублирует то, что человек уже прочитал.
 * Порог — три, и он не круглое число из головы: две строки глазом охватываются целиком, с третьей
 * начинается список, который хочется свернуть.
 */
export const GROUP_THRESHOLD = 3

export function groupSummary(
  calls: readonly ToolBadgeInput[],
  palette: Palette = defaultColors,
): string | null {
  if (calls.length < GROUP_THRESHOLD) return null
  const counts = new Map<string, number>()
  for (const call of calls) {
    const word = groupWord(call)
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const failed = calls.filter((one) => !one.ok).length
  const parts = [...counts].map(([word, count]) => (count > 1 ? `${word} ×${count}` : word))
  // Число неудач называется отдельно: сводка, где отказ растворён среди успехов, успокаивает зря.
  const tail = failed ? palette.red(`, отказов ${failed}`) : ''
  return `${palette.dim('✦')} ${parts.join(', ')}${tail}`
}

function groupWord(call: ToolBadgeInput): string {
  if (call.name === 'search_leads') return 'поиск компаний'
  if (call.name.startsWith('browser_')) return 'открыта страница'
  if (call.name === 'run_qa_audit') return 'аудит сайта'
  if (call.name === 'fs_export') return 'сохранён файл'
  if (call.name === 'telegram_send_lead') return 'отправлена карточка'
  if (call.name === 'crm_sync_lead') return 'запись в CRM'
  if (call.name === 'render_video_pitch') return 'собран ролик'
  return call.name
}

// ─── Подсказки под вводом ─────────────────────────────────────────────────────────────────────────

export const INPUT_PROMPT = '› '

/** Подсказки под строкой ввода. Названы только те клавиши, которые действительно работают. */
export function footerHints(palette: Palette = defaultColors): string {
  return palette.dim('/help · Tab: команды · Ctrl+C: выход · Enter: отправить')
}


// ─── Реплика человека плашкой ─────────────────────────────────────────────────────────────────────

/**
 * Реплика человека ПЛАШКОЙ НА ВСЮ ШИРИНУ: `› текст` на подложке #1E222B.
 *
 * Чем это лучше прежней строки с чертой под ней. В длинной ленте — где вперемешку идут ответ
 * модели, бейджи вызовов и вывод инструментов — тонкая черта теряется, и глаз не находит, откуда
 * начался текущий ход. Сплошная подложка находится с одного взгляда, потому что это единственное
 * цветное поле на экране.
 *
 * Многострочная вставка остаётся ОДНИМ блоком: каждая строка получает свою плашку, поэтому
 * тридцать вставленных строк выглядят как один прямоугольник, а не как первая строка и сироты.
 */
export function userBar(text: string, at: Date, width = 80, palette: Palette = defaultColors, ui: Theme = defaultTheme): string {
  const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const lines = String(text).split('\n')

  return lines.map((line, index) => {
    const marker = index === 0 ? ui.hex(PALETTE.violet, '›') : ' '
    const body = `${marker} ${ui.hex(PALETTE.text, line)}`
    // Отметка времени — только на первой строке и только если для неё есть место. Втиснутая в
    // узкое окно, она съела бы текст, ради которого строка и печатается.
    const head = visibleWidth(body)
    const room = width - head - stamp.length - 2
    const withStamp = index === 0 && room > 0
      ? `${body}${' '.repeat(room)}${ui.hex(PALETTE.muted, stamp)}  `
      : body
    return ui.bar(PALETTE.inputBg, withStamp, width)
  }).join('\n')
}

// ─── Дерево выполнения ────────────────────────────────────────────────────────────────────────────

/**
 * Ветка дерева подзадач: `├ текст` или `└ текст` для последней.
 *
 * Дерево, а не список с дефисами, потому что у шагов есть ВЛОЖЕННОСТЬ: загрузка навыков, проверка
 * базы и вызовы инструментов принадлежат текущему ходу, а не ленте целиком. Дефисы этого не
 * показывают, и вывод читается как поток несвязанных сообщений.
 */
export function treeLine(text: string, options: {
  last?: boolean
  depth?: number
  tone?: 'muted' | 'ok' | 'warn' | 'fail'
} = {}, ui: Theme = defaultTheme): string {
  const branch = options.last ? '└' : '├'
  // Отступ рисуется вертикалями, а не пробелами: без них вложенные ветки повисают в воздухе и
  // непонятно, к чему они относятся.
  const indent = '│ '.repeat(Math.max(0, options.depth ?? 0))
  const colors = { muted: PALETTE.muted, ok: PALETTE.green, warn: PALETTE.amber, fail: PALETTE.red }
  const tone = colors[options.tone ?? 'muted']
  return `${ui.hex(PALETTE.muted, indent + branch)} ${ui.hex(tone, text)}`
}

/** Несколько веток разом: последняя получает «└» автоматически. */
export function treeBlock(items: readonly string[], ui: Theme = defaultTheme, depth = 0): string[] {
  return items.map((text, index) => treeLine(text, { last: index === items.length - 1, depth }, ui))
}

// ─── Строка размышления ───────────────────────────────────────────────────────────────────────────

/**
 * `✳ Reasoning... (2.4s · temperature 0.2)` — живая строка, пока модель думает.
 *
 * Секунды показываются С ОДНИМ ЗНАКОМ и растут на глазах: неподвижная строка «думаю» через двадцать
 * секунд неотличима от зависшего процесса, и человек жмёт Ctrl+C ровно перед тем, как придёт ответ.
 *
 * temperature печатается ТОЛЬКО когда задана. Подставлять умолчание значит показывать число,
 * которого никто не выбирал, — а по нему потом объясняют, почему модель ответила именно так.
 */
export function reasoningLine(state: {
  elapsedMs: number
  temperature?: number | null
  label?: string
}, ui: Theme = defaultTheme): string {
  const seconds = `${(Math.max(0, state.elapsedMs) / 1000).toFixed(1)}s`
  const parts = [seconds]
  if (state.temperature !== null && state.temperature !== undefined) {
    parts.push(`temperature ${state.temperature}`)
  }
  return [
    ui.hex(PALETTE.violet, '✳'),
    ui.hex(PALETTE.text, `${state.label ?? 'Reasoning'}...`),
    ui.hex(PALETTE.muted, `(${parts.join(' · ')})`),
  ].join(' ')
}

// ─── Разделитель и подстрочник ────────────────────────────────────────────────────────────────────

/** Черта во всю ширину перед полем ввода: отделяет прошедший ход от следующего. */
export function divider(width = 80, ui: Theme = defaultTheme): string {
  return ui.hex(PALETTE.muted, '─'.repeat(Math.max(1, width)))
}

/**
 * Подстрочник под вводом: `▸▸ sdr mode · esc to cancel · /agent to switch · /skills`.
 *
 * Названы ТОЛЬКО работающие клавиши и команды. Подсказка про клавишу, которой нет, — это не мелочь:
 * человек нажимает, ничего не происходит, и дальше он не верит ни одной подсказке.
 */
export function statusBar(state: { role: string; busy?: boolean }, ui: Theme = defaultTheme): string {
  const hints = [
    `${state.role} mode`,
    // «esc to cancel» показывается только когда есть что отменять.
    ...(state.busy ? ['esc to cancel'] : []),
    '/agent to switch',
    '/skills',
  ]
  return `${ui.hex(PALETTE.violet, '▸▸')} ${ui.hex(PALETTE.muted, hints.join(' · '))}`
}

export { stripAnsi }
