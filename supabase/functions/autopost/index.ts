// Autoposting for Telegram. Two callers:
//   • USER (Bearer jwt): action 'schedule' | 'list' | 'cancel'  — manage own scheduled posts
//   • CRON (x-cron-secret): action 'run_due'                     — send everything due now
// A post is sent by a connected bot (channels.credentials.bot_token) to target_chat.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tgSend } from '../_shared/telegram.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

/* eslint-disable @typescript-eslint/no-explicit-any */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  // ---- CRON: send everything due ----
  if (action === 'run_due') {
    const secret = req.headers.get('x-cron-secret')
    const auth = req.headers.get('Authorization') ?? ''
    if (!CRON_SECRET || (secret !== CRON_SECRET && auth !== `Bearer ${SERVICE_ROLE}`)) return new Response('forbidden', { status: 403 })
    const nowIso = new Date().toISOString()
    const { data: due } = await admin.from('scheduled_posts')
      .select('id, account_id, channel_id, target_chat, content, media_url, platform').eq('status', 'scheduled').lte('scheduled_at', nowIso).limit(50)
    if (!due?.length) return json({ ok: true, posted: 0 })
    // telegram bot tokens per channel
    const ids = [...new Set(due.filter((p) => (p.platform ?? 'telegram') === 'telegram').map((p) => p.channel_id).filter(Boolean))]
    const tokenByChannel = new Map<string, string>()
    if (ids.length) {
      const { data: chs } = await admin.from('channels').select('id, credentials').in('id', ids)
      for (const c of chs ?? []) if (c.credentials?.bot_token) tokenByChannel.set(c.id, c.credentials.bot_token)
    }
    // meta (fb/ig) creds per account (cached)
    const metaByAccount = new Map<string, any>()
    const loadMeta = async (acc: string) => {
      if (metaByAccount.has(acc)) return metaByAccount.get(acc)
      const { data } = await admin.from('social_accounts').select('access_token, page_id, ig_user_id').eq('account_id', acc).eq('platform', 'meta').maybeSingle()
      metaByAccount.set(acc, data ?? null); return data ?? null
    }
    const setStatus = (id: string, ok: boolean, err?: string) =>
      admin.from('scheduled_posts').update(ok ? { status: 'posted', posted_at: new Date().toISOString() } : { status: 'failed', error: String(err ?? '').slice(0, 300) }).eq('id', id)

    let posted = 0
    for (const p of due) {
      const platform = p.platform ?? 'telegram'
      try {
        if (platform === 'telegram') {
          const token = p.channel_id ? tokenByChannel.get(p.channel_id) : undefined
          if (!token) { await setStatus(p.id, false, 'no bot token'); continue }
          const ok = await tgSend(token, p.target_chat, p.content)
          await setStatus(p.id, ok, 'telegram rejected (bot must be admin)'); if (ok) posted++
        } else if (platform === 'facebook') {
          const meta = await loadMeta(p.account_id)
          if (!meta?.access_token || !meta?.page_id) { await setStatus(p.id, false, 'Facebook не подключён'); continue }
          const url = `https://graph.facebook.com/v19.0/${meta.page_id}/${p.media_url ? 'photos' : 'feed'}`
          const params = p.media_url ? { url: p.media_url, caption: p.content, access_token: meta.access_token } : { message: p.content, access_token: meta.access_token }
          const r = await fetch(url, { method: 'POST', body: new URLSearchParams(params) }).then((x) => x.json())
          if (r?.id || r?.post_id) { await setStatus(p.id, true); posted++ } else await setStatus(p.id, false, r?.error?.message ?? 'Facebook отклонил')
        } else if (platform === 'instagram') {
          const meta = await loadMeta(p.account_id)
          if (!meta?.access_token || !meta?.ig_user_id) { await setStatus(p.id, false, 'Instagram не подключён'); continue }
          if (!p.media_url) { await setStatus(p.id, false, 'Instagram требует картинку (ссылку на media)'); continue }
          const create = await fetch(`https://graph.facebook.com/v19.0/${meta.ig_user_id}/media`, { method: 'POST', body: new URLSearchParams({ image_url: p.media_url, caption: p.content, access_token: meta.access_token }) }).then((x) => x.json())
          if (!create?.id) { await setStatus(p.id, false, create?.error?.message ?? 'IG: ошибка загрузки'); continue }
          const pub = await fetch(`https://graph.facebook.com/v19.0/${meta.ig_user_id}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: create.id, access_token: meta.access_token }) }).then((x) => x.json())
          if (pub?.id) { await setStatus(p.id, true); posted++ } else await setStatus(p.id, false, pub?.error?.message ?? 'IG: ошибка публикации')
        } else { await setStatus(p.id, false, 'unknown platform') }
      } catch (e) {
        await setStatus(p.id, false, String(e))
      }
    }
    return json({ ok: true, posted })
  }

  // ---- USER actions ----
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  if (action === 'list') {
    const { data } = await admin.from('scheduled_posts')
      .select('id, target_chat, content, scheduled_at, status, posted_at, error, channel_id, platform')
      .eq('account_id', accountId).order('scheduled_at', { ascending: false }).limit(50)
    return json({ ok: true, posts: data ?? [] })
  }

  if (action === 'cancel') {
    const id = String(body?.id ?? '')
    await admin.from('scheduled_posts').update({ status: 'canceled' }).eq('id', id).eq('account_id', accountId).eq('status', 'scheduled')
    return json({ ok: true })
  }

  if (action === 'schedule') {
    const platform = ['telegram', 'facebook', 'instagram'].includes(String(body?.platform)) ? String(body.platform) : 'telegram'
    const channelId = String(body?.channel_id ?? '') || null
    const target = String(body?.target_chat ?? '').trim()
    const content = String(body?.content ?? '').trim()
    const mediaUrl = String(body?.media_url ?? '').trim() || null
    const when = String(body?.scheduled_at ?? '').trim()
    if (platform === 'telegram' && !target) return json({ ok: false, error: 'Укажите канал-получатель (@username канала).' }, 200)
    if (platform === 'instagram' && !mediaUrl) return json({ ok: false, error: 'Instagram требует картинку — вставьте ссылку на изображение (media_url).' }, 200)
    if (content.length < 2) return json({ ok: false, error: 'Пустой текст поста.' }, 200)
    const ts = Date.parse(when)
    if (isNaN(ts)) return json({ ok: false, error: 'Некорректные дата/время.' }, 200)
    // verify the chosen bot belongs to this account (channels scope via agents.account_id)
    if (channelId) {
      const { data: ch } = await admin.from('channels').select('agent_id').eq('id', channelId).maybeSingle()
      const agentId = ch?.agent_id
      const { data: ag } = agentId ? await admin.from('agents').select('account_id').eq('id', agentId).maybeSingle() : { data: null }
      if (!ag || ag.account_id !== accountId) return json({ ok: false, error: 'Бот не найден в вашем аккаунте.' }, 200)
    }
    const { data, error } = await admin.from('scheduled_posts')
      .insert({ account_id: accountId, channel_id: channelId, target_chat: target || null, content, media_url: mediaUrl, platform, scheduled_at: new Date(ts).toISOString() })
      .select('id').single()
    if (error) return json({ ok: false, error: error.message }, 200)
    return json({ ok: true, id: data?.id })
  }

  // ---- SEND NOW: publish a post immediately (Telegram / Facebook / Instagram) ----
  if (action === 'send_now') {
    const platform = ['telegram', 'facebook', 'instagram'].includes(String(body?.platform)) ? String(body.platform) : 'telegram'
    const channelId = String(body?.channel_id ?? '') || null
    const target = String(body?.target_chat ?? '').trim()
    const content = String(body?.content ?? '').trim()
    const mediaUrl = String(body?.media_url ?? '').trim() || null
    if (content.length < 2) return json({ ok: false, error: 'Пустой текст поста.' }, 200)

    const logPost = (ok: boolean, err?: string) =>
      admin.from('scheduled_posts').insert({
        account_id: accountId, channel_id: channelId, target_chat: target || null, content, media_url: mediaUrl, platform,
        scheduled_at: new Date().toISOString(), status: ok ? 'posted' : 'failed',
        posted_at: ok ? new Date().toISOString() : null, error: ok ? null : String(err ?? '').slice(0, 300),
      })

    try {
      if (platform === 'telegram') {
        if (!target) return json({ ok: false, error: 'Укажите канал-получатель (@username канала).' }, 200)
        if (!channelId) return json({ ok: false, error: 'Выберите бота-отправителя (подключите бота в командах).' }, 200)
        // verify the bot belongs to this account (channels scope via agents.account_id) + get token
        const { data: ch } = await admin.from('channels').select('agent_id, credentials').eq('id', channelId).maybeSingle()
        const agentId = ch?.agent_id
        const { data: ag } = agentId ? await admin.from('agents').select('account_id').eq('id', agentId).maybeSingle() : { data: null }
        if (!ag || ag.account_id !== accountId) return json({ ok: false, error: 'Бот не найден в вашем аккаунте.' }, 200)
        const token = ch?.credentials?.bot_token
        if (!token) return json({ ok: false, error: 'У бота нет токена — переподключите его.' }, 200)
        const ok = await tgSend(token, target, content)
        await logPost(ok, 'Telegram отклонил (бот должен быть админом канала).')
        return ok ? json({ ok: true }) : json({ ok: false, error: 'Telegram отклонил. Добавьте бота в канал администратором.' }, 200)
      }
      // facebook / instagram via the account's Meta connection
      const { data: meta } = await admin.from('social_accounts').select('access_token, page_id, ig_user_id').eq('account_id', accountId).eq('platform', 'meta').maybeSingle()
      if (!meta?.access_token) { await logPost(false, 'Meta не подключён'); return json({ ok: false, error: 'Подключите Facebook/Instagram (раздел «Автопостинг»).' }, 200) }
      if (platform === 'facebook') {
        if (!meta.page_id) { await logPost(false, 'нет page_id'); return json({ ok: false, error: 'Facebook: не хватает Page ID.' }, 200) }
        const url = `https://graph.facebook.com/v19.0/${meta.page_id}/${mediaUrl ? 'photos' : 'feed'}`
        const params = mediaUrl ? { url: mediaUrl, caption: content, access_token: meta.access_token } : { message: content, access_token: meta.access_token }
        const r = await fetch(url, { method: 'POST', body: new URLSearchParams(params) }).then((x) => x.json())
        const ok = Boolean(r?.id || r?.post_id)
        await logPost(ok, r?.error?.message ?? 'Facebook отклонил'); return ok ? json({ ok: true }) : json({ ok: false, error: r?.error?.message ?? 'Facebook отклонил.' }, 200)
      }
      // instagram
      if (!meta.ig_user_id) { await logPost(false, 'нет ig_user_id'); return json({ ok: false, error: 'Instagram: не хватает IG User ID.' }, 200) }
      if (!mediaUrl) { await logPost(false, 'нет картинки'); return json({ ok: false, error: 'Instagram требует картинку — вставьте ссылку на изображение.' }, 200) }
      const create = await fetch(`https://graph.facebook.com/v19.0/${meta.ig_user_id}/media`, { method: 'POST', body: new URLSearchParams({ image_url: mediaUrl, caption: content, access_token: meta.access_token }) }).then((x) => x.json())
      if (!create?.id) { await logPost(false, create?.error?.message ?? 'IG: ошибка загрузки'); return json({ ok: false, error: create?.error?.message ?? 'Instagram: ошибка загрузки.' }, 200) }
      const pub = await fetch(`https://graph.facebook.com/v19.0/${meta.ig_user_id}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: create.id, access_token: meta.access_token }) }).then((x) => x.json())
      const ok = Boolean(pub?.id)
      await logPost(ok, pub?.error?.message ?? 'IG: ошибка публикации'); return ok ? json({ ok: true }) : json({ ok: false, error: pub?.error?.message ?? 'Instagram: ошибка публикации.' }, 200)
    } catch (e) {
      await logPost(false, String(e)); return json({ ok: false, error: `Ошибка отправки: ${String(e).slice(0, 200)}` }, 502)
    }
  }

  return json({ error: 'unknown action' }, 400)
})
/* eslint-enable @typescript-eslint/no-explicit-any */
