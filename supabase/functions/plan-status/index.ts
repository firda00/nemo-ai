// Plan status for the billing page. Read-only.
//   POST /functions/v1/plan-status  (Bearer jwt)
//     -> { plan, used, quota, dialoguesUsed, dialoguesQuota, limit, plans }
//
// `used`/`quota` — токены. Они остались ради обратной совместимости и внутренней диагностики,
// но витрина считает в ДИАЛОГАХ: dialoguesUsed/dialoguesQuota. Владелец бизнеса не может
// оценить «2 000 000 токенов», а «412 из 5 000 диалогов» оценивает мгновенно.
//
// Счётчик диалогов не должен ронять страницу биллинга: если агрегат недоступен, возвращаем
// null и UI показывает прочерк вместо прогресс-бара. Отказ показать число лучше, чем показать
// ноль, который читается как «вы ничего не потратили».
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { PLAN_LIMITS, planOf, monthlyTokens, monthlyDialogues } from '../_shared/plans.ts'
import { corsPreflight, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('plan').eq('id', accountId).single()
  const planName = String(acc?.plan ?? 'free')
  const limit = planOf(planName)
  const used = await monthlyTokens(admin, accountId)
  let dialoguesUsed: number | null = null
  try {
    dialoguesUsed = await monthlyDialogues(admin, accountId)
  } catch {
    dialoguesUsed = null // страница биллинга обязана открыться даже без счётчика
  }
  return json({
    ok: true,
    plan: planName,
    used,
    quota: limit.tokens,
    dialoguesUsed,
    dialoguesQuota: limit.dialogues,
    limit,
    plans: PLAN_LIMITS,
  })
})
