// Касса Click. Две фазы: Prepare, затем Complete.
//
// Тонкая, как и Payme: подпись, коды и разбор живут в paymentProtocol.ts, начисление — в
// apply_invoice_entitlement. Здесь только HTTP и связь фаз.
//
// Click шлёт форму, а не JSON, и читает ответ телом. Код HTTP всегда 200: 4xx он считает сбоем
// связи и повторяет запрос, а покупатель видит бесконечное ожидание вместо внятного отказа.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import {
  CLICK_ACTION, CLICK_ERRORS, CLICK_NOTES,
  amountToTiyin, checkClickSignature, checkInvoicePayable,
  clickResponse, parseClickRequest,
} from '../_shared/paymentProtocol.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CLICK_SECRET = Deno.env.get('CLICK_SECRET_KEY') ?? ''
const CLICK_SERVICE_ID = Deno.env.get('CLICK_SERVICE_ID') ?? ''

const reply = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

/** Тело приходит формой; JSON принимается тоже — тестовые пульты Click шлют и так, и так. */
async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const type = req.headers.get('content-type') ?? ''
  try {
    if (type.includes('application/json')) return await req.json()
    const form = await req.formData()
    return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]))
  } catch { return null }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply({ error: CLICK_ERRORS.BAD_REQUEST, error_note: CLICK_NOTES[CLICK_ERRORS.BAD_REQUEST] })

  const request = parseClickRequest(await readBody(req))
  if (!request) return reply({ error: CLICK_ERRORS.BAD_REQUEST, error_note: CLICK_NOTES[CLICK_ERRORS.BAD_REQUEST] })

  const fail = (code: number, note = CLICK_NOTES[code]) => reply(clickResponse({ request, error: code, note }))

  // Подпись — ПЕРВОЙ и до базы. Неподписанный запрос не должен уметь даже узнать, существует ли
  // счёт с таким номером.
  if (!checkClickSignature(request, CLICK_SECRET)) return fail(CLICK_ERRORS.SIGN_CHECK_FAILED)
  // Чужой сервис с верной подписью означает перепутанную настройку, а не оплату нашего счёта.
  if (CLICK_SERVICE_ID && request.service_id !== CLICK_SERVICE_ID) return fail(CLICK_ERRORS.BAD_REQUEST)

  const db = createClient(URL, SERVICE)
  const amount = amountToTiyin(request.amount)
  // merchant_trans_id — НАШ номер счёта. Он приходит извне, поэтому дальше идёт только как uuid.
  const invoiceId = /^[0-9a-f-]{36}$/i.test(request.merchant_trans_id) ? request.merchant_trans_id : null

  try {
    if (request.action !== CLICK_ACTION.PREPARE && request.action !== CLICK_ACTION.COMPLETE) {
      return fail(CLICK_ERRORS.ACTION_NOT_FOUND)
    }
    if (!invoiceId) return fail(CLICK_ERRORS.USER_NOT_FOUND)

    const { data: invoice } = await db.from('billing_invoices')
      .select('id, account_id, status, amount_tiyin, entitlement_applied_at, expires_at').eq('id', invoiceId).maybeSingle()

    const { data: existing } = await db.from('billing_transactions')
      .select('*').eq('provider', 'click').eq('provider_transaction_id', request.click_trans_id).maybeSingle()

    if (request.action === CLICK_ACTION.PREPARE) {
      // Повтор Prepare обязан вернуть ТОТ ЖЕ merchant_prepare_id: иначе Complete придёт с одним
      // номером, а у нас будет записан другой, и фазы не сойдутся.
      if (existing) {
        if (existing.state < 0) return fail(CLICK_ERRORS.TRANSACTION_CANCELLED)
        if (existing.state === 2) return fail(CLICK_ERRORS.ALREADY_PAID)
        return reply(clickResponse({
          request, error: CLICK_ERRORS.SUCCESS, note: CLICK_NOTES[CLICK_ERRORS.SUCCESS],
          merchantPrepareId: existing.merchant_prepare_id ?? existing.id,
        }))
      }

      const check = checkInvoicePayable(invoice, amount)
      if (!check.ok) {
        if (check.reason === 'wrong_amount') return fail(CLICK_ERRORS.INVALID_AMOUNT)
        if (check.reason === 'already_paid') return fail(CLICK_ERRORS.ALREADY_PAID)
        return fail(CLICK_ERRORS.USER_NOT_FOUND)
      }

      const prepareId = crypto.randomUUID()
      const { data: created, error } = await db.from('billing_transactions').insert({
        provider: 'click',
        provider_transaction_id: request.click_trans_id,
        invoice_id: invoice!.id,
        account_id: invoice!.account_id,
        amount_tiyin: amount,
        state: 1,
        merchant_prepare_id: prepareId,
      }).select('id, merchant_prepare_id').single()
      // Гонка двух Prepare с одним click_trans_id: уникальность отдаёт ошибку, и мы возвращаем то,
      // что записал сосед, а не вторую подготовку на тот же счёт.
      if (error) {
        const { data: again } = await db.from('billing_transactions')
          .select('id, merchant_prepare_id, state').eq('provider', 'click').eq('provider_transaction_id', request.click_trans_id).maybeSingle()
        if (!again) return fail(CLICK_ERRORS.BAD_REQUEST)
        return reply(clickResponse({ request, error: CLICK_ERRORS.SUCCESS, note: CLICK_NOTES[CLICK_ERRORS.SUCCESS], merchantPrepareId: again.merchant_prepare_id ?? again.id }))
      }
      return reply(clickResponse({ request, error: CLICK_ERRORS.SUCCESS, note: CLICK_NOTES[CLICK_ERRORS.SUCCESS], merchantPrepareId: created.merchant_prepare_id }))
    }

    // ПЛАТЁЖ МОГ НЕ ПРОЙТИ. Click сообщает исход полем error, и отрицательное значение означает
    // отказ банка, отмену покупателем или недостаток средств. Подпись при этом верная — запрос
    // настоящий, — и без этой проверки мы начисляли месяц за несостоявшуюся оплату.
    const providerError = Number(request.error ?? 0)
    if (providerError < 0) {
      if (existing && existing.state === 1) {
        await db.from('billing_transactions')
          .update({ state: -1, cancelled_at: new Date().toISOString(), cancel_reason: providerError })
          .eq('id', existing.id).eq('state', 1)
      }
      return fail(CLICK_ERRORS.TRANSACTION_CANCELLED)
    }

    // Complete: обязан прийти со своим Prepare и с тем же merchant_prepare_id.
    if (!existing) return fail(CLICK_ERRORS.TRANSACTION_NOT_FOUND)
    if (existing.state < 0) return fail(CLICK_ERRORS.TRANSACTION_CANCELLED)
    // Именно эта проверка не даёт второму Complete закрыться по чужой подготовке.
    if (String(request.merchant_prepare_id ?? '') !== String(existing.merchant_prepare_id ?? '')) {
      return fail(CLICK_ERRORS.TRANSACTION_NOT_FOUND)
    }
    // Сумма сверяется ЗАНОВО: Prepare мог пройти по одной, а Complete прийти с другой.
    if (amount == null || amount !== Number(existing.amount_tiyin)) return fail(CLICK_ERRORS.INVALID_AMOUNT)

    if (existing.state === 2) {
      // Уже оплачено — не ошибка, а сигнал «повторять не нужно».
      return reply(clickResponse({
        request, error: CLICK_ERRORS.SUCCESS, note: CLICK_NOTES[CLICK_ERRORS.SUCCESS],
        merchantPrepareId: existing.merchant_prepare_id, merchantConfirmId: existing.id,
      }))
    }

    const { data: applied } = await db.rpc('apply_invoice_entitlement', { p_invoice_id: existing.invoice_id })
    if (!applied?.ok) return fail(CLICK_ERRORS.BAD_REQUEST)

    await db.from('billing_transactions')
      .update({ state: 2, performed_at: new Date().toISOString() })
      .eq('id', existing.id).eq('state', 1)

    return reply(clickResponse({
      request, error: CLICK_ERRORS.SUCCESS, note: CLICK_NOTES[CLICK_ERRORS.SUCCESS],
      merchantPrepareId: existing.merchant_prepare_id, merchantConfirmId: existing.id,
    }))
  } catch (error) {
    console.error('click webhook error:', error)
    return fail(CLICK_ERRORS.BAD_REQUEST)
  }
})
