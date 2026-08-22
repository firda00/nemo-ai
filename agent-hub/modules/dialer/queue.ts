/*
 * Очередь автодозвона.
 *
 * Хранится В ПАМЯТИ ПРОЦЕССА, и это осознанное ограничение, а не недоделка: у Nemo нет своей
 * таблицы звонков, а заводить её вместе с переносом значило бы протащить в ядро схему чужой
 * системы. Очередь переживает сеанс работы агента и не переживает перезапуск — для симуляции и
 * пилота этого достаточно, для боевого обзвона тысячи номеров нужно постоянное хранилище, и это
 * отдельное решение.
 *
 * ЗВОНОК НЕ ПРОИСХОДИТ ЗДЕСЬ. Набор — это зависимость `place`. Пока её не передали, любой звонок
 * остаётся симуляцией, сколько бы настроек ни включили.
 */
import { decideEligibility, isLiveModeConfirmed, localDay, maskPhone, normalizePhone, phoneFingerprint, scrubPhones, type DialerSettings, type Decision, type Lead } from './safety.ts'

export interface QueueItem {
  id: string
  leadId: string
  /** Хранится ОТПЕЧАТОК и последние цифры. Полного номера в очереди нет. */
  fingerprint: string
  masked: string
  /** Статус лида на момент постановки. Перед набором сверяется заново: сделку успевают закрыть. */
  status?: string
  queuedAt: Date
  state: 'queued' | 'simulated' | 'placed' | 'failed'
  detail?: string
}

/** Счётчик попыток по отпечатку. Живёт вместе с очередью. */
interface AttemptRecord {
  day: string
  count: number
  lastAt: Date | null
}

export interface PlaceCall {
  (input: { phone: string; leadId: string }): Promise<{ ok: boolean; externalId?: string; error?: string }>
}

export interface DialerDeps {
  settings?: Partial<DialerSettings>
  /** Соль для отпечатков. Разная у разных установок — иначе отпечатки сравнимы между заказчиками. */
  salt: string
  /** Отпечатки разрешённых номеров. */
  allowlist?: Set<string>
  blacklist?: Set<string>
  /** Кто набирает. Не передан — только симуляция. */
  place?: PlaceCall
  now?: () => Date
}

let counter = 0

export class Dialer {
  readonly settings: DialerSettings
  private readonly salt: string
  private readonly allowlist: Set<string>
  private readonly blacklist: Set<string>
  private readonly place: PlaceCall | null
  private readonly now: () => Date
  private readonly items: QueueItem[] = []
  private liveConfirmed = false
  /*
   * ПОПЫТКИ СЧИТАЕТ САМ ДОЗВОНИЛЬЩИК.
   *
   * Раньше суточный предел и пауза между попытками брались из полей лида — а лид приходит от
   * вызывающей стороны, то есть от модели. Инструмент dialer_queue_lead таких полей не имеет вовсе,
   * поэтому оба ограничения через него не работали никогда: проверка выполнялась, всегда видела
   * ноль попыток и всегда пропускала. Защита существовала на бумаге.
   *
   * Ключ — отпечаток номера, а не идентификатор лида: два лида с одним телефоном — это один человек,
   * и предел «три звонка в сутки» относится к нему, а не к строкам в базе.
   */
  private readonly attempts = new Map<string, AttemptRecord>()

  constructor(deps: DialerDeps) {
    const base = { enabled: false, dryRun: true, maxDailyAttempts: 3, minRetryIntervalHours: 2, workHoursStart: '09:00', workHoursEnd: '21:00', timeZone: 'Asia/Tashkent', allowlistOnly: true }
    /*
     * НАСТРОЙКИ ЗАМОРАЖИВАЮТСЯ.
     *
     * `readonly` в TypeScript запрещает переприсвоить поле, но не запрещает поменять свойство внутри
     * объекта — и это не придирка. Счётчик суточных попыток хранит день, посчитанный В РАБОЧЕМ
     * ПОЯСЕ; смена пояса на живом дозвонильщике сравнивает день из старого пояса с днём из нового,
     * они не совпадают, и предел «три звонка в сутки» обнуляется посреди дня. Настройки должны
     * задаваться при сборке и не меняться.
     */
    this.settings = Object.freeze({ ...base, ...(deps.settings ?? {}) })
    this.salt = deps.salt
    this.allowlist = deps.allowlist ?? new Set()
    this.blacklist = deps.blacklist ?? new Set()
    this.place = deps.place ?? null
    this.now = deps.now ?? (() => new Date())
  }

  /** Внести номер в белый список. Хранится отпечаток, сам номер не сохраняется. */
  allow(phone: string): string {
    const fingerprint = phoneFingerprint(phone, this.salt)
    if (fingerprint) this.allowlist.add(fingerprint)
    return maskPhone(phone)
  }

  block(phone: string): string {
    const fingerprint = phoneFingerprint(phone, this.salt)
    if (fingerprint) this.blacklist.add(fingerprint)
    return maskPhone(phone)
  }

  /**
   * Включить боевой режим.
   *
   * Требует набранной фразы. Возвращает false при неверной — молча включаться нельзя: человек
   * должен увидеть, что подтверждение НЕ принято, иначе он решит, что звонки идут, а идёт симуляция
   * (или, что хуже, наоборот).
   */
  confirmLiveMode(confirmation: unknown): boolean {
    if (!isLiveModeConfirmed(confirmation)) return false
    this.liveConfirmed = true
    return true
  }

  /**
   * Настоящий звонок возможен, только когда сошлось ВСЁ:
   * симуляция выключена, человек подтвердил фразой, и есть чем набирать.
   *
   * Три условия И, а не ИЛИ: каждое снимает свой способ ошибиться. Забытый флаг в конфиге,
   * неосознанное включение и переходник в никуда — разные беды, и защищаться от них надо порознь.
   */
  get willPlaceRealCalls(): boolean {
    return !this.settings.dryRun && this.liveConfirmed && this.place !== null
  }

  /**
   * История попыток по номеру, приведённая к виду, который понимает decideEligibility.
   *
   * Счётчик за сутки сбрасывается сменой ДАТЫ В РАБОЧЕМ ПОЯСЕ, а не по прошествии 24 часов: предел
   * «три звонка в сутки» человек понимает как календарный день у себя, а не скользящее окно.
   */
  private historyOf(fingerprint: string, now: Date): { attemptsToday: number; lastAttemptAt: Date | null } {
    const record = this.attempts.get(fingerprint)
    if (!record) return { attemptsToday: 0, lastAttemptAt: null }
    const today = localDay(now, this.settings.timeZone)
    return {
      attemptsToday: record.day === today ? record.count : 0,
      lastAttemptAt: record.lastAt,
    }
  }

  /** Отметить попытку. Считается ЛЮБОЙ набор, включая симуляцию и неудачный. */
  private recordAttempt(fingerprint: string, now: Date): void {
    const today = localDay(now, this.settings.timeZone)
    const record = this.attempts.get(fingerprint)
    if (record && record.day === today) { record.count += 1; record.lastAt = now; return }
    this.attempts.set(fingerprint, { day: today, count: 1, lastAt: now })
  }

  /** Поставить лид в очередь, если все запреты пройдены. */
  enqueue(lead: Lead): { queued: boolean; item?: QueueItem; decision: Decision } {
    const now = this.now()
    const fingerprint = phoneFingerprint(lead.phone, this.salt)
    const history = this.historyOf(fingerprint, now)
    const decision = decideEligibility({
      settings: this.settings,
      // История попыток берётся ИЗ ОЧЕРЕДИ, а не из того, что прислал вызывающий: поля лида приходят
      // от модели, и доверять им счёт собственных звонков — значит не иметь предела вовсе.
      lead: { ...lead, attemptsToday: history.attemptsToday, lastAttemptAt: history.lastAttemptAt },
      now,
      blacklisted: Boolean(fingerprint) && this.blacklist.has(fingerprint),
      allowlisted: Boolean(fingerprint) && this.allowlist.has(fingerprint),
    })
    if (!decision.ok) return { queued: false, decision }

    // Повтор того же лида не создаёт вторую запись: две записи — два звонка одному человеку.
    const existing = this.items.find((one) => one.leadId === lead.id && one.state === 'queued')
    if (existing) return { queued: false, decision: { ok: false, reason: 'too_soon', detail: 'уже в очереди' } }

    counter += 1
    const item: QueueItem = {
      id: `dial_${counter}`,
      leadId: lead.id,
      fingerprint,
      masked: maskPhone(lead.phone),
      status: lead.status,
      queuedAt: now,
      state: 'queued',
    }
    this.items.push(item)
    return { queued: true, item, decision }
  }

  /**
   * Обработать очередь.
   *
   * Проверки ПОВТОРЯЮТСЯ перед набором, хотя уже прошли при постановке. Это не лишнее: между
   * постановкой и набором проходит время — рабочее окно успевает закрыться, номер успевает попасть
   * в чёрный список, а боевой режим мог быть включён уже ПОСЛЕ того, как очередь наполнилась в
   * симуляции. Ровно этот разрыв и закрывает вторая проверка.
   */
  async run(phoneByLead: Map<string, string>, statusByLead: Map<string, string> = new Map()): Promise<{ simulated: number; placed: number; blocked: number; details: string[] }> {
    const details: string[] = []
    let simulated = 0
    let placed = 0
    let blocked = 0

    for (const item of this.items.filter((one) => one.state === 'queued')) {
      const phone = phoneByLead.get(item.leadId) ?? ''
      const fingerprint = phoneFingerprint(phone, this.salt)

      if (!normalizePhone(phone) || fingerprint !== item.fingerprint) {
        item.state = 'failed'
        item.detail = 'номер не совпал с тем, по которому принималось решение'
        blocked += 1
        details.push(`${item.masked}: ${item.detail}`)
        continue
      }
      if (this.blacklist.has(fingerprint)) {
        item.state = 'failed'; item.detail = 'номер в чёрном списке'; blocked += 1
        details.push(`${item.masked}: ${item.detail}`)
        continue
      }
      if (this.settings.allowlistOnly && !this.allowlist.has(fingerprint)) {
        item.state = 'failed'; item.detail = 'номера нет в белом списке'; blocked += 1
        details.push(`${item.masked}: ${item.detail}`)
        continue
      }
      if (!this.settings.enabled) {
        item.state = 'failed'; item.detail = 'автодозвон выключен'; blocked += 1
        details.push(`${item.masked}: ${item.detail}`)
        continue
      }
      const at = this.now()
      const history = this.historyOf(fingerprint, at)
      const decision = decideEligibility({
        settings: this.settings,
        lead: {
          id: item.leadId,
          phone,
          // Статус берётся СВЕЖИЙ, если его дали, иначе тот, что был при постановке. Между
          // постановкой и набором сделку успевают закрыть, и звонок «а вы всё ещё думаете?»
          // человеку, который вчера купил, — худшее, что этот модуль может сделать.
          status: statusByLead.get(item.leadId) ?? item.status,
          attemptsToday: history.attemptsToday,
          lastAttemptAt: history.lastAttemptAt,
        },
        now: at,
        blacklisted: false,
        allowlisted: true,
      })
      if (!decision.ok) {
        item.state = 'failed'; item.detail = decision.reason; blocked += 1
        details.push(`${item.masked}: ${decision.reason}`)
        continue
      }

      /*
       * ПОПЫТКА ЗАСЧИТЫВАЕТСЯ ДО НАБОРА И В СИМУЛЯЦИИ ТОЖЕ.
       *
       * До набора — потому что если провайдер бросит исключение после того, как звонок уже пошёл,
       * попытка всё равно была. Считать после успеха значит не считать неудачные, которых у
       * автодозвона большинство, и предел «три в сутки» превратится в «три дозвона в сутки».
       *
       * В симуляции — потому что симуляция должна быть РЕПЕТИЦИЕЙ. Не считая попытки, она покажет
       * пятьдесят звонков там, где боевой режим сделает три, и человек примет решение по цифре,
       * которой не будет.
       */
      this.recordAttempt(fingerprint, at)

      if (!this.willPlaceRealCalls) {
        item.state = 'simulated'
        item.detail = this.settings.dryRun ? 'симуляция' : !this.liveConfirmed ? 'нет подтверждения человеком' : 'не задан способ набора'
        simulated += 1
        details.push(`${item.masked}: ${item.detail}`)
        continue
      }

      // Состояние меняется ДО обращения к провайдеру: иначе исключение оставит запись «в очереди», и
      // следующий прогон наберёт того же человека второй раз, а он уже взял трубку.
      item.state = 'failed'
      item.detail = 'набор не завершился'

      // Провайдеру уходит ПРИВЕДЁННЫЙ номер, а не исходная строка. Отпечаток считается по цифрам,
      // поэтому «998901234567» и «998901234567; drop» дают одинаковый отпечаток — и вторая строка
      // ушла бы провайдеру как есть.
      const dialed = normalizePhone(phone)
      try {
        const result = await this.place!({ phone: dialed, leadId: item.leadId })
        item.state = result.ok ? 'placed' : 'failed'
        // Всё, что вернул провайдер, чистится от телефонов: он охотно кладёт полный номер в текст
        // ошибки, а состояние очереди показывают человеку и пишут в журнал.
        item.detail = scrubPhones(result.ok ? result.externalId : result.error)
        if (result.ok) placed += 1; else blocked += 1
      } catch (error) {
        item.detail = scrubPhones(error instanceof Error ? error.message : String(error))
        blocked += 1
      }
      details.push(`${item.masked}: ${item.state}`)
    }

    return { simulated, placed, blocked, details }
  }

  /** Состояние очереди для человека. Полных номеров не отдаёт. */
  status(): {
    mode: 'симуляция' | 'боевой'
    enabled: boolean
    liveConfirmed: boolean
    canPlaceRealCalls: boolean
    allowlistSize: number
    queue: Array<{ id: string; leadId: string; phone: string; state: string; detail?: string }>
  } {
    return {
      mode: this.willPlaceRealCalls ? 'боевой' : 'симуляция',
      enabled: this.settings.enabled,
      liveConfirmed: this.liveConfirmed,
      canPlaceRealCalls: this.willPlaceRealCalls,
      allowlistSize: this.allowlist.size,
      queue: this.items.map((one) => ({
        id: one.id,
        // Идентификатор лида приходит СНАРУЖИ и бывает чем угодно, включая сам телефон: у половины
        // самодельных выгрузок ключ лида — это номер. Маскируется на выходе, иначе номер утекает
        // ровно тем же путём, который мы закрывали.
        leadId: scrubPhones(one.leadId),
        phone: one.masked,
        state: one.state,
        detail: one.detail,
      })),
    }
  }
}
