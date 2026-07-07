// Plan status for the billing page: the account's current plan, month-to-date token
// usage, its quota, and the full plan catalog. Read-only.
//   POST /functions/v1/plan-status  (Bearer jwt) -> { plan, used, quota, limit, plans }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { PLAN_LIMITS, planOf, monthlyTokens } from '../_shared/plans.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
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
  return json({ ok: true, plan: planName, used, quota: limit.tokens, limit, plans: PLAN_LIMITS })
})
