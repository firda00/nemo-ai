// Platform admin API. The caller must be a platform admin (users.is_admin).
// Manages the token economy: list accounts, grant/set balances, create + list
// gift codes. All writes use the service_role client (bypasses RLS) AFTER the
// admin check, so a normal user can never reach these even with a forged body.
//
//   POST /functions/v1/admin-api   (Authorization: Bearer <admin jwt>)
//   body { "action": "list_accounts" | "grant" | "set" | "create_gift" | "list_gifts", ... }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

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
      return json({ ok: true, accounts: rows })
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
      await admin.auth.admin.updateUserById(userId, { ban_duration: banned ? '876000h' : 'none' })
      const { data: u } = await admin.from('users').select('account_id').eq('id', userId).single()
      if (u?.account_id) {
        await admin.from('accounts').update({ blocked: banned }).eq('id', u.account_id)
        if (banned) await admin.from('agents').update({ status: 'paused' }).eq('account_id', u.account_id)
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
