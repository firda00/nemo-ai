// Connect a social account for autoposting: Meta (FB Page + IG), Twitter/X, or Reddit. The customer
// brings their own keys and pastes them here; stored server-only (never read back). Used by autopost.
//   POST /functions/v1/connect-social  (Bearer jwt)
//   { action:'status' }                              -> connected state per platform
//   { action:'disconnect', platform }                -> remove that platform
//   { action:'connect', platform:'meta', access_token, page_id, ig_user_id? }
//   { action:'connect', platform:'twitter', api_key, api_secret, access_token, access_secret }
//   { action:'connect', platform:'reddit', client_id, client_secret, username, password, subreddit? }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { twitterVerify } from '../_shared/twitter.ts'
import { redditVerify } from '../_shared/reddit.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

/* eslint-disable @typescript-eslint/no-explicit-any */
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
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')
  const platform = String(body?.platform ?? 'meta')

  if (action === 'status') {
    const { data: rows, error } = await admin.from('social_accounts').select('platform, page_id, ig_user_id, label, credentials').eq('account_id', accountId)
    if (error) return json({ ok: false, error: error.message }, 500)
    const by = (p: string) => (rows ?? []).find((r: any) => r.platform === p)
    const meta = by('meta'), tw = by('twitter'), rd = by('reddit')
    return json({
      ok: true,
      connected: Boolean(meta), page_id: meta?.page_id ?? null, ig_user_id: meta?.ig_user_id ?? null, label: meta?.label ?? null,
      meta: { connected: Boolean(meta), page_id: meta?.page_id ?? null, ig_user_id: meta?.ig_user_id ?? null, label: meta?.label ?? null },
      twitter: { connected: Boolean(tw), label: tw?.label ?? null },
      reddit: { connected: Boolean(rd), label: rd?.label ?? null, subreddit: rd?.credentials?.subreddit ?? null },
    })
  }

  if (action === 'disconnect') {
    const p = ['meta', 'twitter', 'reddit'].includes(platform) ? platform : 'meta'
    const { error } = await admin.from('social_accounts').delete().eq('account_id', accountId).eq('platform', p)
    if (error) return json({ ok: false, error: error.message }, 500)
    return json({ ok: true, connected: false })
  }

  if (action === 'connect') {
    // ---- Twitter / X (OAuth 1.0a BYO 4 keys) ----
    if (platform === 'twitter') {
      const keys = {
        api_key: String(body?.api_key ?? '').trim(),
        api_secret: String(body?.api_secret ?? '').trim(),
        access_token: String(body?.access_token ?? '').trim(),
        access_secret: String(body?.access_secret ?? '').trim(),
      }
      if (Object.values(keys).some((v) => v.length < 10)) return json({ ok: false, error: 'Заполните все 4 ключа X (API Key/Secret, Access Token/Secret).' }, 200)
      const v = await twitterVerify(keys)
      if (!v.ok) return json({ ok: false, error: v.error ?? 'X отклонил ключи.' }, 200)
      const { error } = await admin.from('social_accounts').upsert({ account_id: accountId, platform: 'twitter', credentials: keys, label: v.username ? '@' + v.username : null }, { onConflict: 'account_id,platform' })
      if (error) return json({ ok: false, error: error.message }, 500)
      return json({ ok: true, connected: true, label: v.username ? '@' + v.username : null })
    }

    // ---- Reddit (script app BYO creds) ----
    if (platform === 'reddit') {
      const keys = {
        client_id: String(body?.client_id ?? '').trim(),
        client_secret: String(body?.client_secret ?? '').trim(),
        username: String(body?.username ?? '').trim(),
        password: String(body?.password ?? '').trim(),
        subreddit: String(body?.subreddit ?? '').replace(/^\/?r\//, '').trim() || undefined,
      }
      if (!keys.client_id || !keys.client_secret || !keys.username || !keys.password) return json({ ok: false, error: 'Заполните client_id, client_secret, логин и пароль Reddit.' }, 200)
      const v = await redditVerify(keys)
      if (!v.ok) return json({ ok: false, error: v.error ?? 'Reddit отклонил.' }, 200)
      const { error } = await admin.from('social_accounts').upsert({ account_id: accountId, platform: 'reddit', credentials: keys, label: keys.username }, { onConflict: 'account_id,platform' })
      if (error) return json({ ok: false, error: error.message }, 500)
      return json({ ok: true, connected: true, label: keys.username, subreddit: keys.subreddit ?? null })
    }

    // ---- Meta (Facebook Page + Instagram) ----
    const token = String(body?.access_token ?? '').trim()
    const pageId = String(body?.page_id ?? '').trim()
    const igUserId = String(body?.ig_user_id ?? '').trim()
    if (token.length < 20) return json({ ok: false, error: 'Вставьте корректный Page Access Token.' }, 200)
    if (!pageId) return json({ ok: false, error: 'Укажите Page ID (ID страницы Facebook).' }, 200)
    try {
      const me = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`).then((r) => r.json())
      if (me?.error) return json({ ok: false, error: me.error?.message ?? 'Meta отклонила токен.' }, 200)
      const { error } = await admin.from('social_accounts').upsert({ account_id: accountId, platform: 'meta', access_token: token, page_id: pageId, ig_user_id: igUserId || null, label: me?.name ?? null }, { onConflict: 'account_id,platform' })
      if (error) return json({ ok: false, error: error.message }, 500)
      return json({ ok: true, connected: true, page_id: pageId, ig_user_id: igUserId || null, label: me?.name ?? null })
    } catch {
      return json({ ok: false, error: 'Не удалось проверить токен (сеть).' }, 502)
    }
  }

  return json({ error: 'unknown action' }, 400)
})
/* eslint-enable @typescript-eslint/no-explicit-any */
