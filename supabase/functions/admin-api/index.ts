// Platform admin API. The caller must be a platform admin (users.is_admin).
// Manages the token economy: list accounts, grant/set balances, create + list
// gift codes. All writes use the service_role client (bypasses RLS) AFTER the
// admin check, so a normal user can never reach these even with a forged body.
//
//   POST /functions/v1/admin-api   (Authorization: Bearer <admin jwt>)
//   body { "action": "list_accounts" | "list_feedback" | "grant" | "set" | "create_gift" | "list_gifts", ... }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { hasRecentPasswordAndAal2 } from '../_shared/authAssurance.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function genCode(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 8) s += '-'
    s += a[Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * a.length)]
  }
  return 'NEMO-' + s
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: me } = await admin.from('users').select('is_admin').eq('id', user.id).single()
  if (!me?.is_admin) return json({ error: 'forbidden' }, 403)
  // getUser() above validates the bearer token. Only after that validation do
  // we trust its AAL claim and require a second factor for every admin action.
  if (!hasRecentPasswordAndAal2(authHeader)) return json({ error: 'fresh_password_and_mfa_required' }, 403)

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  try {
    if (action === 'list_accounts') {
      const { data: accounts } = await admin
        .from('accounts')
        .select('id, name, plan, token_balance, blocked, created_at')
        .order('created_at', { ascending: false })
        .limit(200)
      const { data: users } = await admin.from('users').select('id, account_id, email, is_admin')
      // user_id + email + admin-flag keyed by account
      const userByAcc = new Map((users ?? []).map((u: { id: string; account_id: string; email: string }) => [u.account_id, u]))
      const adminAccs = new Set((users ?? []).filter((u: { is_admin: boolean }) => u.is_admin).map((u: { account_id: string }) => u.account_id))
      // agent count per account
      const { data: ags } = await admin.from('agents').select('account_id')
      const agentCount = new Map<string, number>()
      for (const a of ags ?? []) agentCount.set(a.account_id, (agentCount.get(a.account_id) ?? 0) + 1)
      // last login from auth.users (GoTrue admin)
      const lastLogin = new Map<string, string | null>()
      try {
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
        for (const u of list?.users ?? []) lastLogin.set(u.id, u.last_sign_in_at ?? null)
      } catch { /* listUsers may be unavailable in some envs */ }
      const rows = (accounts ?? []).map((a: { id: string; name: string; plan: string; token_balance: number; blocked: boolean; created_at: string }) => {
        const u = userByAcc.get(a.id) as { id: string; email: string } | undefined
        return {
          ...a,
          email: u?.email ?? a.name,
          user_id: u?.id ?? null,
          is_admin: adminAccs.has(a.id),
          agents: agentCount.get(a.id) ?? 0,
          last_login: u ? lastLogin.get(u.id) ?? null : null,
        }
      })
      return json({ ok: true, accounts: rows, capabilities: { set_admin: true, moderate_agents: true } })
    }

    if (action === 'list_agents') {
      const { data: agents, error } = await admin
        .from('agents')
        .select('id, account_id, name, status, type, updated_at')
        .order('updated_at', { ascending: false })
        .limit(500)
      if (error) return json({ error: error.message }, 400)
      const { data: users } = await admin.from('users').select('account_id,email')
      const emailByAccount = new Map((users ?? []).map((row: { account_id: string; email: string }) => [row.account_id, row.email]))
      return json({ ok: true, agents: (agents ?? []).map((agent: { account_id: string }) => ({ ...agent, email: emailByAccount.get(agent.account_id) ?? null })) })
    }

    if (action === 'set_admin') {
      const userId = String(body?.user_id ?? '')
      const enabled = Boolean(body?.enabled)
      if (!userId) return json({ error: 'user_id required' }, 400)
      if (userId === user.id && !enabled) return json({ error: 'cannot remove your own admin access' }, 400)
      const { error } = await admin.from('users').update({ is_admin: enabled }).eq('id', userId)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true, enabled })
    }

    if (action === 'quarantine_agent') {
      const agentId = String(body?.agent_id ?? '')
      const quarantined = Boolean(body?.quarantined)
      if (!agentId) return json({ error: 'agent_id required' }, 400)
      const { error } = await admin.from('agents').update({ status: quarantined ? 'paused' : 'active' }).eq('id', agentId)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true, quarantined })
    }

    if (action === 'list_feedback') {
      let result = await admin
        .from('customer_feedback')
        .select('id, account_id, user_id, rating, category, topic, status, contact_requested, comment, path, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(100)
      if (result.error && /topic|status|contact_requested|updated_at|schema cache/i.test(result.error.message)) {
        const legacy = await admin
          .from('customer_feedback')
          .select('id, account_id, user_id, rating, category, comment, path, created_at')
          .order('created_at', { ascending: false })
          .limit(100)
        result = {
          ...legacy,
          data: (legacy.data ?? []).map((row) => ({ ...row, topic: null, status: 'new', contact_requested: false, updated_at: row.created_at })),
        } as typeof result
      }
      const { data, error } = result
      if (error) return json({ error: error.message }, 400)
      const userIds = [...new Set((data ?? []).map((row: { user_id: string }) => row.user_id))]
      const { data: users } = userIds.length
        ? await admin.from('users').select('id,email').in('id', userIds)
        : { data: [] as Array<{ id: string; email: string }> }
      const emailByUser = new Map((users ?? []).map((row: { id: string; email: string }) => [row.id, row.email]))
      return json({ ok: true, feedback: (data ?? []).map((row: { user_id: string }) => ({ ...row, email: emailByUser.get(row.user_id) ?? null })) })
    }

    if (action === 'list_onboarding') {
      const { data: profiles, error } = await admin
        .from('business_profiles')
        .select('account_id,name,operating_markets,owner_role,primary_goal,task_types,data_sources,default_action_policy,updated_at')
        .order('updated_at', { ascending: false })
        .limit(200)
      if (error) return json({ error: error.message }, 400)
      const accountIds = (profiles ?? []).map((row: { account_id: string }) => row.account_id)
      const { data: users } = accountIds.length
        ? await admin.from('users').select('account_id,email').in('account_id', accountIds)
        : { data: [] as Array<{ account_id: string; email: string }> }
      const emailByAccount = new Map((users ?? []).map((row: { account_id: string; email: string }) => [row.account_id, row.email]))
      return json({ ok: true, onboarding: (profiles ?? []).map((row: { account_id: string }) => ({ ...row, email: emailByAccount.get(row.account_id) ?? null })) })
    }

    if (action === 'update_feedback_status') {
      const feedbackId = String(body?.feedback_id ?? '')
      const status = String(body?.status ?? '')
      if (!feedbackId || !['new', 'reviewing', 'resolved'].includes(status)) return json({ error: 'invalid feedback status' }, 400)
      const { data, error } = await admin
        .from('customer_feedback')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', feedbackId)
        .select('id,status,updated_at')
        .single()
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true, feedback: data })
    }

    if (action === 'block') {
      const accountId = String(body?.account_id ?? '')
      const blocked = Boolean(body?.blocked)
      if (!accountId) return json({ error: 'account_id required' }, 400)
      await admin.from('accounts').update({ blocked }).eq('id', accountId)
      // pause all of the account's agents when blocking (they stop replying)
      if (blocked) await admin.from('agents').update({ status: 'paused' }).eq('account_id', accountId)
      return json({ ok: true, blocked })
    }

    if (action === 'ban') {
      const userId = String(body?.user_id ?? '')
      const banned = Boolean(body?.banned)
      if (!userId) return json({ error: 'user_id required' }, 400)
      // hard ban — GoTrue prevents login entirely ('none' to lift it)
      const { data: u } = await admin.from('users').select('account_id').eq('id', userId).single()
      if (u?.account_id) {
        const { data: accountUsers } = await admin.from('users').select('id').eq('account_id', u.account_id)
        await Promise.all((accountUsers ?? []).map((row: { id: string }) => admin.auth.admin.updateUserById(row.id, { ban_duration: banned ? '876000h' : 'none' })))
        await admin.from('accounts').update({ blocked: banned }).eq('id', u.account_id)
        if (banned) await admin.from('agents').update({ status: 'paused' }).eq('account_id', u.account_id)
      } else {
        await admin.auth.admin.updateUserById(userId, { ban_duration: banned ? '876000h' : 'none' })
      }
      return json({ ok: true, banned })
    }

    if (action === 'set_plan') {
      const accountId = String(body?.account_id ?? '')
      const plan = String(body?.plan ?? '')
      if (!accountId || !['free', 'starter', 'pro', 'business', 'agency', 'enterprise', 'beta'].includes(plan)) return json({ error: 'account_id and valid plan required' }, 400)
      await admin.from('accounts').update({ plan }).eq('id', accountId)
      return json({ ok: true, plan })
    }

    if (action === 'grant' || action === 'set') {
      const accountId = String(body?.account_id ?? '')
      const amount = Number(body?.amount ?? 0)
      if (!accountId || !Number.isFinite(amount)) return json({ error: 'account_id and amount required' }, 400)
      const fn = action === 'grant' ? 'add_token_balance' : 'set_token_balance'
      const { data, error } = await admin.rpc(fn, { p_account: accountId, p_amount: Math.round(amount) })
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true, balance: data })
    }

    if (action === 'create_gift') {
      const tokens = Math.round(Number(body?.tokens ?? 0))
      const count = Math.min(Math.max(Math.round(Number(body?.count ?? 1)), 1), 50)
      if (tokens <= 0) return json({ error: 'tokens must be > 0' }, 400)
      const rows = Array.from({ length: count }, () => ({ code: genCode(), tokens, created_by: user.id }))
      const { data, error } = await admin.from('gift_codes').insert(rows).select('code, tokens')
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true, codes: data })
    }

    if (action === 'list_gifts') {
      const { data } = await admin
        .from('gift_codes')
        .select('code, tokens, redeemed_by, redeemed_at, created_at')
        .order('created_at', { ascending: false })
        .limit(100)
      return json({ ok: true, gifts: data ?? [] })
    }

    return json({ error: 'unknown action' }, 400)
  } catch (e) {
    console.error('admin-api error:', e)
    return json({ error: 'failed', detail: String(e) }, 500)
  }
})
