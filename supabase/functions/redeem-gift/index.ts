// Redeem a gift code — any authenticated user adds the code's tokens to their
// own account. Uses service_role to read/mark the code (clients can't touch
// gift_codes directly) and credits the caller's account atomically-ish.
//
//   POST /functions/v1/redeem-gift   (Authorization: Bearer <user jwt>)
//   body { "code": "NEMO-XXXX-XXXX" }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const { code } = await req.json().catch(() => ({}))
  const trimmed = String(code ?? '').trim().toUpperCase()
  if (!trimmed) return json({ error: 'code required' }, 400)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: prof } = await admin.from('users').select('account_id').eq('id', user.id).single()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const { data: gift } = await admin.from('gift_codes').select('id, tokens, redeemed_by').eq('code', trimmed).single()
  if (!gift) return json({ error: 'invalid_code' }, 404)
  if (gift.redeemed_by) return json({ error: 'already_redeemed' }, 409)

  // claim the code (guard on still-unredeemed to avoid double-spend)
  const { data: claimed } = await admin
    .from('gift_codes')
    .update({ redeemed_by: user.id, redeemed_at: new Date().toISOString() })
    .eq('id', gift.id)
    .is('redeemed_by', null)
    .select('id')
    .single()
  if (!claimed) return json({ error: 'already_redeemed' }, 409)

  const { data: balance } = await admin.rpc('add_token_balance', { p_account: accountId, p_amount: gift.tokens })
  return json({ ok: true, added: gift.tokens, balance })
})
