// Daily-briefing composer — pure and deterministic: no I/O, no LLM, no Deno globals, no clock.
// Renders the section envelopes from dailyBriefingSources.ts into plain text (RU/UZ/EN).
//
// Truthfulness rules agreed with Codex (incl. the composer review):
//   • Every section names its source and a DATED effective/fetched time — for READY data too, so
//     yesterday's 09:00 observation can never read as today's.
//   • The morning briefing REQUIRES all four typed sections: a source that is off or broken renders
//     as an explicit status line, never as a silent omission — and never as an invented value.
//   • TIMED calendar instants are converted to Asia/Tashkent for display (09:00Z is 14:00 for the
//     reader); ALL-DAY entries keep their verbatim date string, which has no instant to convert.
//   • The evening block is a caller-supplied envelope with source/fetchedAt and an unavailable
//     state — a DB failure renders as "unavailable", never as zero counts.
//   • Remote and caller strings (titles, due labels, descriptions) are DATA: re-sanitized at THIS
//     rendering boundary (control chars and newlines stripped, lengths capped) so nobody can forge
//     an extra section line; truncation is announced with an honest "+N". Plain text only.
import type {
  CalendarSection, NewsSection, SectionBase, UsdRateSection, WeatherSection,
} from './dailyBriefingSources.ts'

export type BriefingLang = 'uz' | 'ru' | 'en'

const MAX_RENDERED_EVENTS = 10
const MAX_RENDERED_TASKS = 5

interface Dict {
  morningTitle: string
  eveningTitle: string
  usdLabel: string
  weatherLabel: string
  calendarLabel: string
  newsLabel: string
  unavailable: string
  partialNote: string
  staleNote: string
  fetchedAt: string
  observedAt: string
  rateFor: string
  requestedFor: string
  perUsd: string
  feelsLike: string
  noEvents: string
  allDay: string
  untitled: string
  moreItems: (n: number) => string
  newsNotConnected: string
  doneToday: string
  inProgress: string
  overdue: string
  tasksHeader: string
  dueBy: string
  noData: string
  askOutcomes: string
  yesterdaySaid: string
}

const DICTS: Record<BriefingLang, Dict> = {
  uz: {
    morningTitle: 'Ertalabki brifing', eveningTitle: 'Kun yakunlari',
    usdLabel: 'USD kursi (O‘zR MB)', weatherLabel: 'Ob-havo', calendarLabel: 'Kalendar', newsLabel: 'Yangiliklar',
    unavailable: 'mavjud emas', partialNote: 'ro‘yxat to‘liq emas', staleNote: 'ma’lumot eskirgan',
    fetchedAt: 'olindi', observedAt: 'o‘lchov', rateFor: 'kurs sanasi', requestedFor: 'so‘ralgan sana',
    perUsd: 'so‘m / 1 USD', feelsLike: 'his etiladi', noEvents: 'bugun tadbirlar yo‘q', allDay: 'kun bo‘yi',
    untitled: '(nomsiz)', moreItems: (n) => `…va yana ${n}`, newsNotConnected: 'manba ulanmagan',
    doneToday: 'Bugun bajarildi', inProgress: 'Jarayonda', overdue: 'Muddati o‘tgan',
    tasksHeader: 'Vazifalar', dueBy: 'muddat', noData: 'ma’lumot yo‘q',
    askOutcomes: 'Kuningiz qanday o‘tdi? Qisqacha yozing: nima bajarildi, nima qoldi.',
    yesterdaySaid: 'Kechagi yakuningiz:',
  },
  ru: {
    morningTitle: 'Утренний брифинг', eveningTitle: 'Итоги дня',
    usdLabel: 'Курс USD (ЦБ РУз)', weatherLabel: 'Погода', calendarLabel: 'Календарь', newsLabel: 'Новости',
    unavailable: 'недоступно', partialNote: 'список неполный', staleNote: 'данные устарели',
    fetchedAt: 'получено', observedAt: 'замер', rateFor: 'курс на', requestedFor: 'запрошено на',
    perUsd: 'сум / 1 USD', feelsLike: 'ощущается', noEvents: 'событий на сегодня нет', allDay: 'весь день',
    untitled: '(без названия)', moreItems: (n) => `…и ещё ${n}`, newsNotConnected: 'источник не подключён',
    doneToday: 'Выполнено сегодня', inProgress: 'В работе', overdue: 'Просрочено',
    tasksHeader: 'Задачи', dueBy: 'срок', noData: 'нет данных',
    askOutcomes: 'Как прошёл ваш день? Напишите коротко: что удалось и что переносим.',
    yesterdaySaid: 'Ваш вчерашний итог:',
  },
  en: {
    morningTitle: 'Morning briefing', eveningTitle: 'Day results',
    usdLabel: 'USD rate (CBU)', weatherLabel: 'Weather', calendarLabel: 'Calendar', newsLabel: 'News',
    unavailable: 'unavailable', partialNote: 'list is incomplete', staleNote: 'data is stale',
    fetchedAt: 'fetched', observedAt: 'observed', rateFor: 'rate for', requestedFor: 'requested for',
    perUsd: 'UZS / 1 USD', feelsLike: 'feels like', noEvents: 'no events today', allDay: 'all day',
    untitled: '(untitled)', moreItems: (n) => `…and ${n} more`, newsNotConnected: 'source not connected',
    doneToday: 'Done today', inProgress: 'In progress', overdue: 'Overdue',
    tasksHeader: 'Tasks', dueBy: 'due', noData: 'no data',
    askOutcomes: 'How did your day go? Reply briefly: what got done and what carries over.',
    yesterdaySaid: 'Your note from yesterday:',
  },
}

// Rendering-boundary sanitizer: adapters already clean remote strings, but the composer also
// receives caller-supplied data (evening tasks) — a newline in a title must not forge a section.
function clean(value: unknown, max: number): string {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point here
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** "YYYY-MM-DD HH:MM" in Tashkent (fixed UTC+5) — arithmetic, no locale machinery. */
function tashkentStamp(iso: string): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return '--'
  return new Date(parsed + 5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')
}

/** HH:MM in Tashkent for a timed instant — 09:00Z must read as 14:00 for the reader. */
function tashkentTime(iso: string): string {
  const stamp = tashkentStamp(iso)
  return stamp === '--' ? clean(iso, 25) : stamp.slice(11)
}

/** Deterministic number rendering (no ICU variance): NBSP thousands, 2 decimals, comma for ru/uz. */
function formatAmount(value: number, lang: BriefingLang): string {
  const [integer, decimals] = value.toFixed(2).split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return lang === 'en' ? `${grouped}.${decimals}` : `${grouped},${decimals}`
}

function formatTemp(value: number): string {
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded}°C`
}

function truncateTitle(title: unknown, dict: Dict): string {
  const cleanTitle = clean(title, 81)
  if (!cleanTitle) return dict.untitled
  return cleanTitle.length > 80 ? `${cleanTitle.slice(0, 79)}…` : cleanTitle
}

/** "(source, fetched YYYY-MM-DD HH:MM)" — attached to every section, ready or not. */
function provenance(section: Pick<SectionBase, 'source' | 'fetchedAt'>, dict: Dict): string {
  return `(${clean(section.source, 60)}, ${dict.fetchedAt} ${tashkentStamp(section.fetchedAt)})`
}

function unavailableLine(label: string, section: SectionBase, dict: Dict, note?: string): string {
  return `• ${label}: ${dict.unavailable}${note ? ` — ${note}` : ''} ${provenance(section, dict)}`
}

function renderUsd(section: UsdRateSection, lang: BriefingLang, dict: Dict): string {
  if (!section.data || (section.status !== 'ready' && section.status !== 'stale')) {
    return unavailableLine(dict.usdLabel, section, dict)
  }
  const amount = `${formatAmount(section.data.ratePerUnit, lang)} ${dict.perUsd}`
  const effective = `${dict.rateFor} ${clean(section.data.effectiveDate, 10)}`
  const staleNote = section.status === 'stale' ? `, ${dict.requestedFor} ${clean(section.data.requestedDate, 10)}` : ''
  return `• ${dict.usdLabel}: ${amount} — ${effective}${staleNote} ${provenance(section, dict)}`
}

function renderWeather(section: WeatherSection, dict: Dict): string {
  if (!section.data || (section.status !== 'ready' && section.status !== 'stale')) {
    return unavailableLine(dict.weatherLabel, section, dict)
  }
  const parts = [formatTemp(section.data.tempC)]
  if (section.data.feelsLikeC !== undefined) parts.push(`${dict.feelsLike} ${formatTemp(section.data.feelsLikeC)}`)
  if (section.data.description) parts.push(clean(section.data.description, 80))
  const place = section.data.place ? ` — ${clean(section.data.place, 80)}` : ''
  // The observation stamp carries its DATE: a stale reading from yesterday 09:00 must never be
  // mistakable for today's 09:00, and the stale flag is spelled out.
  const stale = section.status === 'stale' ? `, ${dict.staleNote}` : ''
  const observed = `${dict.observedAt} ${tashkentStamp(section.data.observedAt)}${stale}`
  return `• ${dict.weatherLabel}: ${parts.join(', ')}${place} (${clean(section.source, 60)}, ${observed}, ${dict.fetchedAt} ${tashkentStamp(section.fetchedAt)})`
}

function renderCalendar(section: CalendarSection, dict: Dict): string[] {
  if (!section.data || section.status === 'unavailable') {
    return [unavailableLine(dict.calendarLabel, section, dict)]
  }
  const partialNote = section.status === 'partial' || section.data.truncated ? ` — ${dict.partialNote}` : ''
  const header = `• ${dict.calendarLabel} ${provenance(section, dict)}${partialNote}:`
  if (!section.data.events.length) return [`${header} ${dict.noEvents}`]
  const shown = section.data.events.slice(0, MAX_RENDERED_EVENTS)
  const lines = shown.map((event) => {
    const time = event.allDay ? `${dict.allDay} ${clean(event.start, 10)}` : tashkentTime(event.start)
    return `  – ${time}: ${truncateTitle(event.title, dict)}`
  })
  const hidden = section.data.events.length - shown.length
  if (hidden > 0) lines.push(`  ${dict.moreItems(hidden)}`)
  return [header, ...lines]
}

function renderNews(section: NewsSection, dict: Dict): string[] {
  // headlines are remote DATA: cleaned, truncated, attributed — never interpreted
  if (!section.data?.headlines?.length || section.status === 'unavailable') {
    return [unavailableLine(dict.newsLabel, section, dict, dict.newsNotConnected)]
  }
  const partial = section.status === 'partial' ? ` — ${dict.partialNote}` : ''
  const header = `• ${dict.newsLabel} ${provenance(section, dict)}${partial}:`
  // each headline shows its own PUBLICATION stamp: a 48h-old item must never read as today's
  // just because the section was fetched this morning
  const lines = section.data.headlines.slice(0, 3).flatMap((headline) => {
    const entry = [`  – ${clean(headline.title, 160)} (${clean(headline.source, 40)}, ${tashkentStamp(headline.publishedAt)})`]
    if (headline.link) entry.push(`    ${clean(headline.link, 300)}`)
    return entry
  })
  return [header, ...lines]
}

// All four sections are REQUIRED: a disabled or broken source arrives as an envelope with a
// non-ready status and renders as an explicit line — omission is not an option the type allows.
export function composeMorningBriefing(input: {
  lang: BriefingLang
  dateLabel: string
  sections: { usd: UsdRateSection; weather: WeatherSection; calendar: CalendarSection; news: NewsSection }
  /**
   * Yesterday's recorded outcome, quoted back as inert attributed data. Tri-state on purpose:
   * NONE (null) renders silence — nothing was said, quoting nothing claims nothing; a failed
   * READ renders an explicit unavailable marker — "we could not check" must never look
   * identical to "you wrote nothing".
   */
  yesterdayOutcome?: { status: 'ready'; runDate: string; text: string } | { status: 'unavailable' } | null
}): string {
  const dict = DICTS[input.lang]
  const lines = [
    `${dict.morningTitle} — ${clean(input.dateLabel, 40)}`,
    renderUsd(input.sections.usd, input.lang, dict),
    renderWeather(input.sections.weather, dict),
    ...renderCalendar(input.sections.calendar, dict),
    ...renderNews(input.sections.news, dict),
  ]
  if (input.yesterdayOutcome?.status === 'ready') {
    // the owner's own words: sanitized and truncated as data, attributed to their date
    lines.push(`🗒 ${dict.yesterdaySaid} «${clean(input.yesterdayOutcome.text, 200)}» (${clean(input.yesterdayOutcome.runDate, 10)})`)
  } else if (input.yesterdayOutcome?.status === 'unavailable') {
    lines.push(`🗒 ${dict.yesterdaySaid} ${dict.unavailable}`)
  }
  return lines.join('\n')
}

export interface EveningTasksData {
  doneToday: number
  open: number
  overdue: number
  topTasks: Array<{ title: string; dueLabel?: string }>
  /** How many more tasks exist beyond topTasks — rendered honestly, never implied complete. */
  moreCount?: number
}

/** Caller-supplied envelope: the endpoint queries the DB and must report its own failures. */
export interface EveningTasksSection {
  status: 'ready' | 'unavailable'
  source: string
  fetchedAt: string
  detail?: string
  data?: EveningTasksData
}

export function composeEveningBriefing(input: { lang: BriefingLang; dateLabel: string; tasks: EveningTasksSection }): string {
  const dict = DICTS[input.lang]
  const title = `${dict.eveningTitle} — ${clean(input.dateLabel, 40)}`
  // A DB failure is an explicit unavailable line — never three reassuring zeros. The 20:00
  // message still does its real job: asking the owner for the day's actual outcomes.
  if (input.tasks.status !== 'ready' || !input.tasks.data) {
    return [title, `• ${dict.tasksHeader}: ${dict.unavailable} ${provenance(input.tasks, dict)}`, dict.askOutcomes].join('\n')
  }
  const tasks = input.tasks.data
  const count = (value: number) => Number.isFinite(value) && value >= 0 ? String(Math.floor(value)) : dict.noData
  const lines: string[] = [
    `${title} ${provenance(input.tasks, dict)}`,
    `• ${dict.doneToday}: ${count(tasks.doneToday)}`,
    `• ${dict.inProgress}: ${count(tasks.open)}`,
    `• ${dict.overdue}: ${count(tasks.overdue)}`,
  ]
  const shown = tasks.topTasks.slice(0, MAX_RENDERED_TASKS)
  const hidden = Math.max(0, Math.floor(tasks.moreCount ?? 0)) + Math.max(0, tasks.topTasks.length - shown.length)
  if (shown.length || hidden > 0) lines.push(`${dict.tasksHeader}:`)
  for (const task of shown) {
    const due = task.dueLabel ? ` — ${dict.dueBy} ${clean(task.dueLabel, 40)}` : ''
    lines.push(`  – ${truncateTitle(task.title, dict)}${due}`)
  }
  // moreCount must render even when topTasks itself is empty — hiding it would claim completeness.
  if (hidden > 0) lines.push(`  ${dict.moreItems(hidden)}`)
  // The evening goal is COLLECTING outcomes, not just displaying counts: always end by asking.
  lines.push(dict.askOutcomes)
  return lines.join('\n')
}
