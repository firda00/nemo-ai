/*
 * Автодозвон: РЕШЕНИЕ О ЗВОНКЕ И ЕГО ЗАПРЕТЫ.
 *
 * Перенесено из MetaSell (server/autodialer.js). Оттуда взято именно то, что я проверил при
 * разборе: слои защиты. Мост к телефонии НЕ перенесён — у Nemo нет ни провайдера, ни учётных
 * данных, и переходник в никуда был бы обманом: инструмент выглядел бы рабочим и молчал.
 *
 * ЧТО ЭТОТ МОДУЛЬ ДЕЛАЕТ: решает, можно ли звонить, и ведёт очередь. Кто именно наберёт номер —
 * задаётся зависимостью. Пока её не передали, работает симуляция.
 *
 * ─── ПОЧЕМУ ЗАЩИТ СТОЛЬКО ────────────────────────────────────────────────────────────────────
 *
 * Ошибка здесь звонит живому человеку. Отозвать звонок нельзя, извиниться перед списком из тысячи
 * номеров — тоже. Поэтому запреты стоят слоями и каждый работает сам по себе: отказ одного не
 * должен открывать дорогу.
 */
import crypto from 'node:crypto'

export interface DialerSettings {
  /** Выключено по умолчанию. Включение — осознанное действие, а не следствие установки. */
  enabled: boolean
  /** Симуляция по умолчанию. Боевой режим требует отдельного подтверждения человеком. */
  dryRun: boolean
  maxDailyAttempts: number
  minRetryIntervalHours: number
  workHoursStart: string
  workHoursEnd: string
  /** Часовой пояс окна работы. Заказчик не обязан жить в Ташкенте. */
  timeZone: string
  /**
   * Звонить только номерам из белого списка.
   *
   * По умолчанию ВКЛЮЧЕНО. Обратный порядок — «звоним всем, кроме чёрного списка» — означает, что
   * первая же ошибка в выборке лидов обзвонит посторонних, и узнаем мы об этом от них.
   */
  allowlistOnly: boolean
}

export const DEFAULT_SETTINGS: Readonly<DialerSettings> = Object.freeze({
  enabled: false,
  dryRun: true,
  maxDailyAttempts: 3,
  minRetryIntervalHours: 2,
  workHoursStart: '09:00',
  workHoursEnd: '21:00',
  timeZone: 'Asia/Tashkent',
  allowlistOnly: true,
})

export interface Lead {
  id: string
  phone: string
  /** Закрытые сделки не обзванивают: человек уже сказал своё. */
  status?: string
  attemptsToday?: number
  lastAttemptAt?: Date | null
}

export type RefusalReason =
  | 'disabled' | 'outside_working_hours' | 'closed_lead' | 'no_phone'
  | 'blacklisted' | 'daily_limit' | 'too_soon' | 'not_allowlisted' | 'bad_phone'

export type Decision = { ok: true } | { ok: false; reason: RefusalReason; detail?: string }

const CLOSED = new Set(['closed', 'won', 'lost', 'refused', 'duplicate', 'закрыт', 'отказ'])

/**
 * Только цифры. Длиннее пятнадцати — НЕ НОМЕР ВОВСЕ.
 *
 * Пятнадцать — предел E.164. Раньше здесь стояло `.slice(-15)`, и это было тихой подменой: строка
 * `9998901234567890` превращалась в другой номер, а не отвергалась. Для пятнадцатизначного номера
 * это давало прямой обход белого списка — приписал цифру спереди, хвост совпал, отпечаток сошёлся.
 *
 * Пустая строка на выходе означает «номера нет», и все проверки выше это уже понимают.
 */
export function normalizePhone(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length > 15 ? '' : digits
}

/**
 * Отпечаток номера для белого списка.
 *
 * Номера НЕ ХРАНЯТСЯ в открытом виде: список разрешённых для обзвона — это перечень людей, которым
 * будут звонить, и утечка такой таблицы хуже утечки адресов почты. Соль в составе хеша не даёт
 * сверить его с готовой радужной таблицей номеров: их всего десять миллиардов, и без соли перебор
 * занимает минуты.
 */
export function phoneFingerprint(phone: string, salt: string): string {
  const normalized = normalizePhone(phone)
  if (!normalized) return ''
  return crypto.createHash('sha256').update(`${salt}:${normalized}`).digest('hex')
}

/** Для показа человеку: последние четыре цифры. Больше в интерфейсе не нужно. */
export function maskPhone(phone: string): string {
  const normalized = normalizePhone(phone)
  return normalized.length >= 4 ? `***${normalized.slice(-4)}` : '***'
}

/**
 * Местный час в заданном поясе.
 *
 * Через Intl, а не через getHours(): сервер стоит в UTC, а обзванивают людей по их времени.
 * Окно «с 9 до 21» по серверным часам означало бы звонки в пять утра.
 */
export function localHour(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).formatToParts(at)
  return Number(parts.find((one) => one.type === 'hour')?.value ?? -1)
}

export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

const minutesOf = (value: string): number => {
  const [h, m] = String(value ?? '').split(':').map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : Number.NaN
}

/**
 * Внутри ли рабочего окна.
 *
 * Окно, перешагивающее полночь (с 21:00 до 09:00), обрабатывается отдельной ветвью. Без неё
 * сравнение «начало <= сейчас < конец» даёт пустое окно, и автодозвон молча не работает никогда —
 * отказ, который выглядит как «просто нет лидов».
 */
export function withinWorkHours(at: Date, settings: Pick<DialerSettings, 'workHoursStart' | 'workHoursEnd' | 'timeZone'>): boolean {
  const start = minutesOf(settings.workHoursStart)
  const end = minutesOf(settings.workHoursEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at)
  const hour = Number(parts.find((one) => one.type === 'hour')?.value ?? -1)
  const minute = Number(parts.find((one) => one.type === 'minute')?.value ?? -1)
  if (hour < 0 || minute < 0) return false
  const now = hour * 60 + minute

  if (start === end) return false
  return start < end ? now >= start && now < end : now >= start || now < end
}

export interface EligibilityInput {
  settings: DialerSettings
  lead: Lead
  now: Date
  blacklisted: boolean
  /** Номер в белом списке. Проверяется вызывающим по отпечатку, сюда приходит готовый ответ. */
  allowlisted: boolean
}

/**
 * Можно ли ставить лид в очередь.
 *
 * Чистая функция БЕЗ побочных действий и без обращения к времени изнутри: время передаётся. Только
 * так её поведение можно проверить таблицей — включая полночь, границы окна и високосные сутки, —
 * а не ждать нужного часа.
 *
 * Порядок проверок от общего к частному: сначала «включено ли вообще», потом «то ли время», и
 * только в конце — про конкретный номер. Обратный порядок заставлял бы считать номера в выключенной
 * системе.
 */
export function decideEligibility(input: EligibilityInput): Decision {
  const { settings, lead, now } = input

  if (!settings.enabled) return { ok: false, reason: 'disabled' }
  if (!withinWorkHours(now, settings)) {
    return { ok: false, reason: 'outside_working_hours', detail: `${settings.workHoursStart}–${settings.workHoursEnd} ${settings.timeZone}` }
  }
  // trim обязателен: статус приходит из чужой выгрузки, и « WON » с пробелами по краям — обычное
  // дело. Не срезав их, мы позвоним человеку, который уже купил.
  if (CLOSED.has(String(lead?.status ?? '').trim().toLowerCase())) return { ok: false, reason: 'closed_lead' }

  const phone = normalizePhone(lead?.phone)
  if (!phone) return { ok: false, reason: 'no_phone' }
  // Семь цифр — нижняя граница осмысленного номера. Короче — это обрывок ввода, и набор такого
  // попадёт неизвестно куда.
  if (phone.length < 7) return { ok: false, reason: 'bad_phone', detail: maskPhone(phone) }

  if (input.blacklisted) return { ok: false, reason: 'blacklisted' }
  if (settings.allowlistOnly && !input.allowlisted) return { ok: false, reason: 'not_allowlisted', detail: maskPhone(phone) }

  if ((lead.attemptsToday ?? 0) >= settings.maxDailyAttempts) {
    return { ok: false, reason: 'daily_limit', detail: String(settings.maxDailyAttempts) }
  }

  const last = lead.lastAttemptAt ? new Date(lead.lastAttemptAt) : null
  if (last && Number.isFinite(last.getTime())) {
    const hours = (now.getTime() - last.getTime()) / 3_600_000
    if (hours < settings.minRetryIntervalHours) {
      return { ok: false, reason: 'too_soon', detail: `${hours.toFixed(1)} ч из ${settings.minRetryIntervalHours}` }
    }
  }

  return { ok: true }
}

/**
 * Фраза, которую человек обязан набрать, чтобы включить боевой режим.
 *
 * Не «да» и не галочка: подтверждение должно стоить осознанного усилия. Кнопку «да» жмут не глядя,
 * а фразу целиком набирают, только понимая, что произойдёт.
 */
export const LIVE_MODE_CONFIRMATION = 'ЗВОНИТЬ ПО-НАСТОЯЩЕМУ'

export function isLiveModeConfirmed(input: unknown): boolean {
  return String(input ?? '').trim().toUpperCase() === LIVE_MODE_CONFIRMATION
}

/**
 * Вычистить телефоны из чужого текста.
 *
 * Сюда попадает то, что вернул провайдер телефонии: идентификатор звонка, текст ошибки, сообщение
 * исключения. Всё это уезжает в состояние очереди, а состояние показывают человеку и пишут в
 * журнал. Провайдер регулярно кладёт полный номер в текст ошибки («no route to +998901234567»), и
 * тогда номер утекает именно там, где мы его старательно прятали.
 *
 * Семь цифр подряд — нижняя граница осмысленного номера, она же порог годности в decideEligibility.
 *
 * Разделители перечислены ШИРОКО и намеренно. Первая версия знала только пробел, скобки, дефис и
 * точку — а номера пишут и через косую черту, и через подчёркивание, и через длинное тире, и с
 * запятыми. Каждый неучтённый разделитель — это способ пронести номер целиком мимо очистки, причём
 * ровно в том тексте, который пишет чужая система.
 */
export function scrubPhones(text: unknown): string {
  return String(text ?? '').replace(/[\p{Nd}][\p{Nd}\s()\-.,/\\_+‐-―−]{4,}[\p{Nd}]/gu, (found) => {
    const digits = found.replace(/[^\p{Nd}]/gu, '')
    return digits.length >= 7 ? `***${digits.slice(-4)}` : found
  })
}
