// Выставление счёта и ссылки на кассы.
//
// Единственное место, где счёт РОЖДАЕТСЯ. Сумма берётся из PLAN_PRICE_UZS на сервере и попадает в
// строку снимком — клиент присылает только код тарифа. Позволить браузеру назвать сумму значило бы
// продать Business за тысячу сумов, и проверка платежа честно бы её подтвердила: она сверяет
// платёж со счётом, а не с прайсом.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import {
  PLAN_DURATION_DAYS, PLAN_PRICE_UZS,
  clickCheckoutUrl, paymeCheckoutUrl,
} from '../_shared/paymentProtocol.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PAYME_MERCHANT_ID = Deno.env.get('PAYME_MERCHANT_ID') ?? ''
const CLICK_SERVICE_ID = Deno.env.get('CLICK_SERVICE_ID') ?? ''
const CLICK_MERCHANT_ID = Deno.env.get('CLICK_MERCHANT_ID') ?? ''

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const authorization = req.headers.get('Authorization')
  if (!authorization) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(URL, ANON, { global: { headers: { Authorization: authorization } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await userDb.from('users').select('account_id, role').eq('id', user.id).maybeSingle()
  if (!profile?.account_id) return json({ error: 'no account' }, 403)
  // Платит владелец. Сотрудник не должен уметь выставить счёт на чужие деньги.
  if (profile.role !== 'owner') return json({ error: 'owner role required' }, 403)

  const body = await req.json().catch(() => ({}))
  const planCode = typeof body?.plan_code === 'string' ? body.plan_code.trim().toLowerCase() : ''
  const amountUzs = PLAN_PRICE_UZS[planCode]
  // Цены нет — тариф не продаётся. Отказ называет тариф, а не «ошибку сервера»: владелец должен
  // понять, что дело в ненастроенном прайсе, а не в его карте.
  if (!amountUzs) return json({ error: 'plan_not_for_sale', plan_code: planCode }, 400)

  const admin = createClient(URL, SERVICE)
  const amountTiyin = amountUzs * 100

  // Незакрытый счёт на тот же тариф переиспользуется. Иначе каждое нажатие «Оплатить» плодило бы
  // новый счёт, а в кассе у покупателя оставались бы открытыми старые ссылки на те же деньги.
  const { data: open } = await admin.from('billing_invoices')
    .select('id, invoice_no, amount_tiyin, expires_at')
    .eq('account_id', profile.account_id).eq('plan_code', planCode).eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle()

  // Цена изменилась с момента выставления — старый счёт не годится: его условия заморожены, и
  // покупатель заплатил бы по вчерашнему прайсу.
  let invoice = open && Number(open.amount_tiyin) === amountTiyin ? open : null

  if (!invoice) {
    const { data: created, error } = await admin.from('billing_invoices').insert({
      account_id: profile.account_id,
      plan_code: planCode,
      amount_tiyin: amountTiyin,
      duration_days: PLAN_DURATION_DAYS,
    }).select('id, invoice_no').single()
    if (error || !created) return json({ error: 'could not create invoice' }, 500)
    invoice = created
  }

  // Кассам уходит НОМЕР счёта, а не uuid: Click работает целыми числами, и его сертификация uuid
  // не принимает. Номер к тому же произносится вслух — на него ссылаются в споре об оплате.
  const invoiceNo = Number(invoice.invoice_no)

  // Ссылка строится только для настроенной кассы. Кнопка, ведущая в ненастроенную, — это отказ
  // на чужой странице вместо отказа на своей.
  const payme = paymeCheckoutUrl({ merchantId: PAYME_MERCHANT_ID, invoiceNo, amountTiyin })
  const click = clickCheckoutUrl({ serviceId: CLICK_SERVICE_ID, merchantId: CLICK_MERCHANT_ID, invoiceNo, amountTiyin })

  return json({
    ok: true,
    invoice_id: invoice.id,
    invoice_no: invoiceNo,
    plan_code: planCode,
    amount_uzs: amountUzs,
    duration_days: PLAN_DURATION_DAYS,
    payme_url: payme,
    click_url: click,
    // Обе кассы не настроены — владелец увидит это как факт, а не как пустой экран.
    providers_ready: Boolean(payme || click),
  })
})
