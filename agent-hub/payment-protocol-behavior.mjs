import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  CLICK_ACTION,
  CLICK_ERRORS,
  PAYME_ERRORS,
  amountToTiyin,
  checkClickSignature,
  checkInvoicePayable,
  checkPaymeAuth,
  clickResponse,
  clickSignature,
  constantTimeEqual,
  parseClickRequest,
  parsePaymeRequest,
  paymeFailure,
  paymeInvoiceRef,
  invoiceRefFrom,
  sameInvoiceRef,
  paymeExpired,
  PAYME_DATA_FIELD,
  PAYME_CANCEL_TIMEOUT,
  PAYME_MESSAGES,
  paymeCheckoutUrl,
  clickCheckoutUrl,
  PLAN_PRICE_UZS,
} from '../supabase/functions/_shared/paymentProtocol.ts'
import { PLAN_LIMITS } from '../supabase/functions/_shared/plans.ts'

// --- Сумма разбирается по строке, а не умножением ---------------------------------------------
// «290000.00» * 100 через Number однажды даст 28999999.999999996 и отвергнет верный платёж — или,
// что хуже, примет неверный.

assert.equal(amountToTiyin('290000.00'), 29_000_000)
assert.equal(amountToTiyin('290000'), 29_000_000)
assert.equal(amountToTiyin('0.01'), 1)
assert.equal(amountToTiyin('1.5'), 150, 'один знак после точки — это десятые сума')
assert.equal(amountToTiyin(290000), 29_000_000, 'число тоже принимается')

// Способы проскочить проверку, а не честные суммы.
// Пробелы ПО КРАЯМ обрезаются: подпись Click считается по сырой строке, а обрезка касается
// только сравнения с суммой счёта. Пробел ВНУТРИ числа — уже не сумма.
assert.equal(amountToTiyin(' 290000 '), 29_000_000)
for (const bad of ['2.9e5', '290000.001', '-100', '0', '290 000', '', 'abc', null, undefined, {}, NaN, Infinity]) {
  assert.equal(amountToTiyin(bad), null, `не сумма: ${JSON.stringify(bad)}`)
}

// --- Сравнение постоянным временем ------------------------------------------------------------
// Обычное === выходит на первом несовпавшем байте, и подпись подбирается побайтово по времени.

assert.equal(constantTimeEqual('abc', 'abc'), true)
assert.equal(constantTimeEqual('abc', 'abd'), false)
assert.equal(constantTimeEqual('abc', 'abcd'), false, 'разная длина — не равны')
assert.equal(constantTimeEqual('', ''), true)
assert.equal(constantTimeEqual('ключ', 'ключ'), true, 'кириллица сравнивается побайтово')

// --- Payme: авторизация -----------------------------------------------------------------------

const basic = (login, key) => 'Basic ' + Buffer.from(`${login}:${key}`).toString('base64')

assert.equal(checkPaymeAuth(basic('Paycom', 'secret'), 'Paycom', 'secret'), true)
assert.equal(checkPaymeAuth(basic('Paycom', 'wrong'), 'Paycom', 'secret'), false)
assert.equal(checkPaymeAuth(basic('other', 'secret'), 'Paycom', 'secret'), false)
// Ненастроенная касса не пропускает никого: пустой ожидаемый ключ — не «любой ключ подойдёт».
assert.equal(checkPaymeAuth(basic('Paycom', ''), 'Paycom', ''), false, 'без настроенного ключа доступа нет')
assert.equal(checkPaymeAuth('Bearer secret', 'Paycom', 'secret'), false, 'схема должна быть Basic')
assert.equal(checkPaymeAuth('Basic !!!не-base64', 'Paycom', 'secret'), false)
assert.equal(checkPaymeAuth(null, 'Paycom', 'secret'), false)
// Ключ с двоеточием внутри не должен обрезаться: разделяет ПЕРВОЕ двоеточие.
assert.equal(checkPaymeAuth(basic('Paycom', 'a:b:c'), 'Paycom', 'a:b:c'), true)

// --- Payme: разбор запроса --------------------------------------------------------------------

const created = parsePaymeRequest({ id: 7, method: 'CreateTransaction', params: { id: 'tx1', amount: 100 } })
assert.equal(created.method, 'CreateTransaction')
assert.equal(created.id, 7)
assert.deepEqual(created.params, { id: 'tx1', amount: 100 })

// id возвращается как пришёл, включая null: касса сопоставляет ответ с запросом по нему.
assert.equal(parsePaymeRequest({ id: null, method: 'CheckPerformTransaction' }).id, null)
assert.deepEqual(parsePaymeRequest({ method: 'X' }).params, {}, 'нет params — пустой объект, не падение')
assert.equal(parsePaymeRequest({ id: 1 }), null, 'без метода это не запрос Payme')
assert.equal(parsePaymeRequest('строка'), null)
assert.equal(parsePaymeRequest(null), null)

// Счёт берётся только как номер или uuid: «1 OR 1=1» и прочее в account не должно доехать до базы.
assert.deepEqual(paymeInvoiceRef({ account: { invoice_no: '100042' } }), { by: 'no', value: 100042 })
assert.deepEqual(paymeInvoiceRef({ account: { invoice_no: 100042 } }), { by: 'no', value: 100042 },
  'касса вправе прислать номер числом, а не строкой')
assert.deepEqual(paymeInvoiceRef({ account: { invoice_id: '9329393e-b5ab-4f20-8b8f-ead0ad466148' } }),
  { by: 'id', value: '9329393e-b5ab-4f20-8b8f-ead0ad466148' }, 'ссылки, выданные до перехода на номера, работают')
assert.deepEqual(paymeInvoiceRef({ account: { order_id: '9329393e-b5ab-4f20-8b8f-ead0ad466148' } }),
  { by: 'id', value: '9329393e-b5ab-4f20-8b8f-ead0ad466148' })
for (const bad of ['1 OR 1=1', '0', '-5', '1.5', '12e3', '', '   ', '9999999999999999999999']) {
  assert.equal(invoiceRefFrom(bad), null, `не ссылка на счёт: ${JSON.stringify(bad)}`)
}
assert.equal(paymeInvoiceRef({ account: {} }), null)
assert.equal(paymeInvoiceRef({}), null)

// Повтор Create обязан прийти на ТОТ ЖЕ счёт, каким бы способом касса на него ни сослалась.
const linked = { id: '9329393e-b5ab-4f20-8b8f-ead0ad466148', invoice_no: 100042 }
assert.equal(sameInvoiceRef({ by: 'no', value: 100042 }, linked), true)
assert.equal(sameInvoiceRef({ by: 'id', value: linked.id }, linked), true)
assert.equal(sameInvoiceRef({ by: 'no', value: 100043 }, linked), false, 'соседний счёт — не тот же счёт')
assert.equal(sameInvoiceRef(null, linked), false, 'ссылки нет — совпадением это не считается')
assert.equal(sameInvoiceRef({ by: 'no', value: 100042 }, null), false)

// --- Payme: error.data называет поле ----------------------------------------------------------
// Требование сертификации: касса подсвечивает покупателю то поле, которое он может исправить. Без
// data он видит «ошибка» и не знает, ошибся номером счёта или суммой.

const accountError = paymeFailure(1, PAYME_ERRORS.INVOICE_NOT_FOUND, PAYME_MESSAGES.invoice_not_found, PAYME_DATA_FIELD.ACCOUNT)
assert.equal(accountError.error.data, 'invoice_no')
assert.equal(paymeFailure(1, PAYME_ERRORS.INVALID_AMOUNT, PAYME_MESSAGES.invalid_amount, PAYME_DATA_FIELD.AMOUNT).error.data, 'amount')
// Там, где поля нет, data не выдумывается: «ошибка в поле cannot_perform» сбила бы кассу с толку.
assert.equal('data' in paymeFailure(1, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform).error, false)

// Разбор тела и разбор запроса — разные отказы с разными кодами и разными сообщениями.
assert.equal(PAYME_ERRORS.PARSE, -32700)
assert.notEqual(PAYME_MESSAGES.parse_error.ru, PAYME_MESSAGES.method_not_found.ru,
  'битый JSON — это не «метод не найден»')
assert.notEqual(PAYME_MESSAGES.invalid_request.ru, PAYME_MESSAGES.parse_error.ru)
for (const key of ['parse_error', 'invalid_request', 'timeout']) {
  for (const lang of ['ru', 'uz', 'en']) {
    assert.ok(PAYME_MESSAGES[key][lang], `${key}.${lang} — сообщение видит покупатель`)
  }
}

// --- Payme: транзакция живёт 12 часов ---------------------------------------------------------
// Незавершённая транзакция старше 12 часов подлежит отмене с причиной 4. Без этого она висит в
// состоянии 1 вечно и держит счёт занятым: новый платёж касса создать не даст.

assert.equal(PAYME_CANCEL_TIMEOUT, 4)
const CREATED_AT = '2026-08-13T00:00:00.000Z'
assert.equal(paymeExpired(CREATED_AT, new Date('2026-08-13T11:59:00Z')), false, 'без пяти минут двенадцать — ещё жива')
assert.equal(paymeExpired(CREATED_AT, new Date('2026-08-13T12:00:00Z')), false, 'ровно двенадцать — ещё не «больше»')
assert.equal(paymeExpired(CREATED_AT, new Date('2026-08-13T12:00:01Z')), true)
assert.equal(paymeExpired(CREATED_AT, new Date('2026-08-14T00:00:00Z')), true, 'через сутки — тем более')
// Нечитаемая дата НЕ повод отменять чужой платёж: отмена по ошибке разбора отбирает оплаченное.
assert.equal(paymeExpired('не дата', new Date('2026-08-14T00:00:00Z')), false)
assert.equal(paymeExpired(null), false)
assert.equal(paymeExpired(undefined), false)

// Коды не «примерно такие»: на них завязано поведение кассы.
assert.equal(PAYME_ERRORS.UNAUTHORIZED, -32504)
assert.equal(PAYME_ERRORS.INVALID_AMOUNT, -31001)
assert.equal(PAYME_ERRORS.TRANSACTION_NOT_FOUND, -31003)

const failure = paymeFailure(7, PAYME_ERRORS.INVALID_AMOUNT, { ru: 'Неверная сумма', uz: 'x', en: 'y' })
assert.equal(failure.id, 7, 'ответ несёт id запроса')
assert.equal(failure.error.code, -31001)
assert.equal(failure.error.message.ru, 'Неверная сумма', 'сообщение видит покупатель в кассе')
assert.equal('result' in failure, false, 'ошибка и результат вместе не приходят')

// --- Click: подпись ---------------------------------------------------------------------------
// Порядок полей — часть протокола. Перестановка даёт другой хеш, и проверка начинает пропускать
// либо всё, либо ничего.

const SECRET = 'click-secret'
const prepare = parseClickRequest({
  click_trans_id: '111', service_id: '222', merchant_trans_id: 'INV-1',
  amount: '290000.00', action: '0', sign_time: '2026-08-12 12:00:00', sign_string: 'x',
})
prepare.sign_string = clickSignature(prepare, SECRET)
assert.equal(checkClickSignature(prepare, SECRET), true)

// Ровно тот порядок, что описан у Click, — считаю независимо от модуля.
const expectedPrepare = createHash('md5')
  .update(['111', '222', SECRET, 'INV-1', '290000.00', '0', '2026-08-12 12:00:00'].join(''), 'utf8')
  .digest('hex')
assert.equal(prepare.sign_string, expectedPrepare, 'порядок полей Prepare')

// У Complete в середине добавляется merchant_prepare_id — он связывает завершение с подготовкой.
const complete = parseClickRequest({
  click_trans_id: '111', service_id: '222', merchant_trans_id: 'INV-1', merchant_prepare_id: '55',
  amount: '290000.00', action: '1', sign_time: '2026-08-12 12:05:00', sign_string: 'x',
})
const expectedComplete = createHash('md5')
  .update(['111', '222', SECRET, 'INV-1', '55', '290000.00', '1', '2026-08-12 12:05:00'].join(''), 'utf8')
  .digest('hex')
assert.equal(clickSignature(complete, SECRET), expectedComplete, 'порядок полей Complete')
assert.notEqual(clickSignature(complete, SECRET), clickSignature({ ...complete, action: CLICK_ACTION.PREPARE }, SECRET),
  'подписи фаз обязаны различаться')

// Подделка и ненастроенная касса.
assert.equal(checkClickSignature({ ...prepare, sign_string: 'deadbeef' }, SECRET), false)
assert.equal(checkClickSignature(prepare, 'другой-секрет'), false)
assert.equal(checkClickSignature(prepare, ''), false, 'без секрета не принимаем ничего')
// Регистр хеша не должен решать судьбу платежа.
assert.equal(checkClickSignature({ ...prepare, sign_string: prepare.sign_string.toUpperCase() }, SECRET), true)
// Подменённая сумма ломает подпись — в этом и смысл.
assert.equal(checkClickSignature({ ...prepare, amount: '1.00' }, SECRET), false)

// --- Click: разбор и ответ --------------------------------------------------------------------

assert.equal(parseClickRequest({ click_trans_id: '1', service_id: '2', action: '0' }), null, 'без merchant_trans_id и подписи — не запрос')
assert.equal(parseClickRequest({ ...prepare, action: 'нет' }), null, 'action обязан быть целым')
assert.equal(parseClickRequest(null), null)

const answer = clickResponse({ request: prepare, error: CLICK_ERRORS.SUCCESS, note: 'Success', merchantPrepareId: 55 })
assert.equal(answer.click_trans_id, '111')
assert.equal(answer.merchant_trans_id, 'INV-1')
assert.equal(answer.error, 0)
assert.equal(answer.merchant_prepare_id, 55, 'по нему Click связывает фазы')
assert.ok(answer.error_note, 'без пояснения разбор спора превращается в гадание')
// merchant_prepare_id не выдумывается там, где его нет.
assert.equal('merchant_prepare_id' in clickResponse({ request: prepare, error: -1, note: 'SIGN CHECK FAILED' }), false)

assert.equal(CLICK_ERRORS.SIGN_CHECK_FAILED, -1)
assert.equal(CLICK_ERRORS.INVALID_AMOUNT, -2)
assert.equal(CLICK_ERRORS.TRANSACTION_NOT_FOUND, -6)

// --- Годность счёта — одна на оба протокола ---------------------------------------------------

const invoice = { status: 'pending', amount_tiyin: 29_000_000, entitlement_applied_at: null, expires_at: '2026-08-14T00:00:00Z' }
const NOW = new Date('2026-08-12T12:00:00Z')

assert.deepEqual(checkInvoicePayable(invoice, 29_000_000, NOW), { ok: true })
assert.equal(checkInvoicePayable(invoice, 28_999_999, NOW).reason, 'wrong_amount')
assert.equal(checkInvoicePayable(invoice, null, NOW).reason, 'wrong_amount', 'неразобранная сумма — не «ок»')
assert.equal(checkInvoicePayable(null, 29_000_000, NOW).reason, 'not_found')

// Уже оплаченный счёт — не «не найден» и не «сумма не та». Провайдеру нужно именно это различие,
// чтобы перестать повторять.
assert.equal(checkInvoicePayable({ ...invoice, entitlement_applied_at: '2026-08-12T11:00:00Z' }, 29_000_000, NOW).reason, 'already_paid')
assert.equal(checkInvoicePayable({ ...invoice, status: 'paid' }, 29_000_000, NOW).reason, 'already_paid')
assert.equal(checkInvoicePayable({ ...invoice, status: 'cancelled' }, 29_000_000, NOW).reason, 'closed')
assert.equal(checkInvoicePayable({ ...invoice, expires_at: '2026-08-11T00:00:00Z' }, 29_000_000, NOW).reason, 'expired')

// Проверка суммы идёт ПОСЛЕ проверки состояния: на закрытом счёте сумма уже не важна, а «сумма
// не та» вместо «уже оплачено» заставила бы провайдера ретраить.
assert.equal(checkInvoicePayable({ ...invoice, status: 'paid' }, 1, NOW).reason, 'already_paid')

// --- Ссылки на кассы --------------------------------------------------------------------------

const INV_NO = 100042
const payme = paymeCheckoutUrl({ merchantId: 'M1', invoiceNo: INV_NO, amountTiyin: 29_000_000 })
assert.ok(payme.startsWith('https://checkout.paycom.uz/'))
// Имя поля обязано совпасть с объявленным в кабинете мерчанта, иначе касса пришлёт account без
// известного нам ключа и все платежи упрутся в «счёт не найден».
assert.equal(Buffer.from(payme.split('/').pop(), 'base64').toString(), 'm=M1;ac.invoice_no=100042;a=29000000',
  'Payme принимает тийины и объявленное имя поля')
assert.equal(PAYME_DATA_FIELD.ACCOUNT, 'invoice_no', 'ссылка и отказ называют ОДНО поле')

// Click принимает СУМЫ. Отправить туда тийины значит выставить счёт в сто раз больше, и увидит
// это покупатель только на экране оплаты.
const click = clickCheckoutUrl({ serviceId: 'S1', merchantId: 'M1', invoiceNo: INV_NO, amountTiyin: 29_000_000 })
assert.ok(click.includes('amount=290000.00'), 'сумма в сумах, не в тийинах')
assert.ok(click.includes('transaction_param=100042'), 'номер счёта едет как merchant_trans_id')
// Click работает целыми числами: uuid проходит по формату строки, но сертификацию не проходит.
assert.ok(/transaction_param=\d+$/.test(click), 'номер счёта числовой')

// Ненастроенная касса ссылку не строит: лучше отказ, чем ссылка в никуда.
assert.equal(paymeCheckoutUrl({ merchantId: '', invoiceNo: INV_NO, amountTiyin: 100 }), null)
assert.equal(clickCheckoutUrl({ serviceId: '', merchantId: 'M', invoiceNo: INV_NO, amountTiyin: 100 }), null)
assert.equal(paymeCheckoutUrl({ merchantId: 'M', invoiceNo: INV_NO, amountTiyin: 0 }), null)
// Счёта без номера не бывает, но ссылка на нулевой номер увела бы покупателя платить в никуда.
assert.equal(paymeCheckoutUrl({ merchantId: 'M', invoiceNo: 0, amountTiyin: 100 }), null)
assert.equal(clickCheckoutUrl({ serviceId: 'S', merchantId: 'M', invoiceNo: 0, amountTiyin: 100 }), null)

// Цена в сумах не выдумывается из долларов по курсу, которого никто не утверждал — и не расходится
// с витриной. PLAN_PRICE_UZS — это сумма, которая СПИСЫВАЕТСЯ через Payme/Click; plans.priceUzs —
// то, что человек ВИДИТ на карточке тарифа. Прошлая проверка утверждала лишь `typeof === object`
// и пропустила бы любое расхождение: подняли цену на витрине, забыли в кассе — списывается старая.
assert.equal(typeof PLAN_PRICE_UZS, 'object')

const paidInUzs = Object.entries(PLAN_LIMITS).filter(([, plan]) => plan.priceUzs > 0)
assert.ok(paidInUzs.length >= 4, 'платные тарифы в сумах не потерялись из лестницы')
for (const [key, plan] of paidInUzs) {
  assert.equal(PLAN_PRICE_UZS[key], plan.priceUzs, `касса и витрина расходятся по тарифу ${key}`)
}
// Обратная сторона: ключ в кассе, которого нет в лестнице, — это счёт на тариф, которого не продают.
for (const key of Object.keys(PLAN_PRICE_UZS)) {
  assert.ok(PLAN_LIMITS[key], `в кассе есть тариф ${key}, которого нет в лестнице`)
}

// --- Click сообщает исход платежа полем error ------------------------------------------------
// Отрицательное значение в Complete означает отказ банка или отмену покупателем. Подпись при этом
// верная — запрос настоящий, — и без чтения этого поля месяц начислялся за несостоявшуюся оплату.

const failed = parseClickRequest({ ...prepare, action: '1', error: '-5017', merchant_prepare_id: '55' })
assert.equal(failed.error, '-5017', 'исход платежа доходит до обработчика')
assert.equal(parseClickRequest({ ...prepare, action: '1' }).error, '', 'успех приходит без error или с нулём')


// ─── Stripe: деньги не теряются и не удваиваются ──────────────────────────────────────────────────
//
// Проверки читают ИСХОДНИК вебхука: запустить функцию Deno здесь нечем, а свойства, которые они
// защищают, стоят денег в обе стороны — потерянная оплата и двойное начисление.

{
  const stripe = readFileSync(new URL('../supabase/functions/stripe-webhook/index.ts', import.meta.url), 'utf8')

  // Отметка о событии ставится ДО начисления: add_token_balance складывает, а Stripe повторяет
  // доставку при любом сомнении — без отметки повтор начислил бы второй раз.
  // Ищем МЕСТА ВЫЗОВА, а не упоминания: оба имени встречаются выше по файлу в комментариях,
  // объясняющих порядок, и indexOf по голому имени сравнивал бы позиции пояснений, а не кода.
  const markAt = stripe.indexOf(".from('webhook_events').insert(")
  const creditAt = stripe.indexOf("admin.rpc('add_token_balance'")
  assert.ok(markAt > 0 && creditAt > 0, 'в вебхуке Stripe нет отметки события или начисления')
  assert.ok(markAt < creditAt, 'отметка о событии ставится после начисления — повтор удвоит токены')
  assert.ok(stripe.includes('23505'), 'повтор распознаётся не по нарушению уникальности')

  // Отказ начисления отменяет отметку и просит повтор. Здесь был путь тихой потери оплаты:
  // результат rpc не проверялся, функция отвечала 200, Stripe больше не повторял, а запись в
  // webhook_events превращала ручную переотправку в «дубликат». Человек заплатил, токенов не
  // получил, и в журналах при этом всё зелёное.
  assert.ok(stripe.includes('rollbackEvent'), 'отказ начисления не снимает отметку о событии')
  assert.ok(stripe.includes(".from('webhook_events').delete()"), 'отметка события не удаляется при откате')
  assert.ok(stripe.includes('status: 500'), 'при отказе начисления Stripe не просят повторить')
  assert.ok(creditAt > 0, 'начисление вызывается не через admin.rpc')
  /*
   * ПРОВЕРЯЕТСЯ САМА ЗАЩИТА, А НЕ ОБЪЯВЛЕНИЕ ПЕРЕМЕННОЙ.
   *
   * Первая версия смотрела на `const { error }` рядом с вызовом. Мутация «убрать строку `if (error)
   * return retry(...)`» её пережила: разбор результата остался, а реакции на отказ не стало — то
   * есть проверка стерегла форму, а не свойство.
   */
  assert.ok(/if \(error\) return await retry\('credit'/.test(stripe), 'отказ начисления не приводит к повтору')
  assert.ok(/if \(error\) return await retry\('plan activation'/.test(stripe), 'отказ включения плана не приводит к повтору')

  // Порядок шагов: сначала идемпотентное (план), потом складывающее (токены). Если бы токены шли
  // первыми, отказ на плане откатил бы отметку, Stripe повторил бы запрос — и начислил бы второй
  // раз. Эта ошибка была допущена при первой правке и поймана до коммита.
  const planAt = stripe.indexOf('.update({ plan })')
  assert.ok(planAt > 0, 'включение плана пропало из вебхука')
  assert.ok(planAt < creditAt, 'план включается после начисления токенов — повтор удвоит токены')

  // Подпись и окно давности: без них любой может прислать себе оплату.
  assert.ok(stripe.includes('STRIPE_WEBHOOK_SECRET'), 'подпись Stripe не проверяется')
  /*
   * ОКНО ДАВНОСТИ — ЧИСЛО, А НЕ ИМЯ.
   *
   * Проверка на присутствие TOLERANCE_SECONDS пережила подмену значения на Infinity: имя осталось,
   * защита исчезла. Перехваченный подписанный запрос стало бы можно переигрывать вечно.
   */
  const tolerance = Number((/const TOLERANCE_SECONDS = (\d+)/.exec(stripe) ?? [])[1])
  assert.ok(Number.isFinite(tolerance), 'окно давности подписи перестало быть конечным числом')
  assert.ok(tolerance > 0 && tolerance <= 900, `окно давности ${tolerance} с выходит за разумные пределы`)
  assert.ok(stripe.includes('invalid signature'), 'запрос без подписи не отвергается')

  // Начисление только за собранный платёж: отложенные способы оплаты завершают сессию со статусом
  // «не оплачено», и начислить тогда значит выдать токены за платёж, который может не состояться.
  assert.ok(/paymentStatus !== 'paid'/.test(stripe), 'токены начисляются до подтверждения оплаты')
}

console.log('[OK] Payment protocol behaviour: 112 assertions + Stripe money safety')
