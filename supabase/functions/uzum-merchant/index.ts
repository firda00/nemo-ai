// Касса Uzum Bank Merchant API v1.0.0. Пять ручек: /check, /create, /confirm, /reverse, /status.
//
// ЭТОТ ФАЙЛ — ТОЛЬКО ПЕРЕХОДНИК. Разбор и коды живут в _shared/uzumBank.ts, маршрутизация и
// решения — в _shared/uzumHandler.ts, состояния и деньги — в SQL-функциях uzum_*. Здесь остаётся
// ровно то, что нельзя выполнить под Node: Deno.serve, Deno.env и клиент Supabase.
//
// Разделение не ради красоты. Пока маршрутизация лежала здесь, проверить её можно было только
// глазами или регуляркой по исходнику — а регулярка не поймает ни перепутанный код ошибки, ни то,
// что /confirm отвечает суммой из запроса вместо суммы из базы.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { uzumServiceId } from '../_shared/uzumBank.ts'
import { handleUzum, type UzumRpcResult, type UzumTransactionRow } from '../_shared/uzumHandler.ts'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const config = {
  basicUser: Deno.env.get('UZUM_BASIC_USER') ?? '',
  basicPass: Deno.env.get('UZUM_BASIC_PASS') ?? '',
  serviceId: uzumServiceId(Deno.env.get('UZUM_SERVICE_ID')),
  /** Имя, которое банк показывает плательщику в поле «ФИО». */
  payerLabel: Deno.env.get('UZUM_PAYER_LABEL') ?? 'Nemo AI',
}

Deno.serve(async (req) => {
  /*
   * Тело читается ЗДЕСЬ, но результат разбора передаётся флагом.
   *
   * Прочитать его должен переходник — Request одноразовый. А вот отвечать на неразобранное тело
   * обязан обработчик, и только ПОСЛЕ проверки Basic: иначе неавторизованный узнаёт по коду
   * ответа, дошёл ли его запрос до разбора.
   */
  let body: unknown
  let bodyParseFailed = false
  try { body = await req.json() } catch { bodyParseFailed = true }

  const response = await handleUzum({
    method: req.method,
    pathname: new URL(req.url).pathname,
    authorization: req.headers.get('Authorization'),
    body,
    bodyParseFailed,
  }, {
    config,
    now: () => Date.now(),
    rpc: async (fn, args) => {
      const { data, error } = await db.rpc(fn, args)
      if (error) throw error
      return (data ?? {}) as UzumRpcResult
    },
    findTransaction: async (transId) => {
      const { data, error } = await db.from('uzum_transactions')
        .select('trans_id, order_id, status, amount, trans_time, confirm_time, reverse_time')
        .eq('trans_id', transId)
        .maybeSingle()
      /*
       * ОШИБКА БАЗЫ — ЭТО ИСКЛЮЧЕНИЕ, А НЕ «НЕ НАЙДЕНО».
       *
       * Проглотив её, мы отвечаем банку 10014 «транзакции нет» на упавшую базу. Он поверит и
       * перестанет спрашивать — а транзакция существует, деньги списаны, и подтвердить её уже
       * никто не придёт.
       */
      if (error) throw error
      return (data ?? null) as UzumTransactionRow | null
    },
    // Тело запроса в журнал НЕ пишется: там телефон плательщика, а журналы живут дольше и
    // читаются шире, чем таблица платежей.
    onError: (action, error) => console.error('uzum-merchant:', action, error instanceof Error ? error.message : error),
  })

  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  })
})
