// Autoposting for Telegram. Two callers:
//   • USER (Bearer jwt): action 'schedule' | 'list' | 'cancel'  — manage own scheduled posts
//   • CRON (x-cron-secret): action 'run_due'                     — send everything due now
// A post is sent by a connected bot (channels.credentials.bot_token) to target_chat.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tgSendDetailed } from '../_shared/telegram.ts'
import { corsHeaders, json } from '../_shared/cors.ts'
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { twitterPost } from '../_shared/twitter.ts'
import { redditPost } from '../_shared/reddit.ts'
import { postFacebook, postInstagram } from '../_shared/metaPost.ts'

const ALL_PLATFORMS = ['telegram', 'facebook', 'instagram', 'twitter', 'reddit', 'tiktok', 'youtube']

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const FANOUT_CAP = 20 // max posts a single fan-out can queue (tie to plan later)

/* eslint-disable @typescript-eslint/no-explicit-any */
const LANG_NAMES: Record<string, string> = { uz: 'Uzbek', ru: 'Russian', en: 'English', kk: 'Kazakh', tr: 'Turkish', ar: 'Arabic', tg: 'Tajik', ky: 'Kyrgyz', es: 'Spanish', de: 'German', fr: 'French' }

function extractJson(text: string): any {
  const s = text.indexOf('{'); const e = text.lastIndexOf('}')
  if (s === -1 || e === -1 || e < s) return null
  try { return JSON.parse(text.slice(s, e + 1)) } catch { return null }
}

// Translate one post into several languages in a single call. Preserves tone, emojis, hashtags.
// Falls back to the original text for any language the model didn't return.
async function translateAll(apiKey: string, content: string, langs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const need = langs.filter((l) => l && l !== 'src')
  if (!need.length) return out
  const list = need.map((l) => `${l}=${LANG_NAMES[l] ?? l}`).join(', ')
  try {
    const r = await callOpenRouter({
      apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.3, maxTokens: 1600,
      messages: [
        { role: 'system', content: `Translate the user's social-media post into these languages: ${list}. Keep the tone, emojis, hashtags and line breaks. Respond ONLY as a JSON object mapping each language code to its translation, e.g. {"ru":"…","en":"…"}. No commentary.` },
        { role: 'user', content },
      ],
    })
    const j = extractJson(r.content) ?? {}
    for (const l of need) out[l] = (typeof j[l] === 'string' && j[l].trim()) ? j[l] : content
  } catch {
    for (const l of need) out[l] = content
  }
  return out
}
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
    // social creds per (account, platform), cached
    const socialCache = new Map<string, any>()
    const loadSocial = async (acc: string, plat: string) => {
      const key = `${acc}|${plat}`
      if (socialCache.has(key)) return socialCache.get(key)
      const { data } = await admin.from('social_accounts').select('access_token, page_id, ig_user_id, credentials').eq('account_id', acc).eq('platform', plat).maybeSingle()
      socialCache.set(key, data ?? null); return data ?? null
    }
    const loadMeta = (acc: string) => loadSocial(acc, 'meta')
    const setStatus = (id: string, ok: boolean, err?: string) =>
      admin.from('scheduled_posts').update(ok ? { status: 'posted', posted_at: new Date().toISOString() } : { status: 'failed', error: String(err ?? '').slice(0, 300) }).eq('id', id)

    let posted = 0
    for (const p of due) {
      const platform = p.platform ?? 'telegram'
      try {
        if (platform === 'telegram') {
          const token = p.channel_id ? tokenByChannel.get(p.channel_id) : undefined
          if (!token) { await setStatus(p.id, false, 'no bot token'); continue }
          const r = await tgSendDetailed(token, p.target_chat, p.content)
          await setStatus(p.id, r.ok, r.error ? `Telegram: ${r.error} (бот должен быть админом канала)` : 'telegram rejected (bot must be admin)'); if (r.ok) posted++
        } else if (platform === 'facebook') {
          const meta = await loadMeta(p.account_id)
          if (!meta?.access_token || !meta?.page_id) { await setStatus(p.id, false, 'Facebook не подключён'); continue }
          const res = await postFacebook(meta.page_id, meta.access_token, p.content, p.media_url)
          await setStatus(p.id, res.ok, res.error); if (res.ok) posted++
        } else if (platform === 'instagram') {
          const meta = await loadMeta(p.account_id)
          if (!meta?.access_token || !meta?.ig_user_id) { await setStatus(p.id, false, 'Instagram не подключён'); continue }
          const res = await postInstagram(meta.ig_user_id, meta.access_token, p.content, p.media_url)
          await setStatus(p.id, res.ok, res.error); if (res.ok) posted++
        } else if (platform === 'twitter') {
          const acc = await loadSocial(p.account_id, 'twitter')
          if (!acc?.credentials) { await setStatus(p.id, false, 'X (Twitter) не подключён'); continue }
          const res = await twitterPost(acc.credentials, p.content)
          await setStatus(p.id, res.ok, res.error); if (res.ok) posted++
        } else if (platform === 'reddit') {
          const acc = await loadSocial(p.account_id, 'reddit')
          if (!acc?.credentials) { await setStatus(p.id, false, 'Reddit не подключён'); continue }
          const title = (String(p.content).split('\n')[0] || p.content).slice(0, 120)
          const res = await redditPost(acc.credentials, title, p.content, p.target_chat || undefined) // target_chat = subreddit override
          await setStatus(p.id, res.ok, res.error); if (res.ok) posted++
        } else if (platform === 'tiktok' || platform === 'youtube') {
          await setStatus(p.id, false, `${platform === 'tiktok' ? 'TikTok' : 'YouTube'} ещё не подключён (нужен API-доступ платформы)`)
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
    const platform = ['telegram', 'facebook', 'instagram', 'twitter', 'reddit'].includes(String(body?.platform)) ? String(body.platform) : 'telegram'
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
    const platform = ['telegram', 'facebook', 'instagram', 'twitter', 'reddit'].includes(String(body?.platform)) ? String(body.platform) : 'telegram'
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
        const r = await tgSendDetailed(token, target, content)
        const errText = r.error ? `Telegram: ${r.error}. Добавьте бота в канал администратором.` : 'Telegram отклонил. Добавьте бота в канал администратором.'
        await logPost(r.ok, errText)
        return r.ok ? json({ ok: true }) : json({ ok: false, error: errText }, 200)
      }
      if (platform === 'twitter') {
        const { data: acc } = await admin.from('social_accounts').select('credentials').eq('account_id', accountId).eq('platform', 'twitter').maybeSingle()
        if (!acc?.credentials) { await logPost(false, 'X не подключён'); return json({ ok: false, error: 'Подключите X (Twitter) в разделе «Автопостинг».' }, 200) }
        const res = await twitterPost(acc.credentials, content)
        await logPost(res.ok, res.error); return res.ok ? json({ ok: true }) : json({ ok: false, error: res.error ?? 'X отклонил пост.' }, 200)
      }
      if (platform === 'reddit') {
        const { data: acc } = await admin.from('social_accounts').select('credentials').eq('account_id', accountId).eq('platform', 'reddit').maybeSingle()
        if (!acc?.credentials) { await logPost(false, 'Reddit не подключён'); return json({ ok: false, error: 'Подключите Reddit в разделе «Автопостинг».' }, 200) }
        const title = (content.split('\n')[0] || content).slice(0, 120)
        const res = await redditPost(acc.credentials, title, content, target || undefined)
        await logPost(res.ok, res.error); return res.ok ? json({ ok: true }) : json({ ok: false, error: res.error ?? 'Reddit отклонил пост.' }, 200)
      }
      // facebook / instagram via the account's Meta connection
      const { data: meta } = await admin.from('social_accounts').select('access_token, page_id, ig_user_id').eq('account_id', accountId).eq('platform', 'meta').maybeSingle()
      if (!meta?.access_token) { await logPost(false, 'Meta не подключён'); return json({ ok: false, error: 'Подключите Facebook/Instagram (раздел «Автопостинг»).' }, 200) }
      if (platform === 'facebook') {
        if (!meta.page_id) { await logPost(false, 'нет page_id'); return json({ ok: false, error: 'Facebook: не хватает Page ID.' }, 200) }
        const res = await postFacebook(meta.page_id, meta.access_token, content, mediaUrl)
        await logPost(res.ok, res.error); return res.ok ? json({ ok: true }) : json({ ok: false, error: res.error ?? 'Facebook отклонил.' }, 200)
      }
      // instagram (image or video/reels)
      if (!meta.ig_user_id) { await logPost(false, 'нет ig_user_id'); return json({ ok: false, error: 'Instagram: не хватает IG User ID.' }, 200) }
      const res = await postInstagram(meta.ig_user_id, meta.access_token, content, mediaUrl)
      await logPost(res.ok, res.error); return res.ok ? json({ ok: true }) : json({ ok: false, error: res.error ?? 'Instagram: ошибка публикации.' }, 200)
    } catch (e) {
      await logPost(false, String(e)); return json({ ok: false, error: `Ошибка отправки: ${String(e).slice(0, 200)}` }, 502)
    }
  }

  // ---- FAN-OUT: one post -> N languages x M platform targets (capped). Translates once,
  // then queues a scheduled_post per (language, target). Cron (run_due) publishes them. ----
  if (action === 'fanout') {
    const content = String(body?.content ?? '').trim()
    if (content.length < 2) return json({ ok: false, error: 'Пустой текст поста.' }, 200)
    const mediaUrl = String(body?.media_url ?? '').trim() || null
    const langs: string[] = Array.isArray(body?.languages) ? [...new Set(body.languages.map((x: any) => String(x)).filter(Boolean))].slice(0, 8) as string[] : []
    const languages = langs.length ? langs : ['src'] // 'src' = keep original, no translation
    const targets: any[] = Array.isArray(body?.targets) ? body.targets.slice(0, 12) : []
    if (!targets.length) return json({ ok: false, error: 'Выберите хотя бы одну платформу.' }, 200)
    const when = String(body?.scheduled_at ?? '').trim()
    const baseTs = when && !isNaN(Date.parse(when)) ? Date.parse(when) : Date.now()

    // validate targets belong to this account (telegram bot ownership); collect a normalized list
    const norm: { platform: string; channel_id: string | null; target_chat: string | null }[] = []
    for (const tg of targets) {
      const platform = ALL_PLATFORMS.includes(String(tg?.platform)) ? String(tg.platform) : 'telegram'
      let channelId = String(tg?.channel_id ?? '') || null
      const targetChat = String(tg?.target_chat ?? '').trim() || null
      if (platform === 'telegram') {
        if (!targetChat) return json({ ok: false, error: 'Для Telegram укажите канал-получатель (@channel).' }, 200)
        if (channelId) {
          const { data: ch } = await admin.from('channels').select('agent_id').eq('id', channelId).maybeSingle()
          const { data: ag } = ch?.agent_id ? await admin.from('agents').select('account_id').eq('id', ch.agent_id).maybeSingle() : { data: null }
          if (!ag || ag.account_id !== accountId) return json({ ok: false, error: 'Telegram-бот не найден в вашем аккаунте.' }, 200)
        }
      } else { channelId = null }
      norm.push({ platform, channel_id: channelId, target_chat: targetChat })
    }

    // translate once (unless single 'src')
    let byLang: Record<string, string> = {}
    if (languages.length === 1 && languages[0] === 'src') byLang = { src: content }
    else { const apiKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY); byLang = await translateAll(apiKey, content, languages); byLang.src = content }

    // build rows: (language x target), capped
    const rows: any[] = []
    const total = languages.length * norm.length
    outer: for (const t of norm) {
      for (const lang of languages) {
        if (rows.length >= FANOUT_CAP) break outer
        rows.push({
          account_id: accountId, channel_id: t.channel_id, target_chat: t.target_chat,
          content: byLang[lang] ?? content, media_url: mediaUrl, platform: t.platform,
          scheduled_at: new Date(baseTs).toISOString(), status: 'scheduled',
        })
      }
    }
    if (!rows.length) return json({ ok: false, error: 'Нечего публиковать.' }, 200)
    const { error } = await admin.from('scheduled_posts').insert(rows)
    if (error) return json({ ok: false, error: error.message }, 200)
    return json({ ok: true, queued: rows.length, capped: total > FANOUT_CAP, cap: FANOUT_CAP, languages: languages.filter((l) => l !== 'src').length || 1, targets: norm.length })
  }

  return json({ error: 'unknown action' }, 400)
})
/* eslint-enable @typescript-eslint/no-explicit-any */
