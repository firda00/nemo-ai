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
  PAYME_ERRORS, PAYME_MESSAGES, PAYME_STATE,
  amountToTiyin, checkInvoicePayable, checkPaymeAuth,
  parsePaymeRequest, paymeFailure, paymeInvoiceId, paymeResult,
} from '../_shared/paymentProtocol.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PAYME_LOGIN = Deno.env.get('PAYME_LOGIN') ?? 'Paycom'
const PAYME_KEY = Deno.env.get('PAYME_MERCHANT_KEY') ?? ''

const reply = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, // Payme читает тело, а не код: 4xx он считает сбоем связи и будет повторять.
  headers: { 'Content-Type': 'application/json' },
})

/** Транзакция Payme по её id. Одна строка — одна транзакция кассы. */
async function transactionByProviderId(db: any, providerId: string) {
  const { data } = await db.from('billing_transactions')
    .select('*').eq('provider', 'payme').eq('provider_transaction_id', providerId).maybeSingle()
  return data
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply({ error: { code: PAYME_ERRORS.INVALID_REQUEST, message: PAYME_MESSAGES.method_not_found } })

  const raw = await req.json().catch(() => null)
  const request = parsePaymeRequest(raw)
  if (!request) return reply({ jsonrpc: '2.0', id: null, error: { code: PAYME_ERRORS.PARSE, message: PAYME_MESSAGES.method_not_found } })

  // Авторизация ПЕРВОЙ и до любого обращения к базе: неавторизованный запрос не должен уметь
  // даже проверить, существует ли счёт с таким номером.
  if (!checkPaymeAuth(req.headers.get('Authorization'), PAYME_LOGIN, PAYME_KEY)) {
    return reply(paymeFailure(request.id, PAYME_ERRORS.UNAUTHORIZED, PAYME_MESSAGES.unauthorized))
  }

  const db = createClient(URL, SERVICE)
  const { id, method, params } = request
  const providerId = typeof params.id === 'string' ? params.id : ''
  const amount = amountToTiyin(params.amount)

  try {
    if (method === 'CheckPerformTransaction') {
      const invoiceId = paymeInvoiceId(params)
      if (!invoiceId) return reply(paymeFailure(id, PAYME_ERRORS.INVOICE_NOT_FOUND, PAYME_MESSAGES.invoice_not_found))
      const { data: invoice } = await db.from('billing_invoices')
        .select('status, amount_tiyin, entitlement_applied_at, expires_at').eq('id', invoiceId).maybeSingle()
      const check = checkInvoicePayable(invoice, amount)
      if (check.ok) return reply(paymeResult(id, { allow: true }))
      // Каждая причина — свой код. «Не найден» вместо «неверная сумма» отправил бы покупателя
      // искать несуществующую опечатку в номере счёта.
      if (check.reason === 'wrong_amount') return reply(paymeFailure(id, PAYME_ERRORS.INVALID_AMOUNT, PAYME_MESSAGES.invalid_amount))
      if (check.reason === 'not_found') return reply(paymeFailure(id, PAYME_ERRORS.INVOICE_NOT_FOUND, PAYME_MESSAGES.invoice_not_found))
      return reply(paymeFailure(id, PAYME_ERRORS.INVOICE_NOT_FOUND, PAYME_MESSAGES.invoice_closed))
    }

    if (method === 'CreateTransaction') {
      const existing = await transactionByProviderId(db, providerId)
      if (existing) {
        // Повтор Create с тем же id — штатное поведение кассы. Ответ обязан совпасть с первым, но
        // ТОЛЬКО если условия те же: изменившаяся сумма или счёт означают чужую транзакцию под
        // знакомым номером, и отвечать на неё старым успехом нельзя.
        if (Number(existing.amount_tiyin) !== amount || existing.invoice_id !== paymeInvoiceId(params)) {
          return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))
        }
        if (existing.state !== PAYME_STATE.CREATED) {
          return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))
        }
        return reply(paymeResult(id, {
          create_time: new Date(existing.created_at).getTime(),
          transaction: existing.id,
          state: existing.state,
        }))
      }

      const invoiceId = paymeInvoiceId(params)
      if (!invoiceId) return reply(paymeFailure(id, PAYME_ERRORS.INVOICE_NOT_FOUND, PAYME_MESSAGES.invoice_not_found))
      const { data: invoice } = await db.from('billing_invoices')
        .select('id, account_id, status, amount_tiyin, entitlement_applied_at, expires_at').eq('id', invoiceId).maybeSingle()
      const check = checkInvoicePayable(invoice, amount)
      if (!check.ok) {
        if (check.reason === 'wrong_amount') return reply(paymeFailure(id, PAYME_ERRORS.INVALID_AMOUNT, PAYME_MESSAGES.invalid_amount))
        if (check.reason === 'already_paid') return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.invoice_closed))
        return reply(paymeFailure(id, PAYME_ERRORS.INVOICE_NOT_FOUND, PAYME_MESSAGES.invoice_not_found))
      }

      const { data: created, error } = await db.from('billing_transactions').insert({
        provider: 'payme',
        provider_transaction_id: providerId,
        invoice_id: invoice!.id,
        account_id: invoice!.account_id,
        amount_tiyin: amount,
        state: PAYME_STATE.CREATED,
      }).select('id, created_at, state').single()
      // Гонка двух Create с одним id: уникальность отдаёт 23505, и мы возвращаем ту строку,
      // которую успел записать сосед, а не вторую транзакцию на тот же счёт.
      if (error) {
        const again = await transactionByProviderId(db, providerId)
        if (!again) return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))
        return reply(paymeResult(id, { create_time: new Date(again.created_at).getTime(), transaction: again.id, state: again.state }))
      }
      return reply(paymeResult(id, { create_time: new Date(created.created_at).getTime(), transaction: created.id, state: created.state }))
    }

    if (method === 'PerformTransaction') {
      const existing = await transactionByProviderId(db, providerId)
      // Perform до Create — транзакции нет. Создавать её задним числом нельзя: платёж появился бы
      // из ниоткуда, и мы бы сами себе его подтвердили.
      if (!existing) return reply(paymeFailure(id, PAYME_ERRORS.TRANSACTION_NOT_FOUND, PAYME_MESSAGES.transaction_not_found))
      if (existing.state === PAYME_STATE.PERFORMED) {
        return reply(paymeResult(id, {
          transaction: existing.id, state: existing.state,
          perform_time: new Date(existing.performed_at).getTime(),
        }))
      }
      if (existing.state !== PAYME_STATE.CREATED) {
        return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))
      }

      // Начисление атомарно и ровно один раз — вся защита там, а не здесь.
      const { data: applied } = await db.rpc('apply_invoice_entitlement', { p_invoice_id: existing.invoice_id })
      if (!applied?.ok) return reply(paymeFailure(id, PAYME_ERRORS.CANNOT_PERFORM, PAYME_MESSAGES.cannot_perform))

      const performedAt = new Date().toISOString()
      await db.from('billing_transactions')
        .update({ state: PAYME_STATE.PERFORMED, performed_at: performedAt })
        .eq('id', existing.id).eq('state', PAYME_STATE.CREATED)
      return reply(paymeResult(id, { transaction: existing.id, state: PAYME_STATE.PERFORMED, perform_time: Date.parse(performedAt) }))
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
        transaction: existing.id,
        state: existing.state > 0 ? state : existing.state,
        cancel_time: Date.parse(cancelledAt),
      }))
    }

    if (method === 'CheckTransaction') {
      const existing = await transactionByProviderId(db, providerId)
      if (!existing) return reply(paymeFailure(id, PAYME_ERRORS.TRANSACTION_NOT_FOUND, PAYME_MESSAGES.transaction_not_found))
      return reply(paymeResult(id, {
        create_time: new Date(existing.created_at).getTime(),
        perform_time: existing.performed_at ? new Date(existing.performed_at).getTime() : 0,
        cancel_time: existing.cancelled_at ? new Date(existing.cancelled_at).getTime() : 0,
        transaction: existing.id,
        state: existing.state,
        reason: existing.cancel_reason ?? null,
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
