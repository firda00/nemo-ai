// Протоколы Payme и Click. Только разбор, проверка и ответы — ни базы, ни сети, ни секретов.
//
// Здесь живёт весь риск платёжного контура, поэтому здесь же живут тесты. Модуль намеренно чист:
// он не читает Deno.env и не ходит в Postgres, а значит проверяется под Node построчно, включая
// те ветки, которые в бою случаются раз в год — чужая подпись, сумма с лишней копейкой, повтор
// уже выполненной транзакции.
//
// ОТВЕТЫ ПРОТОКОЛЬНЫЕ, А НЕ HTTP. И Payme, и Click читают тело, а не код ответа: общий 400 или
// 500 они считают сбоем связи и ретраят, а владелец видит «оплата не прошла» там, где на самом
// деле мы отказали по делу. Каждый отказ обязан назвать номер, который провайдер понимает.

import { createHash } from 'node:crypto'

/* ─────────────────────────────  Общее  ───────────────────────────── */

/**
 * Сравнение без утечки времени.
 *
 * Обычное === выходит на первом несовпавшем байте, и по времени ответа подпись подбирается
 * побайтово. Здесь сравниваются все байты всегда. Разная длина тоже не должна отвечать быстрее,
 * поэтому сначала складываются длины, а цикл идёт по большей из них.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(String(a ?? ''))
  const right = new TextEncoder().encode(String(b ?? ''))
  let diff = left.length ^ right.length
  const max = Math.max(left.length, right.length)
  for (let i = 0; i < max; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return diff === 0
}

/**
 * Сумма в тийинах из десятичной строки сумов.
 *
 * Click присылает сумму как «290000.00». Умножать её на 100 через Number значит однажды получить
 * 28999999.999999996 и отвергнуть верный платёж — или, что хуже, принять неверный. Разбор идёт по
 * строке: целая часть и не больше двух знаков после точки.
 *
 * Экспоненциальная запись, лишние знаки, пробелы внутри числа и минус отвергаются. «2.9e5» — это
 * не сумма, которую прислал бы честный провайдер, а способ проскочить проверку.
 */
export function amountToTiyin(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null
    // Число уже потеряло точность, если у него больше двух знаков: доверяем только целым суммам.
    const tiyin = Math.round(raw * 100)
    return Math.abs(raw * 100 - tiyin) < 1e-6 ? tiyin : null
  }
  const text = String(raw ?? '').trim()
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  const tiyin = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(tiyin) && tiyin > 0 ? tiyin : null
}

/* ─────────────────────────────  Payme  ───────────────────────────── */

/**
 * Коды Payme. Числа не выдуманы и не «примерно такие» — на них завязано поведение кассы.
 *
 * -32504 — недостаточно прав: единственный ответ на плохую авторизацию. HTTP 401 Payme прочтёт
 *          как сбой и будет ретраить.
 * -31001 — неверная сумма. Не «ошибка», а именно сумма: касса покажет это покупателю.
 * -31003 — транзакции нет. Ответ на Perform или Cancel до Create; создавать её задним числом
 *          нельзя, иначе платёж появится из ниоткуда.
 * -31008 — операция сейчас невозможна: состояние не позволяет перехода.
 * -31050 — начало диапазона мерчанта. Здесь: счёт не найден или уже закрыт.
 */
export const PAYME_ERRORS = {
  UNAUTHORIZED: -32504,
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  CANNOT_PERFORM: -31008,
  INVOICE_NOT_FOUND: -31050,
} as const

/** Состояния транзакции у Payme. Отрицательные — отменённые, и они терминальны. */
export const PAYME_STATE = { CREATED: 1, PERFORMED: 2, CANCELLED: -1, CANCELLED_AFTER_PERFORM: -2 } as const

export type PaymeRequest = { id: unknown; method: string; params: Record<string, unknown> }

/** Разбор тела JSON-RPC. Null — если это не запрос Payme, а что-то другое. */
export function parsePaymeRequest(body: unknown): PaymeRequest | null {
  if (!body || typeof body !== 'object') return null
  const row = body as Record<string, unknown>
  if (typeof row.method !== 'string' || !row.method) return null
  const params = row.params && typeof row.params === 'object' && !Array.isArray(row.params)
    ? row.params as Record<string, unknown>
    : {}
  // id возвращается КАК ПРИШЁЛ, включая null: касса сопоставляет ответ с запросом по нему.
  return { id: row.id ?? null, method: row.method, params }
}

/**
 * Проверка HTTP Basic.
 *
 * Payme шлёт логин (обычно Paycom) и ключ мерчанта. Оба сравниваются постоянным временем, и оба
 * обязаны быть настроены: пустой ожидаемый ключ означает ненастроенную кассу, и пропускать при
 * нём кого угодно — худший из возможных вариантов.
 */
export function checkPaymeAuth(header: unknown, expectedLogin: string, expectedKey: string): boolean {
  if (!expectedKey || !expectedLogin) return false
  const value = String(header ?? '')
  if (!value.toLowerCase().startsWith('basic ')) return false
  let decoded = ''
  try { decoded = atob(value.slice(6).trim()) } catch { return false }
  const separator = decoded.indexOf(':')
  if (separator < 0) return false
  const login = decoded.slice(0, separator)
  const key = decoded.slice(separator + 1)
  // Обе проверки выполняются всегда: ранний выход по логину рассказал бы, какой логин верен.
  const loginOk = constantTimeEqual(login, expectedLogin)
  const keyOk = constantTimeEqual(key, expectedKey)
  return loginOk && keyOk
}

export const paymeResult = (id: unknown, result: Record<string, unknown>) => ({ jsonrpc: '2.0', id, result })

/**
 * Отказ Payme. Сообщение на трёх языках, потому что касса показывает его покупателю, а покупатель
 * в Узбекистане читает по-русски, по-узбекски или по-английски.
 *
 * data НАЗЫВАЕТ ПОЛЕ, из-за которого отказ. Для ошибок про счёт (-31050 и далее) и про сумму это
 * требование протокола, а не украшение: касса подсвечивает покупателю именно то поле, которое он
 * может исправить. Без data он видит «ошибка» и не знает, ошибся ли он номером счёта или суммой.
 */
export function paymeFailure(
  id: unknown,
  code: number,
  message: { ru: string; uz: string; en: string },
  data?: string,
) {
  const error: Record<string, unknown> = { code, message }
  if (data) error.data = data
  return { jsonrpc: '2.0', id, error }
}

export const PAYME_MESSAGES: Record<string, { ru: string; uz: string; en: string }> = {
  unauthorized: { ru: 'Недостаточно прав', uz: 'Huquqlar yetarli emas', en: 'Insufficient privileges' },
  invalid_amount: { ru: 'Неверная сумма', uz: 'Noto‘g‘ri summa', en: 'Invalid amount' },
  invoice_not_found: { ru: 'Счёт не найден', uz: 'Hisob topilmadi', en: 'Invoice not found' },
  invoice_closed: { ru: 'Счёт уже оплачен или отменён', uz: 'Hisob allaqachon to‘langan yoki bekor qilingan', en: 'Invoice is already paid or cancelled' },
  transaction_not_found: { ru: 'Транзакция не найдена', uz: 'Tranzaksiya topilmadi', en: 'Transaction not found' },
  cannot_perform: { ru: 'Операция сейчас невозможна', uz: 'Amalni bajarib bo‘lmaydi', en: 'Operation is not allowed' },
  method_not_found: { ru: 'Метод не найден', uz: 'Metod topilmadi', en: 'Method not found' },
  // Разбор тела и разбор запроса — РАЗНЫЕ отказы, и у Payme у них разные коды. Отвечать на битый
  // JSON «метод не найден» значит послать инженера кассы искать опечатку в названии метода,
  // которого в запросе вообще не было.
  parse_error: { ru: 'Не удалось разобрать запрос', uz: 'So‘rovni o‘qib bo‘lmadi', en: 'Could not parse the request' },
  invalid_request: { ru: 'Неверный формат запроса', uz: 'So‘rov formati noto‘g‘ri', en: 'Invalid request' },
  timeout: { ru: 'Время ожидания оплаты истекло', uz: 'To‘lov kutish vaqti tugadi', en: 'Payment timed out' },
}

/** Поле, на которое ссылается error.data. Имена — те же, что объявлены в кабинете мерчанта. */
export const PAYME_DATA_FIELD = { ACCOUNT: 'invoice_no', AMOUNT: 'amount' } as const

/**
 * Транзакция Payme живёт 12 часов.
 *
 * Требование протокола: незавершённая транзакция старше 12 часов подлежит отмене с причиной 4, а
 * попытка её выполнить — отказу. Без этого созданная и брошенная транзакция висит в состоянии 1
 * вечно и блокирует счёт: новый платёж по нему касса создать не даст, а старый уже никто не
 * завершит.
 */
export const PAYME_TIMEOUT_MS = 12 * 60 * 60 * 1000
export const PAYME_CANCEL_TIMEOUT = 4

export function paymeExpired(createdAt: unknown, now: Date = new Date()): boolean {
  const started = Date.parse(String(createdAt ?? ''))
  if (!Number.isFinite(started)) return false // Непрочитанная дата — не повод отменять чужой платёж.
  return now.getTime() - started > PAYME_TIMEOUT_MS
}

/**
 * Ссылка на счёт из params.account.
 *
 * Касса присылает то, что мерчант объявил в кабинете. Мы объявляем номер — короткое число, которое
 * покупатель видит на счёте и может продиктовать. Uuid принимается тоже: он остаётся первичным
 * ключом, и ссылки, выданные до перехода на номера, обязаны продолжать работать.
 */
export type InvoiceRef = { by: 'no'; value: number } | { by: 'id'; value: string }

export function invoiceRefFrom(raw: unknown): InvoiceRef | null {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  if (/^\d{1,18}$/.test(text)) {
    const value = Number(text)
    return Number.isSafeInteger(value) && value > 0 ? { by: 'no', value } : null
  }
  return /^[0-9a-f-]{36}$/i.test(text) ? { by: 'id', value: text } : null
}

export function paymeInvoiceRef(params: Record<string, unknown>): InvoiceRef | null {
  const account = params?.account
  if (!account || typeof account !== 'object') return null
  const row = account as Record<string, unknown>
  return invoiceRefFrom(row.invoice_no ?? row.invoice_id ?? row.order_id)
}

/** Одинаковы ли две ссылки на счёт. Повтор Create обязан прийти на ТОТ ЖЕ счёт. */
export function sameInvoiceRef(ref: InvoiceRef | null, invoice: { id: string; invoice_no: number | string } | null) {
  if (!ref || !invoice) return false
  return ref.by === 'no' ? String(ref.value) === String(invoice.invoice_no) : ref.value === invoice.id
}

/* ─────────────────────────────  Click  ───────────────────────────── */

/**
 * Коды Click. Ноль — успех; всё остальное отрицательное и означает конкретную причину.
 *
 * -1 — подпись не сошлась. Единственный ответ на подделку.
 * -2 — сумма не та.
 * -4 — уже оплачено. Не ошибка сама по себе: так Click узнаёт, что повторять не нужно.
 * -6 — нет подготовленной транзакции: Complete пришёл без своего Prepare.
 * -9 — транзакция отменена.
 */
export const CLICK_ERRORS = {
  SUCCESS: 0,
  SIGN_CHECK_FAILED: -1,
  INVALID_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  USER_NOT_FOUND: -5,
  TRANSACTION_NOT_FOUND: -6,
  BAD_REQUEST: -8,
  TRANSACTION_CANCELLED: -9,
} as const

export const CLICK_ACTION = { PREPARE: 0, COMPLETE: 1 } as const

export type ClickRequest = {
  click_trans_id: string
  service_id: string
  merchant_trans_id: string
  merchant_prepare_id: string | null
  amount: string
  action: number
  sign_time: string
  sign_string: string
  error?: string
}

/** Разбор формы Click. Null — если обязательных полей нет; выдумывать их нельзя. */
export function parseClickRequest(body: Record<string, unknown> | null | undefined): ClickRequest | null {
  if (!body || typeof body !== 'object') return null
  const text = (key: string) => {
    const value = (body as Record<string, unknown>)[key]
    return value == null ? '' : String(value)
  }
  const action = Number(text('action'))
  if (!Number.isInteger(action)) return null
  const request: ClickRequest = {
    click_trans_id: text('click_trans_id'),
    service_id: text('service_id'),
    merchant_trans_id: text('merchant_trans_id'),
    merchant_prepare_id: text('merchant_prepare_id') || null,
    amount: text('amount'),
    action,
    sign_time: text('sign_time'),
    sign_string: text('sign_string'),
    // Click сообщает исход платежа ЗДЕСЬ. Отрицательное значение в Complete означает, что
    // деньги НЕ списаны, и начислять по такому запросу месяц значит раздавать подписку даром.
    error: text('error'),
  }
  if (!request.click_trans_id || !request.service_id || !request.merchant_trans_id || !request.sign_string) return null
  return request
}

/**
 * Подпись Click.
 *
 * Порядок полей — часть протокола, а не деталь реализации: перестановка даёт другой хеш, и
 * проверка начинает пропускать всё подряд либо не пропускать ничего. У Complete в середине
 * добавляется merchant_prepare_id — именно он связывает завершение с его подготовкой, и без
 * этого второй Complete мог бы закрыться по чужому Prepare.
 */
export function clickSignature(request: ClickRequest, secret: string): string {
  const parts = request.action === CLICK_ACTION.COMPLETE
    ? [request.click_trans_id, request.service_id, secret, request.merchant_trans_id,
       request.merchant_prepare_id ?? '', request.amount, String(request.action), request.sign_time]
    : [request.click_trans_id, request.service_id, secret, request.merchant_trans_id,
       request.amount, String(request.action), request.sign_time]
  return createHash('md5').update(parts.join(''), 'utf8').digest('hex')
}

/** Сошлась ли подпись. Пустой секрет — всегда нет: ненастроенная касса не должна принимать оплату. */
export function checkClickSignature(request: ClickRequest, secret: string): boolean {
  if (!secret) return false
  return constantTimeEqual(clickSignature(request, secret).toLowerCase(), String(request.sign_string ?? '').toLowerCase())
}

/**
 * Ответ Click.
 *
 * error_note обязателен: Click пишет его в свой журнал, и «-2» без пояснения превращает разбор
 * спора в гадание. merchant_prepare_id возвращается на Prepare и на Complete — по нему Click
 * связывает фазы.
 */
export function clickResponse(input: {
  request: ClickRequest
  error: number
  note: string
  merchantPrepareId?: string | number | null
  merchantConfirmId?: string | number | null
}) {
  const body: Record<string, unknown> = {
    click_trans_id: input.request.click_trans_id,
    merchant_trans_id: input.request.merchant_trans_id,
    error: input.error,
    error_note: input.note,
  }
  if (input.merchantPrepareId != null) body.merchant_prepare_id = input.merchantPrepareId
  if (input.merchantConfirmId != null) body.merchant_confirm_id = input.merchantConfirmId
  return body
}

export const CLICK_NOTES: Record<number, string> = {
  [CLICK_ERRORS.SUCCESS]: 'Success',
  [CLICK_ERRORS.SIGN_CHECK_FAILED]: 'SIGN CHECK FAILED',
  [CLICK_ERRORS.INVALID_AMOUNT]: 'Incorrect parameter amount',
  [CLICK_ERRORS.ACTION_NOT_FOUND]: 'Action not found',
  [CLICK_ERRORS.ALREADY_PAID]: 'Already paid',
  [CLICK_ERRORS.USER_NOT_FOUND]: 'User does not exist',
  [CLICK_ERRORS.TRANSACTION_NOT_FOUND]: 'Transaction does not exist',
  [CLICK_ERRORS.BAD_REQUEST]: 'Error in request from click',
  [CLICK_ERRORS.TRANSACTION_CANCELLED]: 'Transaction cancelled',
}

/* ─────────────────────────  Общее решение  ───────────────────────── */

/**
 * Годится ли счёт к оплате — одинаково для обоих провайдеров.
 *
 * Сумма сверяется со СНИМКОМ на счёте, а не с текущим прайсом и не с тем, что прислал провайдер:
 * покупатель платил по цене, которую видел. Возвращается причина, а не «нет»: вызывающий
 * переводит её в код своего протокола.
 */
export type InvoiceCheck =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'wrong_amount' | 'already_paid' | 'closed' | 'expired' }

export function checkInvoicePayable(invoice: {
  status: string
  amount_tiyin: number
  entitlement_applied_at: string | null
  expires_at: string | null
} | null, amountTiyin: number | null, now = new Date()): InvoiceCheck {
  if (!invoice) return { ok: false, reason: 'not_found' }
  // Уже оплаченный счёт — не ошибка суммы и не «не найден». Провайдеру нужно ровно это различие,
  // чтобы перестать повторять.
  if (invoice.entitlement_applied_at || invoice.status === 'paid') return { ok: false, reason: 'already_paid' }
  if (invoice.status === 'cancelled' || invoice.status === 'expired') return { ok: false, reason: 'closed' }
  if (invoice.expires_at && new Date(invoice.expires_at) <= now) return { ok: false, reason: 'expired' }
  if (amountTiyin == null || amountTiyin !== Number(invoice.amount_tiyin)) return { ok: false, reason: 'wrong_amount' }
  return { ok: true }
}

/* ─────────────────────────  Ссылки на оплату  ───────────────────────── */

/**
 * Цена тарифа В СУМАХ — то, что реально списывается через Payme и Click.
 *
 * Курс доллара я не выдумываю: цена в долларах из PLAN_LIMITS — ориентир для другого рынка, а
 * счёт выставляется в сумах и сверяется с точностью до тийина. Пересчёт по придуманному курсу
 * означал бы, что покупатель платит цифру, которую никто не утверждал.
 *
 * Значения обязаны совпадать с полем priceUzs в PLAN_LIMITS (_shared/plans.ts). Держать одно
 * число в двух файлах плохо, но альтернатива — импорт plans.ts в платёжный протокол, а он
 * сознательно не зависит ни от чего, кроме себя. Расхождение ловит контрактный тест.
 *
 * Отсутствие ключа = тариф не продаётся самообслуживанием: касса отказывает с внятной
 * причиной (plan_not_for_sale), а не берёт «примерно столько». Так исключены free, beta и
 * enterprise — последний продаётся по договору.
 */
export const PLAN_PRICE_UZS: Record<string, number> = {
  starter: 690_000,
  pro: 1_690_000,
  business: 2_990_000,
  agency: 4_120_000,
}

export const PLAN_DURATION_DAYS = 30

/**
 * Ссылка на кассу Payme. Параметры кодируются base64 — так устроен их чекаут.
 *
 * Имя поля счёта — ровно то, что объявлено в кабинете мерчанта (invoice_no). Расхождение здесь
 * означает, что касса пришлёт account без известного нам ключа и все платежи упрутся в «счёт не
 * найден».
 */
export function paymeCheckoutUrl(input: { merchantId: string; invoiceNo: number; amountTiyin: number }): string | null {
  if (!input.merchantId || !(input.invoiceNo > 0) || !(input.amountTiyin > 0)) return null
  const params = `m=${input.merchantId};ac.${PAYME_DATA_FIELD.ACCOUNT}=${input.invoiceNo};a=${input.amountTiyin}`
  return `https://checkout.paycom.uz/${btoa(params)}`
}

/**
 * Ссылка на кассу Click.
 *
 * Сумма здесь В СУМАХ, а не в тийинах: Click принимает десятичное число, и отправить туда 29000000
 * значит выставить покупателю счёт в тысячу раз больше. Ошибка тихая — форма откроется, и он
 * увидит её только на экране оплаты.
 */
export function clickCheckoutUrl(input: {
  serviceId: string; merchantId: string; invoiceNo: number; amountTiyin: number
}): string | null {
  if (!input.serviceId || !input.merchantId || !(input.invoiceNo > 0) || !(input.amountTiyin > 0)) return null
  const sums = (input.amountTiyin / 100).toFixed(2)
  return 'https://my.click.uz/services/pay'
    + `?service_id=${encodeURIComponent(input.serviceId)}`
    + `&merchant_id=${encodeURIComponent(input.merchantId)}`
    + `&amount=${sums}`
    + `&transaction_param=${input.invoiceNo}`
}
