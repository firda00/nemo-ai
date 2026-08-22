// Автодозвон: запреты, окно работы и невозможность позвонить без подтверждения человеком.
//
// ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ. Ошибка в этом модуле звонит живому человеку. Отозвать звонок нельзя, а
// извиниться перед списком из тысячи номеров — тем более. Поэтому проверяется не «работает ли
// набор», а НЕВОЗМОЖНОСТЬ набрать, пока не сошлось всё сразу.
//
// Время передаётся снаружи, а не берётся из часов: иначе половину случаев (полночь, границы окна,
// перерыв между попытками) пришлось бы ждать по-настоящему, и их бы просто не проверяли.
//
// Запуск: npm run test:dialer
import assertStrict from 'node:assert/strict'

const S = await import('./modules/dialer/safety.ts')
const { Dialer } = await import('./modules/dialer/queue.ts')

let checks = 0
const assert = new Proxy(assertStrict, {
  get: (target, key) => {
    const value = target[key]
    if (typeof value !== 'function') return value
    return (...args) => { checks++; return value.apply(target, args) }
  },
})

const SALT = 'test-salt'
const PHONE = '+998901234567'
const at = (iso) => new Date(iso)

// ── Номера: нормализация, отпечаток, маска ────────────────────────────────────────────────────
{
  assert.equal(S.normalizePhone('+998 (90) 123-45-67'), '998901234567')
  assert.equal(S.normalizePhone(null), '')
  /*
   * ДЛИННЕЕ ПЯТНАДЦАТИ — НЕ НОМЕР, А НЕ «ПОСЛЕДНИЕ ПЯТНАДЦАТЬ».
   *
   * Раньше здесь стояло обрезание хвоста, и это был прямой обход белого списка: пятнадцатизначному
   * разрешённому номеру достаточно приписать цифру спереди, чтобы хвост совпал и отпечаток сошёлся.
   * Проверка ниже воспроизводит ровно эту атаку.
   */
  assert.equal(S.normalizePhone('9'.repeat(30)), '')
  assert.equal(S.normalizePhone('9'.repeat(15)).length, 15)
  assert.equal(S.normalizePhone('9'.repeat(16)), '')

  const fifteen = '998901234567890'
  assert.notEqual(
    S.phoneFingerprint(fifteen, SALT),
    S.phoneFingerprint(`7${fifteen}`, SALT),
    'приписанная спереди цифра дала тот же отпечаток — белый список обходится',
  )

  /*
   * ОЧИСТКА ЧУЖОГО ТЕКСТА ОТ ТЕЛЕФОНОВ.
   *
   * Сюда попадает то, что написала чужая система: идентификатор звонка, текст ошибки, сообщение
   * исключения. Номера в них пишут как придётся, и каждый неучтённый разделитель — это способ
   * пронести номер целиком мимо очистки.
   */
  for (const written of [
    '+998 90 123 45 67', '+998-90-123-45-67', '+998/90/123/45/67', '+998_90_123_45_67',
    '998.901.234.567', '(998) 901 234 567', '998,901,234,567', '998–901–234–567', '99890123456789',
  ]) {
    const cleaned = S.scrubPhones(`no route to ${written} via trunk`)
    assert.equal(/\d{7,}/.test(cleaned.replace(/\D/g, '')), false, `номер прошёл мимо очистки: ${written}`)
  }
  // Короткое число номером не считается: чистить «trunk 12» незачем, а потеря цифр в диагностике
  // мешает разбирать сбои.
  assert.equal(S.scrubPhones('trunk 12 line 3'), 'trunk 12 line 3')
  assert.match(S.scrubPhones('SIP 503 for 998901234567'), /\*\*\*4567/)

  assert.equal(S.maskPhone(PHONE), '***4567', 'маска показывает лишнее или не то')
  assert.equal(S.maskPhone('12'), '***', 'короткий номер раскрыт целиком')

  // Отпечаток одинаков для разных записей ОДНОГО номера и различается при разной соли.
  assert.equal(S.phoneFingerprint('+998 90 123 45 67', SALT), S.phoneFingerprint('998901234567', SALT))
  assert.notEqual(S.phoneFingerprint(PHONE, SALT), S.phoneFingerprint(PHONE, 'другая-соль'))
  // Сам номер в отпечатке не читается.
  assert.equal(S.phoneFingerprint(PHONE, SALT).includes('4567'), false, 'номер виден в отпечатке')
  assert.match(S.phoneFingerprint(PHONE, SALT), /^[0-9a-f]{64}$/)
  assert.equal(S.phoneFingerprint('', SALT), '')
}

// ── Рабочее окно ──────────────────────────────────────────────────────────────────────────────
{
  const tz = { workHoursStart: '09:00', workHoursEnd: '21:00', timeZone: 'Asia/Tashkent' }
  // Ташкент = UTC+5. 04:00 UTC — это 09:00 на месте, начало окна.
  assert.equal(S.withinWorkHours(at('2026-08-20T04:00:00Z'), tz), true, 'начало окна отвергнуто')
  assert.equal(S.withinWorkHours(at('2026-08-20T03:59:00Z'), tz), false, 'звонок за минуту до открытия')
  assert.equal(S.withinWorkHours(at('2026-08-20T15:59:00Z'), tz), true, '20:59 на месте — ещё можно')
  assert.equal(S.withinWorkHours(at('2026-08-20T16:00:00Z'), tz), false, '21:00 — окно закрыто')
  // Ночь по серверу в UTC — рабочий день в Ташкенте. Ради этого пояс и передаётся.
  assert.equal(S.withinWorkHours(at('2026-08-20T05:00:00Z'), tz), true)

  /*
   * Окно через полночь. Без отдельной ветви сравнение «начало <= сейчас < конец» даёт ПУСТОЕ окно,
   * и автодозвон молча не работает никогда — отказ, неотличимый от «просто нет лидов».
   */
  const night = { workHoursStart: '21:00', workHoursEnd: '09:00', timeZone: 'UTC' }
  assert.equal(S.withinWorkHours(at('2026-08-20T23:00:00Z'), night), true, 'ночное окно не работает до полуночи')
  assert.equal(S.withinWorkHours(at('2026-08-20T03:00:00Z'), night), true, 'ночное окно не работает после полуночи')
  assert.equal(S.withinWorkHours(at('2026-08-20T12:00:00Z'), night), false, 'ночное окно пустило день')

  // Вырожденные настройки не должны открывать круглосуточный обзвон.
  assert.equal(S.withinWorkHours(at('2026-08-20T12:00:00Z'), { workHoursStart: '09:00', workHoursEnd: '09:00', timeZone: 'UTC' }), false)
  assert.equal(S.withinWorkHours(at('2026-08-20T12:00:00Z'), { workHoursStart: 'ерунда', workHoursEnd: '21:00', timeZone: 'UTC' }), false)
}

// ── Решение о постановке в очередь ────────────────────────────────────────────────────────────
const live = { ...S.DEFAULT_SETTINGS, enabled: true }
const workday = at('2026-08-20T07:00:00Z') // 12:00 в Ташкенте
const base = { settings: live, lead: { id: 'l1', phone: PHONE }, now: workday, blacklisted: false, allowlisted: true }

{
  assert.equal(S.decideEligibility(base).ok, true, 'исправный случай отвергнут')

  const refuse = (patch, reason) => {
    const decision = S.decideEligibility({ ...base, ...patch })
    assert.equal(decision.ok, false, `не отказано: ${reason}`)
    assert.equal(decision.reason, reason)
  }

  refuse({ settings: { ...live, enabled: false } }, 'disabled')
  refuse({ now: at('2026-08-20T01:00:00Z') }, 'outside_working_hours')
  refuse({ lead: { id: 'l1', phone: PHONE, status: 'закрыт' } }, 'closed_lead')
  refuse({ lead: { id: 'l1', phone: PHONE, status: 'WON' } }, 'closed_lead')
  refuse({ lead: { id: 'l1', phone: '' } }, 'no_phone')
  refuse({ lead: { id: 'l1', phone: '12345' } }, 'bad_phone')
  refuse({ blacklisted: true }, 'blacklisted')
  refuse({ allowlisted: false }, 'not_allowlisted')
  refuse({ lead: { id: 'l1', phone: PHONE, attemptsToday: 3 } }, 'daily_limit')
  refuse({ lead: { id: 'l1', phone: PHONE, lastAttemptAt: at('2026-08-20T06:30:00Z') } }, 'too_soon')

  // Через положенный перерыв — можно.
  assert.equal(S.decideEligibility({ ...base, lead: { id: 'l1', phone: PHONE, lastAttemptAt: at('2026-08-20T04:00:00Z') } }).ok, true)

  /*
   * ПОРЯДОК ОТКАЗОВ: от общего к частному.
   *
   * В выключенной системе не должно быть слышно про конкретный номер — иначе выключенный
   * автодозвон продолжает сообщать, кого он собирался обзванивать.
   */
  const off = S.decideEligibility({ ...base, settings: { ...live, enabled: false }, allowlisted: false, blacklisted: true })
  assert.equal(off.reason, 'disabled', 'выключенная система отвечает про номер')

  // Отказ не раскрывает номер целиком.
  const masked = S.decideEligibility({ ...base, allowlisted: false })
  assert.equal(String(masked.detail).includes('998901234567'), false, 'номер утёк в причину отказа')
  assert.equal(masked.detail, '***4567')
}

// ── Белый список включён по умолчанию ─────────────────────────────────────────────────────────
{
  assert.equal(S.DEFAULT_SETTINGS.enabled, false, 'автодозвон включён из коробки')
  assert.equal(S.DEFAULT_SETTINGS.dryRun, true, 'боевой режим из коробки')
  assert.equal(S.DEFAULT_SETTINGS.allowlistOnly, true, 'белый список выключен из коробки')
}

// ── Подтверждение человеком ───────────────────────────────────────────────────────────────────
{
  assert.equal(S.isLiveModeConfirmed(S.LIVE_MODE_CONFIRMATION), true)
  assert.equal(S.isLiveModeConfirmed(' звонить по-настоящему '), true, 'регистр и пробелы не должны мешать')
  // Согласие вообще — не подтверждение. Кнопку «да» жмут не глядя.
  for (const weak of ['да', 'yes', 'ok', 'подтверждаю', '', null, true, 1]) {
    assert.equal(S.isLiveModeConfirmed(weak), false, `принято слабое подтверждение: ${String(weak)}`)
  }
}

/*
 * ── ГЛАВНОЕ: БЕЗ ПОДТВЕРЖДЕНИЯ НАБОРА НЕ ПРОИСХОДИТ ───────────────────────────────────────────
 *
 * Три условия соединены И: симуляция выключена, человек подтвердил фразой, есть чем набирать.
 * Каждое закрывает свой способ ошибиться, поэтому проверяется снятие каждого по отдельности.
 */
{
  const dialed = []
  const place = async ({ phone, leadId }) => { dialed.push({ phone, leadId }); return { ok: true, externalId: 'call_1' } }
  const make = (settings, withPlace = true) => {
    const dialer = new Dialer({
      salt: SALT, settings: { ...live, ...settings },
      place: withPlace ? place : undefined, now: () => workday,
    })
    dialer.allow(PHONE)
    return dialer
  }
  const phones = new Map([['l1', PHONE]])

  // 1. Симуляция включена — звонка нет, сколько бы ни подтверждали.
  {
    dialed.length = 0
    const dialer = make({ dryRun: true })
    dialer.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)
    dialer.enqueue({ id: 'l1', phone: PHONE })
    const result = await dialer.run(phones)
    assert.equal(dialed.length, 0, 'позвонили в режиме симуляции')
    assert.equal(result.simulated, 1)
    assert.equal(dialer.status().mode, 'симуляция')
  }

  // 2. Симуляция выключена, но человек не подтвердил — звонка нет.
  {
    dialed.length = 0
    const dialer = make({ dryRun: false })
    dialer.enqueue({ id: 'l1', phone: PHONE })
    const result = await dialer.run(phones)
    assert.equal(dialed.length, 0, 'позвонили без подтверждения человеком')
    assert.equal(result.simulated, 1)
    assert.ok(result.details.some((one) => /подтверждения/.test(one)), 'причина не названа человеку')
  }

  // 3. Неверная фраза подтверждением не считается, и об этом сказано.
  {
    dialed.length = 0
    const dialer = make({ dryRun: false })
    assert.equal(dialer.confirmLiveMode('да'), false, 'слабое подтверждение принято')
    dialer.enqueue({ id: 'l1', phone: PHONE })
    await dialer.run(phones)
    assert.equal(dialed.length, 0, 'позвонили по слабому подтверждению')
  }

  // 4. Подтверждено и симуляция снята, но набирать нечем — звонка нет, и это не выдаётся за успех.
  {
    const dialer = make({ dryRun: false }, false)
    dialer.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)
    dialer.enqueue({ id: 'l1', phone: PHONE })
    const result = await dialer.run(phones)
    assert.equal(result.placed, 0)
    assert.ok(result.details.some((one) => /способ набора/.test(one)))
  }

  // 5. Сошлось всё — звонок идёт.
  {
    dialed.length = 0
    const dialer = make({ dryRun: false })
    dialer.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)
    dialer.enqueue({ id: 'l1', phone: PHONE })
    const result = await dialer.run(phones)
    assert.equal(result.placed, 1, 'при всех сошедшихся условиях звонок не состоялся')
    /*
     * ПРОВАЙДЕРУ УХОДИТ ПРИВЕДЁННЫЙ НОМЕР, А НЕ ИСХОДНАЯ СТРОКА.
     *
     * Отпечаток считается по цифрам, поэтому «998901234567» и «998901234567; что угодно» дают один
     * и тот же отпечаток и проходят сверку одинаково. Передав исходную строку, мы отдали бы
     * провайдеру телефонии всё, что к номеру приписали.
     */
    assert.equal(dialed[0].phone, S.normalizePhone(PHONE))
  }
}

/*
 * ── ЧТО ИМЕННО УХОДИТ ПРОВАЙДЕРУ ──────────────────────────────────────────────────────────────
 *
 * Сверка отпечатка не защищает от приписок: она смотрит только на цифры. Значит, набирать надо
 * цифры, а не то, что прислали.
 */
{
  const dialed = []
  const dialer = new Dialer({
    salt: SALT, settings: { ...live, dryRun: false }, now: () => workday,
    place: async (input) => { dialed.push(input.phone); return { ok: true, externalId: 'x' } },
  })
  dialer.allow(PHONE)
  dialer.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)

  const dirty = `${PHONE} , ; DROP`
  assert.equal(dialer.enqueue({ id: 'l1', phone: dirty }).queued, true, 'сверка отпечатка не пропустила свой же номер')
  await dialer.run(new Map([['l1', dirty]]))
  assert.equal(dialed[0], '998901234567', 'провайдеру ушла исходная строка вместе с припиской')
}

/*
 * ── ТЕЛЕФОН НЕ УТЕКАЕТ ЧЕРЕЗ ЧУЖОЙ ТЕКСТ ──────────────────────────────────────────────────────
 *
 * Провайдер регулярно кладёт полный номер в текст ошибки («no route to +998901234567»), а состояние
 * очереди показывают человеку и пишут в журнал. Так номер утекает ровно там, где его прятали.
 */
{
  const withError = new Dialer({
    salt: SALT, settings: { ...live, dryRun: false }, now: () => workday,
    place: async () => ({ ok: false, error: 'no route to +998901234567 via trunk 1' }),
  })
  withError.allow(PHONE)
  withError.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)
  withError.enqueue({ id: 'l1', phone: PHONE })
  await withError.run(new Map([['l1', PHONE]]))
  const text = JSON.stringify(withError.status())
  assert.equal(text.includes('998901234567'), false, 'номер утёк через текст ошибки провайдера')
  assert.ok(/\*\*\*4567/.test(text), 'от номера в ошибке не осталось даже хвоста для человека')

  // Исключение провайдера — тот же путь утечки и та же обработка. Плюс запись обязана перестать
  // быть «в очереди»: иначе следующий прогон наберёт человека второй раз.
  const throwing = new Dialer({
    salt: SALT, settings: { ...live, dryRun: false }, now: () => workday,
    place: async () => { throw new Error('SIP 503 for 998901234567') },
  })
  throwing.allow(PHONE)
  throwing.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)
  throwing.enqueue({ id: 'l1', phone: PHONE })
  const outcome = await throwing.run(new Map([['l1', PHONE]]))
  assert.equal(outcome.blocked, 1)
  assert.equal(throwing.status().queue[0].state, 'failed', 'после исключения запись осталась в очереди')
  assert.equal(JSON.stringify(throwing.status()).includes('998901234567'), false)

  // Идентификатор лида приходит снаружи и у половины выгрузок равен телефону.
  const viaLeadId = new Dialer({ salt: SALT, settings: live, now: () => workday })
  viaLeadId.allow(PHONE)
  viaLeadId.enqueue({ id: '998901234567', phone: PHONE })
  assert.equal(JSON.stringify(viaLeadId.status()).includes('998901234567'), false, 'номер утёк через lead_id')
}

/*
 * ── СУТОЧНЫЙ ПРЕДЕЛ И ПАУЗА СЧИТАЮТСЯ САМИМ ДОЗВОНИЛЬЩИКОМ ────────────────────────────────────
 *
 * Раньше оба брались из полей лида — то есть из того, что прислал вызывающий. Инструмент
 * dialer_queue_lead таких полей не имеет вовсе, поэтому через него ограничения не работали никогда:
 * проверка выполнялась, всегда видела ноль попыток и всегда пропускала.
 */
{
  let clock = workday
  const dialed = []
  const dialer = new Dialer({
    salt: SALT, now: () => clock,
    settings: { ...live, dryRun: false, maxDailyAttempts: 2, minRetryIntervalHours: 3 },
    place: async (input) => { dialed.push(input.phone); return { ok: true, externalId: 'x' } },
  })
  dialer.allow(PHONE)
  dialer.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)
  const phones = new Map([['l1', PHONE]])

  // Первый звонок проходит.
  dialer.enqueue({ id: 'l1', phone: PHONE })
  await dialer.run(phones)
  assert.equal(dialed.length, 1)

  // Сразу следом — пауза между попытками, о которой вызывающий ничего не сообщал.
  const tooSoon = dialer.enqueue({ id: 'l1', phone: PHONE })
  assert.equal(tooSoon.queued, false)
  assert.equal(tooSoon.decision.reason, 'too_soon')

  // Прошло четыре часа — пауза выдержана, второй звонок идёт.
  clock = new Date(workday.getTime() + 4 * 3_600_000)
  assert.equal(dialer.enqueue({ id: 'l1', phone: PHONE }).queued, true)
  await dialer.run(phones)
  assert.equal(dialed.length, 2)

  // Третий в те же сутки — предел, хотя пауза выдержана.
  clock = new Date(workday.getTime() + 8 * 3_600_000)
  const limited = dialer.enqueue({ id: 'l1', phone: PHONE })
  assert.equal(limited.queued, false)
  assert.equal(limited.decision.reason, 'daily_limit')

  // Предел считается по НОМЕРУ, а не по строке в базе: два лида с одним телефоном — один человек.
  const otherLead = dialer.enqueue({ id: 'l2', phone: PHONE })
  assert.equal(otherLead.decision.reason, 'daily_limit', 'предел обходится сменой идентификатора лида')

  // Наступили следующие сутки в рабочем поясе — счётчик сброшен.
  clock = new Date(workday.getTime() + 26 * 3_600_000)
  assert.equal(dialer.enqueue({ id: 'l1', phone: PHONE }).queued, true, 'суточный счётчик не сбрасывается')
}

// Статус приходит из чужой выгрузки и бывает с пробелами по краям. Не срезав их, мы звоним
// человеку, который уже купил.
{
  for (const status of ['won', ' WON ', '\tЗакрыт\n', 'Отказ ']) {
    const decision = S.decideEligibility({
      settings: { ...live, allowlistOnly: false }, lead: { id: 'l1', phone: PHONE, status },
      now: workday, blacklisted: false, allowlisted: true,
    })
    assert.equal(decision.reason, 'closed_lead', `статус «${status}» не распознан как закрытый`)
  }
}

// Настройки заморожены: счётчик суточных попыток хранит день В РАБОЧЕМ ПОЯСЕ, и смена пояса на
// живом дозвонильщике обнулила бы предел посреди дня.
{
  const dialer = new Dialer({ salt: SALT, settings: live, now: () => workday })
  assert.throws(() => { dialer.settings.timeZone = 'Pacific/Kiritimati' }, TypeError)
  assert.equal(dialer.settings.timeZone, live.timeZone ?? 'Asia/Tashkent')
}

/*
 * ── СТАТУС ЛИДА СВЕРЯЕТСЯ ПЕРЕД НАБОРОМ ───────────────────────────────────────────────────────
 *
 * Между постановкой и набором сделку успевают закрыть. Звонок «вы всё ещё думаете?» человеку,
 * который вчера купил, — худшее, что этот модуль может сделать.
 */
{
  const dialed = []
  const dialer = new Dialer({
    salt: SALT, settings: { ...live, dryRun: false }, now: () => workday,
    place: async (input) => { dialed.push(input.phone); return { ok: true, externalId: 'x' } },
  })
  dialer.allow(PHONE)
  dialer.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)
  dialer.enqueue({ id: 'l1', phone: PHONE, status: 'new' })

  const result = await dialer.run(new Map([['l1', PHONE]]), new Map([['l1', 'won']]))
  assert.equal(dialed.length, 0, 'закрытому лиду всё равно позвонили')
  assert.equal(result.blocked, 1)
  assert.ok(result.details.some((one) => /closed_lead/.test(one)))
}

/*
 * ── ПОВТОРНАЯ ПРОВЕРКА ПЕРЕД НАБОРОМ ──────────────────────────────────────────────────────────
 *
 * Между постановкой в очередь и набором проходит время. Окно успевает закрыться, номер успевает
 * попасть в чёрный список, а боевой режим мог быть включён уже ПОСЛЕ того, как очередь наполнилась
 * в симуляции. Проверка при постановке этот разрыв не закрывает.
 */
{
  const dialed = []
  const place = async (input) => { dialed.push(input); return { ok: true, externalId: 'x' } }
  let clock = workday
  const dialer = new Dialer({ salt: SALT, settings: { ...live, dryRun: false }, place, now: () => clock })
  dialer.allow(PHONE)
  dialer.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)
  dialer.enqueue({ id: 'l1', phone: PHONE })

  // Номер попал в чёрный список уже после постановки в очередь.
  dialer.block(PHONE)
  const blocked = await dialer.run(new Map([['l1', PHONE]]))
  assert.equal(dialed.length, 0, 'позвонили по номеру, попавшему в чёрный список после постановки')
  assert.equal(blocked.blocked, 1)
}
{
  const dialed = []
  let clock = workday
  const dialer = new Dialer({
    salt: SALT, settings: { ...live, dryRun: false },
    place: async (input) => { dialed.push(input); return { ok: true } }, now: () => clock,
  })
  dialer.allow(PHONE)
  dialer.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)
  dialer.enqueue({ id: 'l1', phone: PHONE })

  // Пока лид ждал в очереди, рабочий день кончился.
  clock = at('2026-08-20T18:00:00Z') // 23:00 в Ташкенте
  const late = await dialer.run(new Map([['l1', PHONE]]))
  assert.equal(dialed.length, 0, 'позвонили ночью — окно проверено только при постановке')
  assert.equal(late.blocked, 1)
}

/*
 * Подмена номера между решением и набором.
 *
 * Решение принималось по одному номеру, а набирается другой — так выглядит и ошибка в коде, и
 * попытка обойти белый список. Сверка идёт по отпечатку, а не по идентификатору лида.
 */
{
  const dialed = []
  const dialer = new Dialer({
    salt: SALT, settings: { ...live, dryRun: false },
    place: async (input) => { dialed.push(input); return { ok: true } }, now: () => workday,
  })
  dialer.allow(PHONE)
  dialer.confirmLiveMode(S.LIVE_MODE_CONFIRMATION)
  dialer.enqueue({ id: 'l1', phone: PHONE })

  const swapped = await dialer.run(new Map([['l1', '+998907654321']]))
  assert.equal(dialed.length, 0, 'набран номер, по которому решение не принималось')
  assert.equal(swapped.blocked, 1)
  assert.ok(swapped.details.some((one) => /не совпал/.test(one)))
}

// Один лид — одна запись в очереди: две записи означают два звонка одному человеку.
{
  const dialer = new Dialer({ salt: SALT, settings: live, now: () => workday })
  dialer.allow(PHONE)
  assert.equal(dialer.enqueue({ id: 'l1', phone: PHONE }).queued, true)
  assert.equal(dialer.enqueue({ id: 'l1', phone: PHONE }).queued, false, 'лид поставлен в очередь дважды')
  assert.equal(dialer.status().queue.length, 1)
}

// Состояние не отдаёт полных номеров: его показывают в терминале и в отчётах.
{
  const dialer = new Dialer({ salt: SALT, settings: live, now: () => workday })
  dialer.allow(PHONE)
  dialer.enqueue({ id: 'l1', phone: PHONE })
  const status = JSON.stringify(dialer.status())
  assert.equal(status.includes('998901234567'), false, 'полный номер виден в состоянии очереди')
  assert.ok(status.includes('***4567'))
}

console.log(`[OK] Dialer: ${checks} assertions`)
