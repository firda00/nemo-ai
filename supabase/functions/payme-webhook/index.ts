// Касса Payme. JSON-RPC поверх чистого модуля протокола.
//
// Функция намеренно тонкая: разбор, проверка подписи и коды ошибок живут в paymentProtocol.ts и
// покрыты тестами, а начисление — в apply_invoice_entitlement, где оно атомарно. Здесь остаётся
// только HTTP и переходы состояний транзакции.
//
// verify_jwt отключён, потому что Payme не умеет присылать JWT Supabase. Это НЕ значит «без
// авторизации»: каждый запрос обязан принести HTTP Basic с ключом мерчанта, и без него дальше
// разбора дело не идёт.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import {
  PAYME_CANCEL_TIMEOUT, PAYME_DATA_FIELD, PAYME_ERRORS, PAYME_MESSAGES, PAYME_STATE,
  amountToTiyin, checkInvoicePayable, checkPaymeAuth, paymeExpired,
  paymeInvoiceRef, parsePaymeRequest, paymeFailure, paymeResult, sameInvoiceRef,
  type InvoiceRef,
} from '../_shared/paymentProtocol.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PAYME_LOGIN = Deno.env.get('PAYME_LOGIN') ?? 'Paycom'
const PAYME_KEY = Deno.env.get('PAYME_MERCHANT_KEY') ?? ''

const reply = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, // Payme читает тело, а не код: 4xx он считает сбоем связи и будет повторять.
  headers: { 'Content-Type': 'application/json' },
})

const INVOICE_COLUMNS = 'id, invoice_no, account_id, status, amount_tiyin, entitlement_applied_at, expires_at'

/** Счёт по ссылке из account: по номеру или по uuid, смотря что объявила касса. */
async function invoiceByRef(db: any, ref: InvoiceRef | null) {
  if (!ref) return null
  const query = db.from('billing_invoices').select(INVOICE_COLUMNS)
  const { data } = ref.by === 'no'
    ? await query.eq('invoice_no', ref.value).maybeSingle()
    : await query.eq('id', ref.value).maybeSingle()
  return data
}

/** Транзакция Payme по её id. Одна строка — одна транзакция кассы. */
async function transactionByProviderId(db: any, providerId: string) {
  const { data } = await db.from('billing_transactions')
    .select('*').eq('provider', 'payme').eq('provider_transaction_id', providerId).maybeSingle()
  return data
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return reply(paymeFailure(null, PAYME_ERRORS.INVALID_REQUEST, PAYME_MESSAGES.invalid_request))
  }

  // Тело читается ТЕКСТОМ, а разбирается отдельно: битый JSON и правильный JSON не того вида —
  // разные отказы с разными кодами, и различить их можно только здесь.
  const rawBody = await req.text()
  let parsed: unknown = null
  let parseFailed = false
  try { parsed = JSON.parse(rawBody) } catch { parseFailed = true }
  // id возвращается даже в отказе: касса сопоставляет ответ с запросом по нему.
  const rawId = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).id ?? null : null

  // Авторизация ПЕРВОЙ и до любого обращения к базе: неавторизованный запрос не должен уметь
  // даже проверить, существует ли счёт с таким номером, и не должен узнавать, разобрали ли мы его.
  if (!checkPaymeAuth(req.headers.get('Authorization'), PAYME_LOGIN, PAYME_KEY)) {
    return reply(paymeFailure(rawId, PAYME_ERRORS.UNAUTHORIZED, PAYME_MESSAGES.unauthorized))
  }
  if (parseFailed) return reply(paymeFailure(null, PAYME_ERRORS.PARSE, PAYME_MESSAGES.parse_error))

  const request = parsePaymeRequest(parsed)
  if (!request) return reply(paymeFailure(rawId, PAYME_ERRORS.INVALID_REQUEST, PAYME_MESSAGES.invalid_request))

  const db = createClient(URL, SERVICE)
  const { id, method, params } = request
  const providerId = typeof params.id === 'string' ? params.id : ''
  const amount = amountToTiyin(params.amount)

  /**
   * Брошенная транзакция закрывается по таймауту.
   *
   * Требование протокола: незавершённая транзакция старше 12 часов отменяется с причиной 4. Без
   * этого она висит в состоянии 1 навсегда и держит счёт занятым: новый платёж по нему касса
   * создать не даст, а этот уже никто не завершит.
   */
  async function cancelExpired(row: { id: string; cancelled_at: string | null }) {
    const cancelledAt = row.cancelled_at ?? new Date().toISOString()
    await db.from('billing_transactions')
      .update({ state: PAYME_STATE.CANCELLED, cancelled_at: cancelledAt, cancel_reason: PAYME_CANCEL_TIMEOUT })
      .eq('id', row.id).eq('state', PAYME_STATE.CREATED)
    return cancelledAt
  }

  try {
    if (method === 'CheckPerformTransaction') {
      const invoice = await invoiceByRef(db, paymeInvoiceRef(params))
      const check = checkInvoicePayable(invoice, amount)
      if (check.ok) return reply(paymeResult(id, { allow: true }))
      // Каждая причина — свой код, и каждая называет поле. «Не найден» вместо «неверная сумма»
      // отправил бы покупателя искать несуществующую опечатку в номере счёта.
      if (check.reason === 'wrong_amount') {
        return reply(paymeFailure(id, PAYME_ERRORS.INVALID_AMOUNT, PAYME_MESSAGES.invalid_amount, PAYME_DATA_FIELD.AMOUNT))
      }
      if (check.reason === 'not_found') {
        return reply(paymeFailure(id, PAYME_ERRORS.INVOICE_NOT_FOUND, PAYME_MESSAGES.invoice_not_found, PAYME_DATA_FIELD.ACCOUNT))
      }
      return reply(paymeFailure(id, PAYME_ERRORS.INVOICE_NOT_FOUND, PAYME_MESSAGES.invoice_closed, PAYME_DATA_FIELD.ACCOUNT))
    }

    if (method === 'CreateTransaction') {
      const ref = paymeInvoiceRef(params)
      const existing = await transactionByProviderId(db, providerId)
      if (existing) {
        // Повтор Create с тем же id — штатное поведение кассы. Ответ обязан совпасть с первым, но
        // ТОЛЬКО если условия те же: изменившаяся сумма или счёт означают чужую транзакцию под
        // знакомым номером, и отвечать на неё старым успехом нельзя.
        const { data: linked } = await db.from('billing_invoices')
          .select('id, invoice_no').eq('id', existing.invoice_id).maybeSingle()
        if (Number(existing.amount_tiyin) !== amount || !sameInvoiceRef(ref, linked)) {
          return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))
        }
        if (existing.state !== PAYME_STATE.CREATED) {
          return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))
        }
        // Просроченную транзакцию нельзя подтверждать повторным успехом: касса решит, что она
        // жива, и будет ждать Perform, которого мы уже не примем.
        if (paymeExpired(existing.created_at)) {
          await cancelExpired(existing)
          return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.timeout))
        }
        return reply(paymeResult(id, {
          create_time: new Date(existing.created_at).getTime(),
          transaction: String(existing.transaction_no),
          state: existing.state,
        }))
      }

      const invoice = await invoiceByRef(db, ref)
      const check = checkInvoicePayable(invoice, amount)
      if (!check.ok) {
        if (check.reason === 'wrong_amount') {
          return reply(paymeFailure(id, PAYME_ERRORS.INVALID_AMOUNT, PAYME_MESSAGES.invalid_amount, PAYME_DATA_FIELD.AMOUNT))
        }
        if (check.reason === 'already_paid') {
          return reply(paymeFailure(id, PAYME_ERRORS.INVOICE_NOT_FOUND, PAYME_MESSAGES.invoice_closed, PAYME_DATA_FIELD.ACCOUNT))
        }
        return reply(paymeFailure(id, PAYME_ERRORS.INVOICE_NOT_FOUND, PAYME_MESSAGES.invoice_not_found, PAYME_DATA_FIELD.ACCOUNT))
      }

      const { data: created, error } = await db.from('billing_transactions').insert({
        provider: 'payme',
        provider_transaction_id: providerId,
        invoice_id: invoice!.id,
        account_id: invoice!.account_id,
        amount_tiyin: amount,
        state: PAYME_STATE.CREATED,
      }).select('id, transaction_no, created_at, state').single()
      // Гонка двух Create с одним id: уникальность отдаёт 23505, и мы возвращаем ту строку,
      // которую успел записать сосед, а не вторую транзакцию на тот же счёт.
      if (error) {
        const again = await transactionByProviderId(db, providerId)
        if (!again) return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))
        return reply(paymeResult(id, {
          create_time: new Date(again.created_at).getTime(),
          transaction: String(again.transaction_no),
          state: again.state,
        }))
      }
      return reply(paymeResult(id, {
        create_time: new Date(created.created_at).getTime(),
        transaction: String(created.transaction_no),
        state: created.state,
      }))
    }

    if (method === 'PerformTransaction') {
      const existing = await transactionByProviderId(db, providerId)
      // Perform до Create — транзакции нет. Создавать её задним числом нельзя: платёж появился бы
      // из ниоткуда, и мы бы сами себе его подтвердили.
      if (!existing) return reply(paymeFailure(id, PAYME_ERRORS.TRANSACTION_NOT_FOUND, PAYME_MESSAGES.transaction_not_found))
      if (existing.state === PAYME_STATE.PERFORMED) {
        return reply(paymeResult(id, {
          transaction: String(existing.transaction_no), state: existing.state,
          perform_time: new Date(existing.performed_at).getTime(),
        }))
      }
      if (existing.state !== PAYME_STATE.CREATED) {
        return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))
      }
      // Двенадцать часов истекли — платёж не выполняется, а транзакция закрывается причиной 4.
      if (paymeExpired(existing.created_at)) {
        await cancelExpired(existing)
        return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.timeout))
      }

      // Начисление атомарно и ровно один раз — вся защита там, а не здесь.
      const { data: applied } = await db.rpc('apply_invoice_entitlement', { p_invoice_id: existing.invoice_id })
      if (!applied?.ok) return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))

      const performedAt = new Date().toISOString()
      await db.from('billing_transactions')
        .update({ state: PAYME_STATE.PERFORMED, performed_at: performedAt })
        .eq('id', existing.id).eq('state', PAYME_STATE.CREATED)
      return reply(paymeResult(id, {
        transaction: String(existing.transaction_no), state: PAYME_STATE.PERFORMED, perform_time: Date.parse(performedAt),
      }))
    }

    if (method === 'CancelTransaction') {
      const existing = await transactionByProviderId(db, providerId)
      if (!existing) return reply(paymeFailure(id, PAYME_ERRORS.TRANSACTION_NOT_FOUND, PAYME_MESSAGES.transaction_not_found))
      // Отмена уже выполненного платежа НЕ отзывает выданный срок автоматически: у владельца мог
      // накопиться срок и от других счетов, и вычитание вслепую отобрало бы чужие дни. Транзакция
      // помечается отменённой, дальше — решение человека.
      const state = existing.state === PAYME_STATE.PERFORMED ? PAYME_STATE.CANCELLED_AFTER_PERFORM : PAYME_STATE.CANCELLED
      const cancelledAt = existing.cancelled_at ?? new Date().toISOString()
      if (existing.state > 0) {
        await db.from('billing_transactions')
          .update({ state, cancelled_at: cancelledAt, cancel_reason: Number(params.reason) || null })
          .eq('id', existing.id)
      }
      return reply(paymeResult(id, {
        transaction: String(existing.transaction_no),
        state: existing.state > 0 ? state : existing.state,
        cancel_time: Date.parse(cancelledAt),
      }))
    }

    if (method === 'CheckTransaction') {
      const existing = await transactionByProviderId(db, providerId)
      if (!existing) return reply(paymeFailure(id, PAYME_ERRORS.TRANSACTION_NOT_FOUND, PAYME_MESSAGES.transaction_not_found))
      // Проверка состояния — тоже момент, когда таймаут обязан сработать: касса опрашивает нас
      // именно ею, и увидеть «ещё жива» через сутки после создания она не должна.
      let { state, cancelled_at: cancelledAt, cancel_reason: cancelReason } = existing
      if (state === PAYME_STATE.CREATED && paymeExpired(existing.created_at)) {
        cancelledAt = await cancelExpired(existing)
        state = PAYME_STATE.CANCELLED
        cancelReason = PAYME_CANCEL_TIMEOUT
      }
      return reply(paymeResult(id, {
        create_time: new Date(existing.created_at).getTime(),
        perform_time: existing.performed_at ? new Date(existing.performed_at).getTime() : 0,
        cancel_time: cancelledAt ? new Date(cancelledAt).getTime() : 0,
        transaction: String(existing.transaction_no),
        state,
        reason: cancelReason ?? null,
      }))
    }

    return reply(paymeFailure(id, PAYME_ERRORS.METHOD_NOT_FOUND, PAYME_MESSAGES.method_not_found))
  } catch (error) {
    console.error('payme webhook error:', error)
    // Даже на своей поломке отвечаем протоколом: HTTP 500 касса читает как «связь пропала» и
    // повторяет запрос, а покупатель видит бесконечное ожидание вместо внятного отказа.
    return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))
  }
})
