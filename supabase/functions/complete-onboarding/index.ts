import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const LEGAL_VERSION = '2026-08-03'
const allowedMarkets = new Set(['uz', 'us', 'uz_us', 'other'])
const allowedRoles = new Set(['founder', 'seller', 'agency', 'developer', 'operations', 'other'])
const allowedTasks = new Set(['sales', 'marketplace', 'support', 'content', 'operations', 'development', 'research'])
const allowedSources = new Set(['website', 'files', 'uzum', 'telegram', 'email', 'crm', 'github', 'google', 'later'])

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authorization = req.headers.get('Authorization')
  if (!authorization) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(URL, ANON, { global: { headers: { Authorization: authorization } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await userDb.from('users').select('account_id').eq('id', user.id).maybeSingle()
  if (!profile?.account_id) return json({ error: 'no account' }, 403)
  const body = await req.json().catch(() => ({}))
  const company = String(body.company ?? '').trim().slice(0, 160)
  const market = String(body.market ?? '')
  const role = String(body.role ?? '')
  const goal = String(body.goal ?? '').trim().slice(0, 1200)
  const tasks = Array.isArray(body.tasks) ? body.tasks.map(String).filter((v: string) => allowedTasks.has(v)).slice(0, 7) : []
  const sources = Array.isArray(body.sources) ? body.sources.map(String).filter((v: string) => allowedSources.has(v)).slice(0, 9) : []
  const policy = body.action_policy === 'read_only' ? 'read_only' : 'approval_required'
  if (!company || !allowedMarkets.has(market) || !allowedRoles.has(role) || goal.length < 10 || !tasks.length || !sources.length || body.accept_privacy !== true || body.accept_terms !== true) {
    return json({ error: 'complete all required onboarding fields' }, 400)
  }
  const admin = createClient(URL, SERVICE)
  const { error: businessError } = await admin.from('business_profiles').upsert({
    account_id: profile.account_id,
    name: company,
    operating_markets: [market],
    owner_role: role,
    primary_goal: goal,
    task_types: tasks,
    data_sources: sources,
    default_action_policy: policy,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'account_id' })
  if (businessError) return json({ error: 'could not save business profile' }, 500)
  const consents = [
    { document: 'privacy', granted: true },
    { document: 'terms', granted: true },
    { document: 'marketing_email', granted: body.marketing_email === true },
    { document: 'marketing_telegram', granted: body.marketing_telegram === true },
  ].map((entry) => ({ ...entry, account_id: profile.account_id, user_id: user.id, version: LEGAL_VERSION }))
  const { error: consentError } = await admin.from('user_consents').insert(consents)
  if (consentError) return json({ error: 'could not save consent record' }, 500)
  const { error: metadataError } = await admin.auth.admin.updateUserById(user.id, { user_metadata: { ...user.user_metadata, onboarding_completed: true, onboarding_version: LEGAL_VERSION } })
  if (metadataError) return json({ error: 'could not complete onboarding' }, 500)
  return json({ ok: true, version: LEGAL_VERSION })
})
