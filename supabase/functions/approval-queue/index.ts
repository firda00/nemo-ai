// Owner decisions change queue state only. A future executor must separately
// consume an approved request and record its own result/audit evidence.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authorization = req.headers.get('Authorization')
  if (!authorization) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(URL, ANON, { global: { headers: { Authorization: authorization } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await userDb.from('users').select('account_id, role').eq('id', user.id).maybeSingle()
  if (!profile?.account_id) return json({ error: 'no account' }, 403)
  if (profile.role !== 'owner') return json({ error: 'owner role required' }, 403)
  const body = await req.json().catch(() => ({}))
  const admin = createClient(URL, SERVICE)
  if (body.action === 'list') {
    await admin.from('approval_requests').update({ status: 'expired' }).eq('account_id', profile.account_id).eq('status', 'pending').lt('expires_at', new Date().toISOString())
    const columns = 'id, source, action_type, summary, evidence, related_research_run_id, status, expires_at, created_at'
    const [{ data: pending, error: pendingError }, { data: history, error: historyError }] = await Promise.all([
      admin.from('approval_requests').select(columns).eq('account_id', profile.account_id).eq('status', 'pending').order('created_at', { ascending: false }).limit(50),
      admin.from('approval_requests').select(columns).eq('account_id', profile.account_id).neq('status', 'pending').order('created_at', { ascending: false }).limit(50),
    ])
    return pendingError || historyError ? json({ error: 'could not load approvals' }, 500) : json({ ok: true, requests: [...(pending ?? []), ...(history ?? [])].slice(0, 50) })
  }
  const decision = String(body.decision ?? '')
  if (body.action === 'decide' && (decision === 'approved' || decision === 'rejected')) {
    const { data, error } = await admin.rpc('decide_approval_request', {
      p_account_id: profile.account_id,
      p_user_id: user.id,
      p_request_id: String(body.id ?? ''),
      p_decision: decision,
    })
    if (error || data !== true) return json({ error: 'request is no longer pending' }, 409)
    return json({ ok: true, status: decision })
  }
  return json({ error: 'unknown action' }, 400)
})
