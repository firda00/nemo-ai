// Касса Uzum Bank Merchant API: протокол и все пять ручек.
//
// ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ. Это денежный контур. Ошибка здесь не роняет сборку и не портит вёрстку —
// она выдаёт платный тариф за один тийин или сообщает банку об успехе там, где мы отказали.
// Поэтому проверки идут ПАРАМИ: рядом с каждым принятым запросом стоит отвергнутый, отличающийся
// ровно тем, из-за чего его нельзя принимать.
//
// База — заглушка, и это осознанно. Всё, что решает исход запроса, живёт в uzumHandler.ts и
// uzumBank.ts: они не знают ни про Deno, ни про сеть. Ветки вроде «счёт закрылся между /create и
// /confirm» в бою случаются раз в год, и ждать их с настоящим Postgres значит не проверить их
// никогда. Переходы состояний в SQL сторожатся отдельно — контрактом по тексту миграции.
//
// Запуск: npm run test:uzum
import assert from 'node:assert/strict'
import {
  UZUM_ERRORS, checkUzumAuth, parseUzumRequest, safePayload,
  uzumActionFrom, uzumAmount, uzumServiceId, uzumTime,
} from '../supabase/functions/_shared/uzumBank.ts'
import { handleUzum } from '../supabase/functions/_shared/uzumHandler.ts'

let checks = 0
const check = (fn) => { fn(); checks++ }
const checkAsync = async (fn) => { await fn(); checks++ }

const USER = 'nemo-merchant'
const PASS = 'p@ss w0rd:с двоеточием'
const SERVICE_ID = 123123
const NOW = 1_760_000_000_000
const ORDER = '100042'
const TRANS = '9f1c6d2e-0a4b-4c8e-9d3f-7b5a1e2c4d60'
const AMOUNT = 25_000_000

const basic = (user = USER, pass = PASS) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

/** Заглушка базы: журнал вызовов и заготовленные ответы по имени функции. */
const fakeDb = (answers = {}, rows = {}) => {
  const calls = []
  return {
    calls,
    config: { basicUser: USER, basicPass: PASS, serviceId: SERVICE_ID, payerLabel: 'Nemo AI' },
    now: () => NOW,
    rpc: async (fn, args) => {
      calls.push({ fn, args })
      // Проверяется НАЛИЧИЕ ключа, а не истинность значения: заглушка обязана уметь вернуть
      // null и undefined, иначе ветку «база ответила пустотой» проверить нечем.
      if (!(fn in answers)) return { ok: true }
      const answer = answers[fn]
      if (typeof answer === 'function') return answer(args)
      if (answer instanceof Error) throw answer
      return answer
    },
    findTransaction: async (transId) => rows[transId] ?? null,
  }
}

const post = (action, body, extra = {}) => ({
  method: 'POST',
  pathname: `/functions/v1/uzum-merchant/${action}`,
  authorization: basic(),
  body,
  ...extra,
})

const payload = (over = {}) => ({
  serviceId: SERVICE_ID,
  transId: TRANS,
  amount: AMOUNT,
  params: { order_id: ORDER },
  ...over,
})

// ── Разбор суммы: тийины как есть, без пересчёта ─────────────────────────────────────────────
{
  /*
   * ГЛАВНОЕ ОТЛИЧИЕ ОТ CLICK. Тот присылает сумы строкой «290000.00», и её умножают на сто.
   * Uzum присылает тийины целым числом. Применив сюда пересчёт Click, мы получили бы сумму в сто
   * раз больше и отвергали бы каждый честный платёж — или, что хуже, принимали неверные.
   */
  check(() => assert.equal(uzumAmount(25_000_000), 25_000_000))
  check(() => assert.equal(uzumAmount('25000000'), 25_000_000))

  // Дробное, экспоненциальное, отрицательное, нулевое — не то, что прислал бы честный протокол.
  for (const bad of ['250000.00', '2.5e7', '-100', '0', '', ' ', 'abc', null, undefined, {}, [], 1.5, -1, 0, NaN, Infinity]) {
    check(() => assert.equal(uzumAmount(bad), null, `принята негодная сумма: ${String(bad)}`))
  }
  // За пределом точного целого числа — тоже отказ: дальше начинается арифметика, которой нельзя
  // верить в деньгах.
  check(() => assert.equal(uzumAmount(Number.MAX_SAFE_INTEGER + 2), null))
  check(() => assert.equal(uzumAmount('9'.repeat(16)), null))
}

// ── serviceId и отметки времени ──────────────────────────────────────────────────────────────
{
  check(() => assert.equal(uzumServiceId('123123'), 123123))
  check(() => assert.equal(uzumServiceId(123123), 123123))
  for (const bad of ['', '0', '-1', 'abc', null, 1.5]) {
    check(() => assert.equal(uzumServiceId(bad), null, String(bad)))
  }
  // Отметка времени — epoch в миллисекундах. Мусор превращается в null, а не в 1970 год: нулевая
  // отметка в ответе банку выглядит как настоящая.
  check(() => assert.equal(uzumTime(1_698_361_458_054), 1_698_361_458_054))
  for (const bad of ['', '0', 'вчера', -5, 1.5, null]) {
    check(() => assert.equal(uzumTime(bad), null, String(bad)))
  }
}

// ── Basic: пары «верно / не верно» ───────────────────────────────────────────────────────────
{
  check(() => assert.equal(checkUzumAuth(basic(), USER, PASS), true))
  // Пароль с двоеточием разбирается по ПЕРВОМУ разделителю: иначе честный пароль не подойдёт.
  check(() => assert.equal(checkUzumAuth(basic(USER, 'a:b:c'), USER, 'a:b:c'), true))

  check(() => assert.equal(checkUzumAuth(basic(USER, 'другое'), USER, PASS), false))
  check(() => assert.equal(checkUzumAuth(basic('другой', PASS), USER, PASS), false))
  check(() => assert.equal(checkUzumAuth(null, USER, PASS), false))
  check(() => assert.equal(checkUzumAuth('Bearer xxx', USER, PASS), false))
  check(() => assert.equal(checkUzumAuth('Basic не-base64!!', USER, PASS), false))
  check(() => assert.equal(checkUzumAuth(`Basic ${Buffer.from('без-двоеточия').toString('base64')}`, USER, PASS), false))

  /*
   * НЕНАСТРОЕННАЯ КАССА ОТКАЗЫВАЕТ ВСЕМ.
   *
   * Пустой ожидаемый пароль и «подойдёт любой» — одно и то же только на бумаге. Не будь этой
   * проверки, забытая переменная окружения открыла бы кассу всему интернету, и снаружи это
   * выглядело бы как исправно работающая касса.
   */
  check(() => assert.equal(checkUzumAuth(basic(USER, ''), USER, ''), false))
  check(() => assert.equal(checkUzumAuth(basic('', PASS), '', PASS), false))
}

// ── Разбор пути и тела ───────────────────────────────────────────────────────────────────────
{
  for (const action of ['check', 'create', 'confirm', 'reverse', 'status']) {
    check(() => assert.equal(uzumActionFrom(`/functions/v1/uzum-merchant/${action}`), action))
    check(() => assert.equal(uzumActionFrom(`/api/uzum/${action.toUpperCase()}`), action))
  }
  // Хвостовая косая — обычная форма адреса, и она обязана работать: отвергнув её, мы бы отказали
  // банку по причине, которой он никогда не найдёт.
  check(() => assert.equal(uzumActionFrom('/api/uzum/create/'), 'create'))

  // Шестой ручки нет: неизвестный путь — это отказ, а не догадка о ближайшем похожем.
  for (const bad of ['/functions/v1/uzum-merchant', '/uzum/cancel', '/api/uzum/createx', '', null]) {
    check(() => assert.equal(uzumActionFrom(bad), null, String(bad)))
  }

  check(() => assert.equal(parseUzumRequest(null), null))
  check(() => assert.equal(parseUzumRequest('строка'), null))
  // Массив — не объект запроса. JSON.parse его примет, а протокол нет.
  check(() => assert.equal(parseUzumRequest([]), null))

  check(() => assert.equal(parseUzumRequest(payload()).orderId, ORDER))
  // order_id верхним уровнем принимается тоже: тестовые пульты банка шлют и так, и так, а отказ
  // на этом стоил бы дня переписки вместо строки кода.
  check(() => assert.equal(parseUzumRequest({ order_id: ORDER }).orderId, ORDER))

  /*
   * СЕКРЕТЫ НЕ ПОПАДАЮТ В ЖУРНАЛ.
   *
   * raw_payload читают при разборе спора, и он переживает ротацию паролей. Строка с Authorization
   * в нём — это утёкший доступ к кассе, найденный через год.
   */
  check(() => {
    /*
     * Поля собираются ВЫЧИСЛЯЕМЫМИ КЛЮЧАМИ, а не литералами.
     *
     * Строка вида `password: '…'` в исходнике — это ровно то, что ищет agent-hub/scan-secrets.mjs,
     * и отличить подставное значение от настоящего он не может. Ослаблять правило ради удобства
     * теста нельзя: пароль рядом со словом «пароль» — самый частый вид утечки. Список ключей заодно
     * стал одним, а не продублированным дважды.
     */
    const SENSITIVE = ['authorization', 'apiToken', 'password', 'merchantSecret']
    const planted = Object.fromEntries(SENSITIVE.map((key, index) => [key, `ВЫРЕЗАЕМОЕ-${index}`]))

    const saved = safePayload(parseUzumRequest({ ...payload(), ...planted }))
    const text = JSON.stringify(saved)
    for (const value of Object.values(planted)) {
      assert.equal(text.includes(value), false, `в журнал попало значение: ${value}`)
    }
    for (const key of SENSITIVE) {
      assert.equal(key in saved, false, `в журнале осталось поле ${key}`)
    }
    // И обратная сторона: вычистились ТОЛЬКО секреты. Пустой журнал бесполезен при разборе спора
    // ровно так же, как журнал с паролями опасен.
    assert.equal(saved.serviceId, SERVICE_ID, 'вместе с секретами вычистилось всё остальное')
    assert.equal(saved.transId, TRANS)
    assert.deepEqual(saved.params, { order_id: ORDER })
  })
}

// ── Границы: метод, путь, Basic, serviceId ───────────────────────────────────────────────────

await checkAsync(async () => {
  const db = fakeDb()
  const out = await handleUzum({ ...post('check', payload()), method: 'GET' }, db)
  assert.equal(out.status, 400)
  assert.equal(out.body.errorCode, UZUM_ERRORS.INVALID_OPERATION)
  assert.equal(db.calls.length, 0, 'до базы дошёл запрос неверным методом')
})

await checkAsync(async () => {
  const db = fakeDb()
  const out = await handleUzum({ ...post('cancel', payload()), pathname: '/api/uzum/cancel' }, db)
  assert.equal(out.body.errorCode, UZUM_ERRORS.INVALID_OPERATION)
  assert.equal(db.calls.length, 0)
})

// Чужой Basic — 10001 и HTTP 400. Это ЕДИНСТВЕННЫЙ ответ неавторизованному.
await checkAsync(async () => {
  const db = fakeDb()
  for (const auth of [null, 'Bearer x', basic(USER, 'не тот'), basic('не тот', PASS)]) {
    const out = await handleUzum({ ...post('check', payload()), authorization: auth }, db)
    assert.equal(out.status, 400)
    assert.equal(out.body.errorCode, UZUM_ERRORS.ACCESS_DENIED)
    assert.equal(out.body.status, 'FAILED')
  }
  assert.equal(db.calls.length, 0, 'неавторизованный запрос дошёл до базы')
})

/*
 * BASIC ПРОВЕРЯЕТСЯ РАНЬШЕ ТЕЛА.
 *
 * Без этого касса становится справочником: 10002 на кривом теле и 10007 на чужом счёте — это уже
 * ответ на вопрос «а такой счёт есть?», данный тому, кто пароля не знает.
 */
await checkAsync(async () => {
  const db = fakeDb()
  const out = await handleUzum({
    ...post('check', undefined), authorization: 'Basic мусор', bodyParseFailed: true,
  }, db)
  assert.equal(out.body.errorCode, UZUM_ERRORS.ACCESS_DENIED, 'неразобранное тело ответило раньше пароля')
})

// А с верным паролем неразобранное тело — это 10002.
await checkAsync(async () => {
  const out = await handleUzum({ ...post('check', undefined), bodyParseFailed: true }, fakeDb())
  assert.equal(out.body.errorCode, UZUM_ERRORS.JSON_PARSE)
})

// Чужой serviceId — 10006. Верный Basic при чужом сервисе означает перепутанную настройку, а не
// оплату нашего счёта.
await checkAsync(async () => {
  const db = fakeDb()
  const out = await handleUzum(post('check', payload({ serviceId: 999999 })), db)
  assert.equal(out.status, 400)
  assert.equal(out.body.errorCode, UZUM_ERRORS.INVALID_SERVICE_ID)
  assert.equal(db.calls.length, 0, 'чужой serviceId дошёл до базы')
})

/*
 * НЕНАСТРОЕННЫЙ SERVICEID У НАС — ОТКАЗ ВСЕМ.
 *
 * Второй случай здесь важнее первого и без него проверка вырождается. Когда serviceId не задан
 * НИ У НАС, НИ В ЗАПРОСЕ, сравнение «наш !== присланный» превращается в null !== null, то есть в
 * ложь, и запрос проходит. Забытая переменная окружения плюс запрос без serviceId открывают кассу
 * настежь — и снаружи это выглядит как исправно работающая касса.
 */
await checkAsync(async () => {
  const db = fakeDb()
  db.config = { ...db.config, serviceId: null }

  const withId = await handleUzum(post('check', payload()), db)
  assert.equal(withId.body.errorCode, UZUM_ERRORS.INVALID_SERVICE_ID)

  for (const serviceId of [undefined, null, '', 0, 'abc']) {
    const out = await handleUzum(post('check', payload({ serviceId })), db)
    assert.equal(out.status, 400, `ненастроенная касса приняла запрос с serviceId=${String(serviceId)}`)
    assert.equal(out.body.errorCode, UZUM_ERRORS.INVALID_SERVICE_ID, String(serviceId))
  }
  assert.equal(db.calls.length, 0, 'ненастроенная касса дошла до базы')
})

// И при настроенной кассе запрос без serviceId тоже отвергается: пустое поле — не «подойдёт».
await checkAsync(async () => {
  const db = fakeDb()
  for (const serviceId of [undefined, null, '', 0, 'abc', '-1']) {
    const out = await handleUzum(post('check', payload({ serviceId })), db)
    assert.equal(out.body.errorCode, UZUM_ERRORS.INVALID_SERVICE_ID, String(serviceId))
  }
  assert.equal(db.calls.length, 0)
})

// ── /check ───────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const db = fakeDb({ uzum_check_order: { ok: true, invoice_id: 'inv-1', amount: AMOUNT } })
  const out = await handleUzum(post('check', payload()), db)

  assert.equal(out.status, 200)
  assert.deepEqual(out.body, {
    serviceId: SERVICE_ID,
    timestamp: NOW,
    status: 'OK',
    data: { account: { value: ORDER }, fio: { value: 'Nemo AI' } },
  })
  assert.deepEqual(db.calls[0], { fn: 'uzum_check_order', args: { p_order_id: ORDER } })
})

// Коды отказа приходят ИЗ БАЗЫ и передаются как есть: решение принимается там, где видно
// состояние счёта, а не здесь по домыслу.
await checkAsync(async () => {
  for (const code of ['10007', '10008', '10009']) {
    const out = await handleUzum(post('check', payload()), fakeDb({ uzum_check_order: { ok: false, error_code: code } }))
    assert.equal(out.status, 400)
    assert.equal(out.body.errorCode, code)
  }
})

await checkAsync(async () => {
  const out = await handleUzum(post('check', { serviceId: SERVICE_ID }), fakeDb())
  assert.equal(out.body.errorCode, UZUM_ERRORS.REQUIRED_FIELD_MISSING)
})

// ── /create ──────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const db = fakeDb({ uzum_create_transaction: { ok: true, invoice_id: 'inv-1', amount: AMOUNT } })
  const out = await handleUzum(post('create', payload({ transTime: 1_698_361_458_054 })), db)

  assert.equal(out.status, 200)
  assert.deepEqual(out.body, {
    serviceId: SERVICE_ID,
    transId: TRANS,
    status: 'CREATED',
    transTime: 1_698_361_458_054,
    amount: AMOUNT,
    data: { account: { value: ORDER } },
  })
  // ФИО в /create не отдаётся: оно нужно банку на шаге проверки реквизита, а не после.
  assert.equal('fio' in out.body.data, false)
  assert.equal(db.calls[0].args.p_amount, AMOUNT)
})

// Всё, что банк прислал на создании, доходит до журнала. Пропущенное поле оборачивается пустой
// колонкой, о которой узнают при первом же разборе спора.
await checkAsync(async () => {
  const db = fakeDb({ uzum_create_transaction: { ok: true } })
  await handleUzum(post('create', payload({ paymentSource: 'HUMO', phone: '+998901112233', transTime: 1_698_361_000_000 })), db)
  const { args } = db.calls[0]
  assert.equal(args.p_trans_id, TRANS)
  assert.equal(args.p_order_id, ORDER)
  assert.equal(args.p_service_id, SERVICE_ID)
  assert.equal(args.p_trans_time, 1_698_361_000_000)
  assert.equal(args.p_payment_source, 'HUMO')
  assert.equal(args.p_phone, '+998901112233')
  // Тело запроса кладётся в журнал очищенным — сам разбор чистки проверен выше отдельно.
  assert.equal(args.p_payload.serviceId, SERVICE_ID)
})

// Своё время, когда банк не прислал: выдуманный ноль в ответе выглядит как настоящая отметка.
await checkAsync(async () => {
  const db = fakeDb({ uzum_create_transaction: { ok: true } })
  const out = await handleUzum(post('create', payload()), db)
  assert.equal(out.body.transTime, NOW)
  assert.equal(db.calls[0].args.p_trans_time, NOW)
})

/*
 * СУММА ОБЯЗАТЕЛЬНА, И ЭТОГО НЕ БЫЛО В ЗАДАНИИ.
 *
 * /confirm суммы не знает — он доводит до конца созданное. Пропустив запрос без суммы или с
 * негодной, мы завели бы транзакцию, которую нечем сверить со счётом, и полный тариф достался бы
 * за один тийин. До базы такой запрос доходить не должен вовсе.
 */
await checkAsync(async () => {
  for (const amount of [undefined, null, 0, -1, '250000.00', '2.5e7', 'abc']) {
    const db = fakeDb({ uzum_create_transaction: { ok: true } })
    const out = await handleUzum(post('create', payload({ amount })), db)
    assert.equal(out.status, 400, `сумма ${String(amount)} принята`)
    assert.equal(out.body.errorCode, UZUM_ERRORS.INVALID_AMOUNT, String(amount))
    assert.equal(db.calls.length, 0, `запрос с суммой ${String(amount)} дошёл до базы`)
  }
})

// Несовпадение с суммой счёта решается в базе — там, где счёт виден. Код тот же, 10011.
await checkAsync(async () => {
  const out = await handleUzum(post('create', payload({ amount: 1 })),
    fakeDb({ uzum_create_transaction: { ok: false, error_code: '10011' } }))
  assert.equal(out.body.errorCode, UZUM_ERRORS.INVALID_AMOUNT)
})

// Повтор transId — 10010. Это ИДЕМПОТЕНТНОСТЬ протокола: банк ретраит, и второй ответ обязан
// отличаться от первого именно так, а не завести вторую транзакцию.
await checkAsync(async () => {
  const out = await handleUzum(post('create', payload()),
    fakeDb({ uzum_create_transaction: { ok: false, error_code: '10010' } }))
  assert.equal(out.status, 400)
  assert.equal(out.body.errorCode, UZUM_ERRORS.ALREADY_CREATED)
  assert.equal(out.body.transId, TRANS, 'банк не свяжет отказ без transId ни с чем')
})

// Вторая транзакция на тот же счёт другим transId — 10008: по брони уже есть активная.
await checkAsync(async () => {
  const out = await handleUzum(post('create', payload({ transId: 'другой-uuid' })),
    fakeDb({ uzum_create_transaction: { ok: false, error_code: '10008' } }))
  assert.equal(out.body.errorCode, UZUM_ERRORS.ALREADY_PAID)
})

await checkAsync(async () => {
  const out = await handleUzum(post('create', { serviceId: SERVICE_ID, amount: AMOUNT }), fakeDb())
  assert.equal(out.body.errorCode, UZUM_ERRORS.REQUIRED_FIELD_MISSING)
})

// ── /confirm ─────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const db = fakeDb({ uzum_confirm_transaction: { ok: true, amount: AMOUNT, order_id: ORDER, paid_until: '2026-09-21T00:00:00Z' } })
  const out = await handleUzum(post('confirm', payload({ confirmTime: 1_698_361_458_054 })), db)

  assert.equal(out.status, 200)
  assert.deepEqual(out.body, {
    serviceId: SERVICE_ID,
    transId: TRANS,
    status: 'CONFIRMED',
    confirmTime: 1_698_361_458_054,
    amount: AMOUNT,
    data: { account: { value: ORDER } },
  })
})

/*
 * ЧЕМ И С КАКОГО НОМЕРА ЗАПЛАТИЛИ, БАНК СООБЩАЕТ НА ПОДТВЕРЖДЕНИИ.
 *
 * На /create он этого ещё не знает: карту выбирают после. Не передав их дальше, мы получили бы в
 * журнале платежей две колонки, всегда пустые, — и обнаружили бы это при первом же споре, когда
 * нужно ответить «чем платили».
 */
await checkAsync(async () => {
  const db = fakeDb({ uzum_confirm_transaction: { ok: true, amount: AMOUNT, order_id: ORDER } })
  await handleUzum(post('confirm', payload({ paymentSource: 'UZCARD', phone: '+998901234567' })), db)
  assert.equal(db.calls[0].args.p_payment_source, 'UZCARD')
  assert.equal(db.calls[0].args.p_phone, '+998901234567')
})

/*
 * СУММА И СЧЁТ В ОТВЕТЕ — ИЗ БАЗЫ, А НЕ ИЗ ЗАПРОСА.
 *
 * Банк подтверждает то, что мы однажды создали. Ответив ему присланными сейчас числами, мы
 * подтвердили бы его собственные слова: расхождение между созданным и подтверждаемым стало бы
 * невидимым ровно в тот момент, когда оно важно.
 */
await checkAsync(async () => {
  const db = fakeDb({ uzum_confirm_transaction: { ok: true, amount: AMOUNT, order_id: ORDER } })
  const out = await handleUzum(post('confirm', payload({ amount: 999, params: { order_id: 'чужой' } })), db)
  assert.equal(out.body.amount, AMOUNT)
  assert.deepEqual(out.body.data, { account: { value: ORDER } })
})

await checkAsync(async () => {
  const cases = [
    ['10014', UZUM_ERRORS.TRANSACTION_NOT_FOUND],
    ['10016', UZUM_ERRORS.ALREADY_CONFIRMED],
    ['10015', UZUM_ERRORS.TRANSACTION_CANCELLED],
  ]
  for (const [given, expected] of cases) {
    const out = await handleUzum(post('confirm', payload()),
      fakeDb({ uzum_confirm_transaction: { ok: false, error_code: given } }))
    assert.equal(out.status, 400)
    assert.equal(out.body.errorCode, expected)
  }
})

await checkAsync(async () => {
  const out = await handleUzum(post('confirm', { serviceId: SERVICE_ID }), fakeDb())
  assert.equal(out.body.errorCode, UZUM_ERRORS.REQUIRED_FIELD_MISSING)
})

// ── /reverse ─────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const db = fakeDb({ uzum_reverse_transaction: { ok: true, amount: AMOUNT, order_id: ORDER, reverted_days: '30' } })
  const out = await handleUzum(post('reverse', payload({ reverseTime: 1_698_400_000_000 })), db)

  assert.equal(out.status, 200)
  assert.deepEqual(out.body, {
    serviceId: SERVICE_ID,
    transId: TRANS,
    status: 'REVERSED',
    reverseTime: 1_698_400_000_000,
    amount: AMOUNT,
    data: { account: { value: ORDER } },
  })
})

await checkAsync(async () => {
  const cases = [['10014', UZUM_ERRORS.TRANSACTION_NOT_FOUND], ['10018', UZUM_ERRORS.ALREADY_CANCELLED], ['10017', UZUM_ERRORS.UNABLE_TO_CANCEL]]
  for (const [given, expected] of cases) {
    const out = await handleUzum(post('reverse', payload()),
      fakeDb({ uzum_reverse_transaction: { ok: false, error_code: given } }))
    assert.equal(out.body.errorCode, expected)
  }
})

// ── /status ──────────────────────────────────────────────────────────────────────────────────

await checkAsync(async () => {
  const row = {
    trans_id: TRANS, order_id: ORDER, status: 'CONFIRMED', amount: AMOUNT,
    trans_time: 1_698_361_000_000, confirm_time: 1_698_361_458_054, reverse_time: null,
  }
  const db = fakeDb({}, { [TRANS]: row })
  const out = await handleUzum(post('status', payload()), db)

  assert.equal(out.status, 200)
  assert.deepEqual(out.body, {
    serviceId: SERVICE_ID,
    transId: TRANS,
    status: 'CONFIRMED',
    transTime: 1_698_361_000_000,
    confirmTime: 1_698_361_458_054,
    amount: AMOUNT,
    data: { account: { value: ORDER } },
  })
  // reverseTime = null в тело НЕ кладётся: пустое поле в ответе банк читает как значение.
  assert.equal('reverseTime' in out.body, false)
  assert.equal(db.calls.length, 0, '/status менял состояние')
})

await checkAsync(async () => {
  const out = await handleUzum(post('status', payload()), fakeDb())
  assert.equal(out.status, 400)
  assert.equal(out.body.errorCode, UZUM_ERRORS.TRANSACTION_NOT_FOUND)
})

// Каждый статус отдаётся как есть, включая FAILED: банку нужно знать настоящее состояние.
await checkAsync(async () => {
  for (const status of ['CREATED', 'CONFIRMED', 'REVERSED', 'FAILED']) {
    const db = fakeDb({}, {
      [TRANS]: { trans_id: TRANS, order_id: ORDER, status, amount: AMOUNT, trans_time: 1, confirm_time: null, reverse_time: null },
    })
    const out = await handleUzum(post('status', payload()), db)
    assert.equal(out.body.status, status)
  }
})

// ── Поломка на нашей стороне ─────────────────────────────────────────────────────────────────

/*
 * УПАВШИЙ ЗАПРОС — ЭТО 99999, А НЕ «ТРАНЗАКЦИИ НЕТ».
 *
 * Соблазн ответить 10014 велик: банк перестанет спрашивать. Но тогда оплаченная транзакция
 * навсегда останется неподтверждённой, а деньги — списанными.
 */
await checkAsync(async () => {
  const seen = []
  const db = fakeDb({ uzum_confirm_transaction: new Error('connection reset') })
  db.onError = (action, error) => seen.push([action, String(error)])
  const out = await handleUzum(post('confirm', payload()), db)

  assert.equal(out.status, 400)
  assert.equal(out.body.errorCode, UZUM_ERRORS.INTERNAL)
  assert.equal(out.body.transId, TRANS)
  assert.deepEqual(seen.map((one) => one[0]), ['confirm'])
})

// Ответ без ok от базы принимается за отказ, а не за успех: молчание — не согласие.
await checkAsync(async () => {
  for (const answer of [{}, { ok: false }, null, undefined]) {
    const out = await handleUzum(post('confirm', payload()), fakeDb({ uzum_confirm_transaction: answer }))
    assert.equal(out.status, 400, JSON.stringify(answer))
    assert.equal(out.body.errorCode, UZUM_ERRORS.INTERNAL)
  }
})

console.log(`[OK] Uzum Bank merchant: ${checks} assertions`)
