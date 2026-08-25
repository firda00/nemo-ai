// Кинетические субтитры: разметка Advanced SubStation Alpha (.ass).
//
// ПОЧЕМУ .ass, А НЕ .srt. SRT умеет только текст и тайминги — ни шрифта, ни положения, ни подсветки
// слова. Всё, ради чего субтитры в коротких видео вообще делают (крупный жирный шрифт, движение,
// выделение ключевого слова), в SRT выразить нечем. ASS умеет это разметкой, и ffmpeg накладывает её
// одним фильтром, без покадровой отрисовки на стороне приложения.
//
// ГЛАВНАЯ ОПАСНОСТЬ ЗДЕСЬ — ЭКРАНИРОВАНИЕ, и она серьёзнее, чем кажется. Текст субтитров приходит от
// модели или из расшифровки звонка, то есть это чужая строка. В ASS фигурные скобки открывают блок
// ПЕРЕОПРЕДЕЛЕНИЯ СТИЛЯ: `{\pos(0,0)}` двигает текст, `{\alpha&HFF&}` делает его невидимым, а
// `{\p1}` переключает движок в режим рисования векторных фигур, и остаток строки перестаёт быть
// текстом вовсе. Реплика «скидка {50%}» без экранирования — это не косметический сбой, а субтитр,
// который молча исчезает с экрана.
//
// БЕЗОПАСНЫЕ ОТСТУПЫ. Нижние ~18% кадра в TikTok и Reels закрыты интерфейсом: подпись автора, описание,
// кнопки. Субтитр, поставленный по центру снизу «как обычно», окажется под ними — на превью он виден,
// в ленте нет. Отступ снизу считается от высоты кадра, а не задан числом, чтобы не разъехаться при
// смене разрешения.

import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from '../contracts/media.ts'
import type { SubtitleCue } from '../contracts/media.ts'

/**
 * Доля высоты кадра, закрытая интерфейсом снизу.
 *
 * 0.18 от 1920 — это 345 пикселей. Мерка взята с запасом: у TikTok полоса ниже, у Reels выше, а ролик
 * заливают в оба.
 */
const BOTTOM_UI_FRACTION = 0.18
/** Боковые поля: текст, упирающийся в край, читается хуже и обрезается на части устройств. */
const SIDE_MARGIN = 80

export interface SubtitleStyle {
  fontName?: string
  fontSize?: number
  /** Основной цвет текста в формате ASS (&HAABBGGRR — порядок обратный привычному RGB). */
  primaryColour?: string
  /** Цвет подсветки ключевого слова. */
  highlightColour?: string
  outlineColour?: string
  outline?: number
  shadow?: number
  marginV?: number
  playResX?: number
  playResY?: number
}

export interface KaraokeWord { text: string; startMs: number; endMs: number }
export interface ProSubtitleCue extends SubtitleCue { style?: 'standard' | 'karaoke'; words?: KaraokeWord[] }

/**
 * Стиль по умолчанию: то, как выглядят субтитры в коротких видео 2020-х.
 *
 * Крупный жирный шрифт с толстой обводкой — не мода, а необходимость: ролик смотрят с телефона в руке,
 * поверх произвольного видеоряда, часто без звука. Тонкий шрифт на светлом кадре исчезает.
 */
const DEFAULT_STYLE: Required<SubtitleStyle> = {
  // Arial, а не модный шрифт: он есть в любом контейнере, включая alpine с fontconfig. Отсутствующий
  // шрифт ffmpeg заменяет молча — на тот, что нашёл, и результат видно только глазами на готовом файле.
  fontName: 'Arial',
  fontSize: 86,
  primaryColour: '&H00FFFFFF',
  // Жёлтый: самый читаемый акцент поверх произвольного видеоряда.
  highlightColour: '&H0000E5FF',
  outlineColour: '&H00000000',
  outline: 6,
  shadow: 3,
  marginV: Math.round(OUTPUT_HEIGHT * BOTTOM_UI_FRACTION),
  playResX: OUTPUT_WIDTH,
  playResY: OUTPUT_HEIGHT,
}

/**
 * Экранирование текста для ASS.
 *
 * Три подмены, и каждая закрывает свой способ сломать субтитр:
 *
 *   `{` и `}` — блок переопределения стиля. Без экранирования чужой текст управляет отрисовкой:
 *   двигает субтитр, делает его прозрачным или переключает движок в режим векторных фигур.
 *
 *   `\` — начало управляющей последовательности. `\N` переносит строку, `\h` вставляет неразрывный
 *   пробел; путь «C:\new» без экранирования разорвёт реплику пополам.
 *
 *   Перевод строки — в `\N`. Сырой перевод строки в ASS обрывает событие: всё после него перестаёт
 *   быть частью реплики и становится мусором в файле.
 *
 * Порядок важен: обратная косая экранируется ПЕРВОЙ, иначе она удвоит косые, добавленные скобками.
 */
export function escapeAssText(text: string): string {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n|\r|\n/g, '\\N')
}

/**
 * Время в формате ASS: H:MM:SS.CC (сотые доли).
 *
 * Часы БЕЗ ведущего нуля, минуты и секунды — с ним: так требует формат, и разбор чужими плеерами на
 * этом спотыкается чаще всего.
 */
export function formatAssTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const centis = Math.floor(clamped / 10) % 100
  const seconds = Math.floor(clamped / 1_000) % 60
  const minutes = Math.floor(clamped / 60_000) % 60
  const hours = Math.floor(clamped / 3_600_000)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`
}

/**
 * Подсветка ключевого слова внутри реплики.
 *
 * Слово ищется по УЖЕ ЭКРАНИРОВАННОМУ тексту и сравнивается без учёта регистра и с учётом границ слова
 * по свойствам Unicode — `\b` здесь не годится по той же причине, что и в правилах диалога: он
 * определён на ASCII и с кириллицей не работает вовсе.
 *
 * Слово не найдено — возвращается текст как есть. Это не отказ: подсветка приём, а не обязанность, и
 * потерять всю реплику из-за неудачного совпадения было бы несоразмерно.
 */
export function applyHighlight(escapedText: string, highlightWord: string | undefined, style: Required<SubtitleStyle>): string {
  const word = highlightWord?.trim()
  if (!word) return escapedText

  const escapedWord = escapeAssText(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${escapedWord})(?![\\p{L}\\p{N}])`, 'iu')
  if (!pattern.test(escapedText)) return escapedText

  // \c меняет основной цвет, второй тег возвращает прежний. Возврат обязателен: без него подсветка
  // «протекает» на весь остаток реплики.
  return escapedText.replace(pattern, `{\\c${style.highlightColour}}$1{\\c${style.primaryColour}}`)
}

/**
 * Заголовок файла.
 *
 * PlayResX/PlayResY обязаны совпадать с разрешением рендера. Не совпадают — ffmpeg масштабирует
 * разметку сам, и шрифт, задуманный крупным, приезжает мелким; заметно это только на готовом файле.
 *
 * ScaledBorderAndShadow: yes — иначе обводка не масштабируется вместе с текстом и на 1080p превращается
 * в едва заметный контур.
 */
export function buildAssHeader(style: Required<SubtitleStyle>): string {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${style.playResX}`,
    `PlayResY: ${style.playResY}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,'
      + ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,'
      + ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment 2 — по центру снизу. Отступ снизу уводит текст выше интерфейса приложения.
    [
      'Style: Kinetic', style.fontName, style.fontSize, style.primaryColour, style.highlightColour,
      style.outlineColour, '&H64000000', -1, 0, 0, 0, 100, 100, 0, 0, 1, style.outline, style.shadow,
      2, SIDE_MARGIN, SIDE_MARGIN, style.marginV, 1,
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')
}

/**
 * Реплики → готовый файл .ass.
 *
 * Реплики СОРТИРУЮТСЯ по времени начала. Плееры и фильтр ass в целом терпимы к беспорядку, но
 * пересекающиеся реплики в неотсортированном списке дают наложение текста поверх текста — а приходит
 * список из расшифровки, где порядок никто не гарантировал.
 */
export function buildAssFile(cues: readonly ProSubtitleCue[], style: SubtitleStyle = {}): string {
  const merged: Required<SubtitleStyle> = { ...DEFAULT_STYLE, ...style }
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs)

  const events = ordered.map((cue) => {
    const escaped = escapeAssText(cue.text)
    const withHighlight = cue.style === 'karaoke' && cue.words?.length
      ? cue.words.map((word) => `{\\k${Math.max(1, Math.round((word.endMs - word.startMs) / 10))}}${escapeAssText(word.text)}`).join(' ')
      : applyHighlight(escaped, cue.highlightWord, merged)
    // Появление лёгким увеличением: 120 мс от 92% к 100%. Достаточно, чтобы взгляд зацепился за смену
    // реплики, и мало, чтобы это читалось как анимация ради анимации.
    const entrance = '{\\fscx92\\fscy92\\t(0,120,\\fscx100\\fscy100)}'
    return `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},Kinetic,,0,0,0,,${entrance}${withHighlight}`
  })

  return `${buildAssHeader(merged)}\n${events.join('\n')}\n`
}

function formatSrtTime(ms: number): string {
  const value = Math.max(0, Math.round(ms)); const hours = Math.floor(value / 3_600_000)
  const minutes = Math.floor(value / 60_000) % 60; const seconds = Math.floor(value / 1_000) % 60; const millis = value % 1_000
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':') + `,${String(millis).padStart(3, '0')}`
}

/** Portable sidecar for players that do not support ASS styling. */
export function buildSrtFile(cues: readonly ProSubtitleCue[]): string {
  return [...cues].sort((a, b) => a.startMs - b.startMs).map((cue, index) =>
    `${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${String(cue.text).replace(/\r?\n/g, ' ')}\n`,
  ).join('\n')
}

/**
 * Путь к файлу субтитров внутри фильтра ffmpeg.
 *
 * Отдельная функция, потому что экранирование здесь ДРУГОЕ и это регулярный источник поломок на
 * Windows: в описании фильтра двоеточие разделяет параметры, а `C:\renders\a.ass` содержит и
 * двоеточие, и обратные косые. Без подмены ffmpeg разбирает «C» как имя файла, а «\renders\a.ass» —
 * как неизвестный параметр, и сообщение об ошибке об этом не говорит ни слова.
 */
export function escapeFilterPath(filePath: string): string {
  return String(filePath ?? '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\\\:')
    .replace(/'/g, "\\\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

export { DEFAULT_STYLE, BOTTOM_UI_FRACTION, SIDE_MARGIN }
