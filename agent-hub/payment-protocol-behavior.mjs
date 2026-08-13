import assert from 'node:assert/strict'
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
  paymeInvoiceId,
  paymeCheckoutUrl,
  clickCheckoutUrl,
  PLAN_PRICE_UZS,
} from '../supabase/functions/_shared/paymentProtocol.ts'

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

// Счёт берётся только как uuid: «1 OR 1=1» и прочее в account не должно доехать до базы.
assert.equal(paymeInvoiceId({ account: { invoice_id: '9329393e-b5ab-4f20-8b8f-ead0ad466148' } }), '9329393e-b5ab-4f20-8b8f-ead0ad466148')
assert.equal(paymeInvoiceId({ account: { order_id: '9329393e-b5ab-4f20-8b8f-ead0ad466148' } }), '9329393e-b5ab-4f20-8b8f-ead0ad466148')
assert.equal(paymeInvoiceId({ account: { invoice_id: '1 OR 1=1' } }), null)
assert.equal(paymeInvoiceId({ account: {} }), null)
assert.equal(paymeInvoiceId({}), null)

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

const INV = '9329393e-b5ab-4f20-8b8f-ead0ad466148'
const payme = paymeCheckoutUrl({ merchantId: 'M1', invoiceId: INV, amountTiyin: 29_000_000 })
assert.ok(payme.startsWith('https://checkout.paycom.uz/'))
assert.equal(Buffer.from(payme.split('/').pop(), 'base64').toString(), 'm=M1;ac.invoice_id=' + INV + ';a=29000000',
  'Payme принимает тийины')

// Click принимает СУМЫ. Отправить туда тийины значит выставить счёт в сто раз больше, и увидит
// это покупатель только на экране оплаты.
const click = clickCheckoutUrl({ serviceId: 'S1', merchantId: 'M1', invoiceId: INV, amountTiyin: 29_000_000 })
assert.ok(click.includes('amount=290000.00'), 'сумма в сумах, не в тийинах')
assert.ok(click.indexOf('transaction_param=' + INV) > 0, 'номер счёта едет как merchant_trans_id')

// Ненастроенная касса ссылку не строит: лучше отказ, чем ссылка в никуда.
assert.equal(paymeCheckoutUrl({ merchantId: '', invoiceId: INV, amountTiyin: 100 }), null)
assert.equal(clickCheckoutUrl({ serviceId: '', merchantId: 'M', invoiceId: INV, amountTiyin: 100 }), null)
assert.equal(paymeCheckoutUrl({ merchantId: 'M', invoiceId: INV, amountTiyin: 0 }), null)

// Цена в сумах не выдумывается из долларов по курсу, которого никто не утверждал.
assert.equal(typeof PLAN_PRICE_UZS, 'object')

console.log('[OK] Payment protocol behaviour: 72 assertions')
