// Протокол кассы Uzum Bank Merchant API v1.0.0. Только разбор, проверка и ответы.
//
// НЕ ПУТАТЬ С _shared/uzum.ts — там Uzum Seller API маркетплейса, совсем другая система с тем же
// именем в названии. Здесь банк и деньги.
//
// Модуль намеренно чист: не читает Deno.env, не ходит в Postgres, не знает о HTTP. Поэтому
// проверяется под Node построчно — включая ветки, которые в бою случаются раз в год: чужой Basic,
// сумма с лишним нулём, повтор уже отменённой транзакции. Ровно так же устроен paymentProtocol.ts.
//
// ЧЕМ UZUM ОТЛИЧАЕТСЯ ОТ PAYME И CLICK, И ПОЧЕМУ ЭТО ВАЖНО ДЛЯ ОТВЕТОВ:
//
//   • Ошибки отдаются HTTP 400, успех — 200. У Payme и Click в этом проекте НАМЕРЕННО всегда 200,
//     потому что они читают тело, а 4xx считают сбоем связи и ретраят. Uzum читает именно код:
//     скопировав сюда привычку отвечать 200 на отказ, мы получили бы «оплата прошла» на каждый
//     отказ. Разница не косметическая, и поэтому она записана здесь.
//   • amount приходит УЖЕ В ТИЙИНАХ. amountToTiyin из paymentProtocol.ts применять нельзя — он
//     умножает на сто, то есть превратил бы 250 000 тийинов в 25 000 000.
//   • errorCode — СТРОКА ("10011"), а не число. Банк сравнивает строки.

import { constantTimeEqual } from './paymentProtocol.ts'

/**
 * Коды протокола. Числа не выдуманы: на них завязано поведение банка и текст, который увидит
 * покупатель. Перечень сверен с двумя независимыми реализациями поверх официальной спецификации.
 */
export const UZUM_ERRORS = {
  /** Basic не сошёлся либо заголовка нет. Единственный ответ на неавторизованный запрос. */
  ACCESS_DENIED: '10001',
  /** Тело не разобралось как JSON-объект. */
  JSON_PARSE: '10002',
  /** Метод не POST либо ручка неизвестна. */
  INVALID_OPERATION: '10003',
  /** Не хватает обязательного поля. */
  REQUIRED_FIELD_MISSING: '10005',
  /** Чужой serviceId: перепутанная настройка, а не оплата нашего счёта. */
  INVALID_SERVICE_ID: '10006',
  /** Счёта с таким order_id нет. */
  ACCOUNT_NOT_FOUND: '10007',
  /** По счёту уже заплачено либо по нему есть живая транзакция. */
  ALREADY_PAID: '10008',
  /** Счёт отменён или просрочен. */
  CANCELLED: '10009',
  /** Транзакция с таким transId уже создана. */
  ALREADY_CREATED: '10010',
  /**
   * Сумма не та.
   *
   * ЭТОГО КОДА НЕ БЫЛО В ЗАДАНИИ, и его отсутствие — самая дорогая из возможных недоделок:
   * /confirm суммы не знает, он лишь доводит до конца созданное. Без сверки на /create покупка
   * полного тарифа стоит один тийин.
   */
  INVALID_AMOUNT: '10011',
  /** Транзакции с таким transId нет. */
  TRANSACTION_NOT_FOUND: '10014',
  /** Транзакция отменена — подтвердить её нельзя. */
  TRANSACTION_CANCELLED: '10015',
  /** Уже подтверждена. Не ошибка сама по себе: так банк узнаёт, что повторять не нужно. */
  ALREADY_CONFIRMED: '10016',
  /** Отменить в текущем состоянии нельзя. */
  UNABLE_TO_CANCEL: '10017',
  /** Уже отменена. */
  ALREADY_CANCELLED: '10018',
  /** Наша поломка, а не его. Всё, что мы не смогли объяснить кодом протокола. */
  INTERNAL: '99999',
} as const

export type UzumErrorCode = typeof UZUM_ERRORS[keyof typeof UZUM_ERRORS]

/** Пять ручек протокола. Шестой нет: неизвестный путь — это 10003, а не догадка. */
export const UZUM_ACTIONS = ['check', 'create', 'confirm', 'reverse', 'status'] as const
export type UzumAction = typeof UZUM_ACTIONS[number]

/** Разобрать имя ручки из пути. Возвращает null для всего постороннего. */
export function uzumActionFrom(pathname: unknown): UzumAction | null {
  const parts = String(pathname ?? '').split('/').filter(Boolean)
  const last = (parts[parts.length - 1] ?? '').toLowerCase()
  return (UZUM_ACTIONS as readonly string[]).includes(last) ? last as UzumAction : null
}

/**
 * Проверка HTTP Basic.
 *
 * Оба значения обязаны быть настроены: пустой ожидаемый пароль означает ненастроенную кассу, и
 * пропускать при нём кого угодно — худший из возможных вариантов. Сравнение постоянным временем и
 * ОБА всегда: ранний выход по логину рассказал бы, какой логин верен.
 */
export function checkUzumAuth(header: unknown, expectedUser: string, expectedPass: string): boolean {
  if (!expectedUser || !expectedPass) return false
  const value = String(header ?? '')
  if (!value.toLowerCase().startsWith('basic ')) return false

  /*
   * atob ОТДАЁТ БАЙТЫ, А НЕ ТЕКСТ.
   *
   * Он возвращает строку, где каждый символ — один байт (Latin-1). Пароль из одних латинских букв
   * при этом совпадёт сам с собой, и проверка выглядит рабочей. А пароль с кириллицей, умляутом
   * или тире-длинным превратится в набор мусорных символов и НЕ совпадёт никогда — касса будет
   * отвечать 10001 на верный пароль, и искать причину станут где угодно, только не здесь.
   */
  let decoded = ''
  try {
    const bytes = Uint8Array.from(atob(value.slice(6).trim()), (char) => char.charCodeAt(0))
    decoded = new TextDecoder().decode(bytes)
  } catch { return false }

  const separator = decoded.indexOf(':')
  if (separator < 0) return false
  const userOk = constantTimeEqual(decoded.slice(0, separator), expectedUser)
  const passOk = constantTimeEqual(decoded.slice(separator + 1), expectedPass)
  return userOk && passOk
}

/**
 * Сумма в тийинах.
 *
 * СТРОГОЕ ЦЕЛОЕ, без пересчёта. Банк присылает тийины; «250000.00», «2.5e5» и число с дробной
 * частью — это не то, что прислал бы честный протокол, а способ проскочить сверку. Дробное
 * значение особенно опасно: Number('1e999') даёт Infinity, а Math.round от него — не число.
 */
export function uzumAmount(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  }
  const text = String(raw ?? '').trim()
  if (!/^\d{1,15}$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** serviceId: целое положительное. Сравнивается с настройкой как число, а не как строка. */
export function uzumServiceId(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  const text = String(raw ?? '').trim()
  if (!/^\d{1,18}$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Отметка времени банка: epoch в миллисекундах. Мусор превращается в null, а не в 1970 год. */
export function uzumTime(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  const text = String(raw ?? '').trim()
  if (!/^\d{1,15}$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export interface UzumRequest {
  serviceId: number | null
  transId: string
  orderId: string
  amount: number | null
  transTime: number | null
  confirmTime: number | null
  reverseTime: number | null
  paymentSource: string | null
  phone: string | null
  raw: Record<string, unknown>
}

/** Короткая строка из чужого поля: длиннее предела — обрезается, не отвергается. */
const shortText = (raw: unknown, limit: number): string | null => {
  const text = String(raw ?? '').trim()
  return text ? text.slice(0, limit) : null
}

/**
 * Разбор тела.
 *
 * Возвращает null, только если это ВООБЩЕ не объект: остальное разбирается как есть, а чего не
 * хватает — решает вызывающий по ручке. У /check нет transId, у /status нет суммы; требовать
 * здесь полный набор значило бы отвечать 10005 на законные запросы.
 */
export function parseUzumRequest(body: unknown): UzumRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const row = body as Record<string, unknown>
  const params = row.params && typeof row.params === 'object' && !Array.isArray(row.params)
    ? row.params as Record<string, unknown>
    : {}
  return {
    serviceId: uzumServiceId(row.serviceId),
    transId: String(row.transId ?? '').trim().slice(0, 120),
    // order_id живёт в params — так его кладёт банк. Верхний уровень принимается тоже: тестовые
    // пульты присылают и так, и так, и отказ на этом стоил бы дня переписки вместо строки кода.
    orderId: String(params.order_id ?? row.order_id ?? '').trim().slice(0, 120),
    amount: uzumAmount(row.amount),
    transTime: uzumTime(row.transTime),
    confirmTime: uzumTime(row.confirmTime),
    reverseTime: uzumTime(row.reverseTime),
    paymentSource: shortText(row.paymentSource ?? params.paymentSource, 60),
    phone: shortText(row.phone ?? params.phone, 32),
    raw: row,
  }
}

/**
 * Тело запроса для журнала — БЕЗ заголовков и без всего, что похоже на секрет.
 *
 * raw_payload читают при разборе спора, и попасть туда Authorization не должен ни при каких
 * обстоятельствах: журнал переживает ротацию паролей, а строка в нём — нет.
 */
export function safePayload(request: UzumRequest): Record<string, unknown> {
  const { raw } = request
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (/auth|password|secret|token/i.test(key)) continue
    copy[key] = value
  }
  return copy
}

/** Успешный ответ. Поля, которых у ручки нет, не попадают в тело вовсе. */
export function uzumSuccess(fields: {
  serviceId: number | null
  transId?: string
  status?: string
  timestamp?: number
  transTime?: number | null
  confirmTime?: number | null
  reverseTime?: number | null
  amount?: number | null
  data?: Record<string, unknown>
}): Record<string, unknown> {
  const body: Record<string, unknown> = { serviceId: fields.serviceId }
  if (fields.transId) body.transId = fields.transId
  if (fields.status) body.status = fields.status
  if (fields.timestamp != null) body.timestamp = fields.timestamp
  if (fields.transTime != null) body.transTime = fields.transTime
  if (fields.confirmTime != null) body.confirmTime = fields.confirmTime
  if (fields.reverseTime != null) body.reverseTime = fields.reverseTime
  if (fields.amount != null) body.amount = fields.amount
  if (fields.data) body.data = fields.data
  return body
}

/**
 * Ответ-отказ.
 *
 * status всегда "FAILED", errorCode всегда строка. serviceId и transId возвращаются, если были:
 * банк сопоставляет ответ с запросом по ним, и отказ без них он не свяжет ни с чем.
 */
export function uzumFailure(errorCode: UzumErrorCode, fields: {
  serviceId?: number | null
  transId?: string
  timestamp?: number
} = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { status: 'FAILED', errorCode }
  if (fields.serviceId != null) body.serviceId = fields.serviceId
  if (fields.transId) body.transId = fields.transId
  if (fields.timestamp != null) body.timestamp = fields.timestamp
  return body
}
