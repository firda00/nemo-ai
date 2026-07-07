// Connect a Meta (Facebook Page + Instagram Business) account for autoposting. The
// customer creates a Meta app, gets a Page access token + Page ID (+ IG user id), and
// pastes them here. Stored server-only (never read back). Used by autopost to publish.
//   POST /functions/v1/connect-social  (Bearer jwt)
//   { action:'connect', access_token, page_id, ig_user_id? } | { action:'status' } | { action:'disconnect' }
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
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  if (action === 'status') {
    const { data } = await admin.from('social_accounts').select('platform, page_id, ig_user_id, label').eq('account_id', accountId).eq('platform', 'meta').maybeSingle()
    return json({ ok: true, connected: Boolean(data), page_id: data?.page_id ?? null, ig_user_id: data?.ig_user_id ?? null, label: data?.label ?? null })
  }

  if (action === 'disconnect') {
    await admin.from('social_accounts').delete().eq('account_id', accountId).eq('platform', 'meta')
    return json({ ok: true, connected: false })
  }

  if (action === 'connect') {
    const token = String(body?.access_token ?? '').trim()
    const pageId = String(body?.page_id ?? '').trim()
    const igUserId = String(body?.ig_user_id ?? '').trim()
    if (token.length < 20) return json({ ok: false, error: 'Вставьте корректный Page Access Token.' }, 200)
    if (!pageId) return json({ ok: false, error: 'Укажите Page ID (ID страницы Facebook).' }, 200)
    // validate the token against Meta
    try {
      const me = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`).then((r) => r.json())
      if (me?.error) return json({ ok: false, error: me.error?.message ?? 'Meta отклонила токен.' }, 200)
      await admin.from('social_accounts').upsert({ account_id: accountId, platform: 'meta', access_token: token, page_id: pageId, ig_user_id: igUserId || null, label: me?.name ?? null }, { onConflict: 'account_id,platform' })
      return json({ ok: true, connected: true, page_id: pageId, ig_user_id: igUserId || null, label: me?.name ?? null })
    } catch {
      return json({ ok: false, error: 'Не удалось проверить токен (сеть).' }, 502)
    }
  }

  return json({ error: 'unknown action' }, 400)
})
