/*
 * Сборка автодозвона из переменных окружения.
 *
 * ОТДЕЛЬНЫМ ФАЙЛОМ, потому что здесь принимаются решения — что считать включённым, что разобрать из
 * строки, чему верить, — а точка входа nemo.mjs должна только соединять. Решения проверяются
 * вызовом функции, точка входа проверяется только запуском терминала.
 *
 * ГЛАВНОЕ ПРАВИЛО: любое сомнение читается как «не звонить». Переменная не задана, задана мусором,
 * задана наполовину — автодозвон не собирается или собирается выключенным. Обратное умолчание здесь
 * означало бы звонки живым людям из-за опечатки в .env.
 */
import { Dialer, type DialerDeps } from './queue.ts'
import { normalizePhone, phoneFingerprint, type DialerSettings } from './safety.ts'

export interface DialerEnv {
  /** Соль отпечатков. БЕЗ НЕЁ АВТОДОЗВОН НЕ СОБИРАЕТСЯ ВОВСЕ. */
  NEMO_DIALER_SALT?: string
  NEMO_DIALER_ENABLED?: string
  NEMO_DIALER_DRY_RUN?: string
  /** Разрешённые номера через запятую. Хранятся отпечатками, сами номера никуда не записываются. */
  NEMO_DIALER_ALLOWLIST?: string
  NEMO_DIALER_BLOCKLIST?: string
  /** Окно работы вида 09:00-21:00. */
  NEMO_DIALER_HOURS?: string
  NEMO_DIALER_TIMEZONE?: string
  NEMO_DIALER_MAX_DAILY?: string
}

const HOURS_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Включено ли.
 *
 * Только точные '1' и 'true'. Не «непустая строка»: `NEMO_DIALER_ENABLED=0` и
 * `NEMO_DIALER_ENABLED=нет` — это попытка выключить, и понять её как «включено» значит начать
 * звонить ровно тогда, когда человек этого не хотел.
 */
const truthy = (value: unknown): boolean => ['1', 'true', 'yes', 'да'].includes(String(value ?? '').trim().toLowerCase())

/**
 * Симуляция.
 *
 * Снимается ТОЛЬКО точным 'false'. Всё прочее — включая пустую строку, мусор и отсутствие
 * переменной — оставляет симуляцию. Проверка «=== true» вместо «!== false» уже однажды означала бы,
 * что опечатка в значении снимает защиту.
 */
const dryRunFrom = (value: unknown): boolean => String(value ?? '').trim().toLowerCase() !== 'false'

/**
 * Номера из строки.
 *
 * Разделители — запятая, точка с запятой и перевод строки. ПРОБЕЛ РАЗДЕЛИТЕЛЕМ НЕ СЧИТАЕТСЯ: номера
 * почти всегда записывают с пробелами («+998 90 111 22 33»), и разбиение по пробелу превратило бы
 * один номер в пять обрывков. Каждый из них короче семи цифр, все отсеиваются как мусор — и белый
 * список молча оказывается пустым, а автодозвон «почему-то никому не звонит».
 */
export function splitPhones(value: unknown): string[] {
  return String(value ?? '')
    .split(/[,;\n\r]+/)
    .map((one) => one.trim())
    .filter(Boolean)
}

export function settingsFromEnv(env: DialerEnv): Partial<DialerSettings> {
  const settings: Partial<DialerSettings> = {
    enabled: truthy(env.NEMO_DIALER_ENABLED),
    dryRun: dryRunFrom(env.NEMO_DIALER_DRY_RUN),
  }

  const hours = String(env.NEMO_DIALER_HOURS ?? '').trim()
  if (hours) {
    const parsed = hours.match(HOURS_RE)
    // Мусор в окне работы НЕ игнорируется молча: молча — значит окно осталось прежним, а человек
    // уверен, что сузил его. Здесь это стоит звонка в шесть утра.
    if (!parsed) throw new Error(`NEMO_DIALER_HOURS: ожидается 09:00-21:00, получено «${hours}»`)
    settings.workHoursStart = `${parsed[1]}:${parsed[2]}`
    settings.workHoursEnd = `${parsed[3]}:${parsed[4]}`
  }

  const zone = String(env.NEMO_DIALER_TIMEZONE ?? '').trim()
  if (zone) {
    // Неизвестный пояс роняет Intl уже при первом решении о звонке — то есть в самый неудобный
    // момент. Проверяется здесь, при сборке.
    try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }) } catch {
      throw new Error(`NEMO_DIALER_TIMEZONE: пояс «${zone}» неизвестен`)
    }
    settings.timeZone = zone
  }

  const daily = String(env.NEMO_DIALER_MAX_DAILY ?? '').trim()
  if (daily) {
    const value = Number(daily)
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`NEMO_DIALER_MAX_DAILY: ожидается целое число попыток, получено «${daily}»`)
    }
    settings.maxDailyAttempts = value
  }

  return settings
}

/**
 * Собрать автодозвон или вернуть null.
 *
 * null — это не отказ в работе, а отсутствие инструмента: реестр его тогда не регистрирует, и модель
 * его не видит. Зарегистрированный, но неработающий автодозвон был бы хуже: модель отчиталась бы,
 * что лиды поставлены на обзвон, а не поставлено ничего.
 */
export function buildDialer(env: DialerEnv, extra: Partial<DialerDeps> = {}): Dialer | null {
  const salt = String(env.NEMO_DIALER_SALT ?? '').trim()
  if (!salt) return null

  const dialer = new Dialer({ salt, settings: settingsFromEnv(env), ...extra })
  for (const phone of splitPhones(env.NEMO_DIALER_ALLOWLIST)) {
    // Слишком короткое в белый список не попадает: обрывок ввода, разрешённый к набору, — это
    // разрешение звонить неизвестно куда.
    if (normalizePhone(phone).length >= 7) dialer.allow(phone)
  }
  for (const phone of splitPhones(env.NEMO_DIALER_BLOCKLIST)) {
    // А в чёрный список попадает ЛЮБОЕ значение, годное для отпечатка: здесь ошибка в сторону
    // «лишний номер не побеспокоят» безопаснее, чем в сторону «побеспокоят».
    if (phoneFingerprint(phone, salt)) dialer.block(phone)
  }
  return dialer
}
