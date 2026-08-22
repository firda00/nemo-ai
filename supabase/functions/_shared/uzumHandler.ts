// Маршрутизация кассы Uzum: запрос → ответ. БЕЗ Deno, БЕЗ сети, БЕЗ клиента Supabase.
//
// ПОЧЕМУ ОТДЕЛЬНО ОТ index.ts. В index.ts живут Deno.serve, Deno.env и createClient — всё, что
// нельзя выполнить под Node. Оставив маршрутизацию там, мы смогли бы проверять её только глазами
// или регулярками по исходнику, а регулярка не поймает ни перепутанный код ошибки, ни то, что
// /confirm отвечает суммой из запроса вместо суммы из базы.
//
// Здесь же всё, что решает исход запроса, — и всё это проверяется вызовом: пять ручек, чужой
// Basic, чужой serviceId, повторы и гонки. База и часы приходят зависимостями.

import {
  UZUM_ERRORS, checkUzumAuth, parseUzumRequest, safePayload,
  uzumActionFrom, uzumFailure, uzumSuccess,
  type UzumErrorCode, type UzumRequest,
} from './uzumBank.ts'

/** Ответ SQL-функции uzum_*. ok=false обязан нести error_code протокола. */
export type UzumRpcResult = {
  ok?: boolean
  error_code?: string
  amount?: number | string
  order_id?: string
  [key: string]: unknown
}

export interface UzumTransactionRow {
  trans_id: string
  order_id: string
  status: string
  amount: number
  trans_time: number | null
  confirm_time: number | null
  reverse_time: number | null
}

export interface UzumConfig {
  basicUser: string
  basicPass: string
  /** null — касса не настроена. Тогда она отказывает всем: «любой подойдёт» здесь недопустимо. */
  serviceId: number | null
  payerLabel: string
}

export interface UzumDeps {
  config: UzumConfig
  rpc: (fn: string, args: Record<string, unknown>) => Promise<UzumRpcResult>
  findTransaction: (transId: string) => Promise<UzumTransactionRow | null>
  /** Часы зависимостью: иначе поведение с временем проверяется ожиданием, а не таблицей случаев. */
  now: () => number
  onError?: (action: string, error: unknown) => void
}

export interface UzumHttpRequest {
  method: string
  pathname: string
  authorization: string | null
  /** Уже разобранный JSON либо undefined, если тело не разобралось. */
  body?: unknown
  bodyParseFailed?: boolean
}

export interface UzumHttpResponse {
  status: number
  body: Record<string, unknown>
}

export async function handleUzum(req: UzumHttpRequest, deps: UzumDeps): Promise<UzumHttpResponse> {
  const at = deps.now()
  /** Отказ. ВСЕГДА 400: Uzum читает код HTTP, а не только тело. */
  const fail = (code: UzumErrorCode, fields: { serviceId?: number | null; transId?: string } = {}): UzumHttpResponse =>
    ({ status: 400, body: uzumFailure(code, { ...fields, timestamp: at }) })
  const ok = (body: Record<string, unknown>): UzumHttpResponse => ({ status: 200, body })

  // Метод — до всего: GET на кассу это неверная операция, а не отказ авторизации.
  if (String(req.method).toUpperCase() !== 'POST') return fail(UZUM_ERRORS.INVALID_OPERATION)

  const action = uzumActionFrom(req.pathname)
  if (!action) return fail(UZUM_ERRORS.INVALID_OPERATION)

  /*
   * BASIC — ПЕРВОЙ ПРОВЕРКОЙ И ДО РАЗБОРА ТЕЛА.
   *
   * Неавторизованный запрос не должен уметь узнать даже то, разобралось ли наше тело. Порядок
   * «сначала тело, потом пароль» превращает кассу в справочник действующих номеров счетов для
   * любого, кто умеет слать POST: 10002 против 10007 — это уже ответ.
   */
  if (!checkUzumAuth(req.authorization, deps.config.basicUser, deps.config.basicPass)) {
    return fail(UZUM_ERRORS.ACCESS_DENIED)
  }

  if (req.bodyParseFailed) return fail(UZUM_ERRORS.JSON_PARSE)
  const request: UzumRequest | null = parseUzumRequest(req.body)
  if (!request) return fail(UZUM_ERRORS.JSON_PARSE)

  const echo = { serviceId: request.serviceId, transId: request.transId }

  // Ненастроенная касса отказывает всем. Пустой ожидаемый serviceId и «подойдёт любой» — одно и то
  // же только на бумаге; в бою второе означает приём чужих платежей на наш счёт.
  if (!deps.config.serviceId) return fail(UZUM_ERRORS.INVALID_SERVICE_ID, echo)
  if (request.serviceId !== deps.config.serviceId) return fail(UZUM_ERRORS.INVALID_SERVICE_ID, echo)

  /** Блок data.account — форма, в которой банк ждёт реквизит платежа. */
  const accountData = (orderId: string, withFio = false) => ({
    account: { value: orderId },
    ...(withFio ? { fio: { value: deps.config.payerLabel } } : {}),
  })

  try {
    if (action === 'check') {
      if (!request.orderId) return fail(UZUM_ERRORS.REQUIRED_FIELD_MISSING, echo)
      const result = await deps.rpc('uzum_check_order', { p_order_id: request.orderId })
      if (!result?.ok) return fail((result?.error_code ?? UZUM_ERRORS.ACCOUNT_NOT_FOUND) as UzumErrorCode, echo)
      return ok(uzumSuccess({
        serviceId: request.serviceId,
        timestamp: at,
        status: 'OK',
        data: accountData(request.orderId, true),
      }))
    }

    // Остальным четырём ручкам transId обязателен: без него нечего искать и нечего создавать.
    if (!request.transId) return fail(UZUM_ERRORS.REQUIRED_FIELD_MISSING, echo)

    if (action === 'create') {
      if (!request.orderId) return fail(UZUM_ERRORS.REQUIRED_FIELD_MISSING, echo)
      // Отсутствие суммы — не ноль, а неверная сумма: приняв запрос без неё, мы завели бы
      // транзакцию, которую нечем сверить со счётом.
      if (request.amount == null) return fail(UZUM_ERRORS.INVALID_AMOUNT, echo)

      // transTime банк присылает не всегда. Своё время лучше выдуманного нуля: по нему потом
      // разбирают, когда покупатель начал платить.
      const transTime = request.transTime ?? at
      const result = await deps.rpc('uzum_create_transaction', {
        p_trans_id: request.transId,
        p_order_id: request.orderId,
        p_amount: request.amount,
        p_service_id: request.serviceId,
        p_trans_time: transTime,
        p_payment_source: request.paymentSource,
        p_phone: request.phone,
        p_payload: safePayload(request),
      })
      if (!result?.ok) return fail((result?.error_code ?? UZUM_ERRORS.INTERNAL) as UzumErrorCode, echo)
      return ok(uzumSuccess({
        serviceId: request.serviceId,
        transId: request.transId,
        status: 'CREATED',
        transTime,
        amount: request.amount,
        data: accountData(request.orderId),
      }))
    }

    if (action === 'confirm') {
      const confirmTime = request.confirmTime ?? at
      const result = await deps.rpc('uzum_confirm_transaction', {
        p_trans_id: request.transId,
        p_confirm_time: confirmTime,
        // Чем и с какого номера заплатили, банк сообщает ИМЕННО ЗДЕСЬ: на /create он этого ещё не
        // знает. Не передав их, мы получили бы две вечно пустые колонки в журнале платежей.
        p_payment_source: request.paymentSource,
        p_phone: request.phone,
      })
      if (!result?.ok) return fail((result?.error_code ?? UZUM_ERRORS.INTERNAL) as UzumErrorCode, echo)
      return ok(uzumSuccess({
        serviceId: request.serviceId,
        transId: request.transId,
        status: 'CONFIRMED',
        confirmTime,
        // Сумма и счёт берутся ИЗ БАЗЫ, а не из запроса: банк подтверждает то, что мы однажды
        // создали, и отвечать ему присланными сейчас числами значит подтверждать его же слова.
        amount: Number(result.amount),
        data: accountData(String(result.order_id ?? '')),
      }))
    }

    if (action === 'reverse') {
      const reverseTime = request.reverseTime ?? at
      const result = await deps.rpc('uzum_reverse_transaction', {
        p_trans_id: request.transId,
        p_reverse_time: reverseTime,
      })
      if (!result?.ok) return fail((result?.error_code ?? UZUM_ERRORS.INTERNAL) as UzumErrorCode, echo)
      return ok(uzumSuccess({
        serviceId: request.serviceId,
        transId: request.transId,
        status: 'REVERSED',
        reverseTime,
        amount: Number(result.amount),
        data: accountData(String(result.order_id ?? '')),
      }))
    }

    // status: единственная ручка, которая ничего не меняет.
    const tx = await deps.findTransaction(request.transId)
    if (!tx) return fail(UZUM_ERRORS.TRANSACTION_NOT_FOUND, echo)
    return ok(uzumSuccess({
      serviceId: request.serviceId,
      transId: tx.trans_id,
      status: tx.status,
      transTime: tx.trans_time,
      confirmTime: tx.confirm_time,
      reverseTime: tx.reverse_time,
      amount: tx.amount,
      data: accountData(tx.order_id),
    }))
  } catch (error) {
    deps.onError?.(action, error)
    /*
     * Поломка НАША, и банку об этом говорится кодом 99999, а не молчанием и не 10014.
     *
     * Соблазн ответить «транзакции нет» на упавший запрос велик — банк перестанет спрашивать. Но
     * тогда оплаченная транзакция навсегда останется неподтверждённой, а деньги — списанными.
     */
    return fail(UZUM_ERRORS.INTERNAL, echo)
  }
}
