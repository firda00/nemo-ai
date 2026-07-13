// Channel watch → auto-localize. Two callers:
//   • USER (Bearer jwt): add | list | remove | toggle | run_now | resolve | drafts | discard
//   • CRON (x-cron-secret): poll — for each active source, read its YouTube RSS feed;
//     on a NEW video, localize title+description into each chosen language as content_drafts,
//     and (if auto_publish + a Telegram target) publish the post to Telegram right away.
// YouTube only for now — its per-channel RSS feed is free and needs no API key.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { tgSend } from '../_shared/telegram.ts'
import { corsPreflight, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const CRON_SECRET = Deno.env.get('WATCH_CRON_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''

/* eslint-disable @typescript-eslint/no-explicit-any */
const LANG_NAME: Record<string, string> = {
  uz: 'Uzbek', ru: 'Russian', en: 'English', kk: 'Kazakh', ky: 'Kyrgyz', tg: 'Tajik',
  tr: 'Turkish', ar: 'Arabic', es: 'Spanish', pt: 'Portuguese', hi: 'Hindi', id: 'Indonesian',
  zh: 'Chinese (Simplified)', fr: 'French', de: 'German', it: 'Italian',
}
const MAX_LANGS = 12          // cost guard: never localize into more than this many languages
const CRON_SOURCE_CAP = 40    // cost guard: sources processed per cron tick

// ---- YouTube helpers (no API key) ----
const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']
function ytUrl(raw: string): URL | null {
  try { const u = new URL(raw.trim()); return YT_HOSTS.includes(u.hostname) ? u : null } catch { return null }
}
function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
// Resolve any YouTube channel/handle URL to a channel id (UC...). /channel/UC... is direct;
// @handle, /c/, /user/ are resolved by fetching the page and extracting channelId.
async function resolveChannelId(raw: string): Promise<{ channelId: string; title?: string } | null> {
  const u = ytUrl(raw)
  if (!u) return null
  const direct = u.pathname.match(/\/channel\/(UC[\w-]+)/)
  if (direct) return { channelId: direct[1] }
  try {
    const html = await fetch(u.toString(), { headers: { 'user-agent': 'Mozilla/5.0 (compatible; NemoBot/1.0)' } }).then((r) => r.ok ? r.text() : '')
    const cid = html.match(/"channelId":"(UC[\w-]+)"/) ?? html.match(/"externalId":"(UC[\w-]+)"/) ?? html.match(/channel\/(UC[\w-]+)/)
    const title = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1]
    if (cid) return { channelId: cid[1], title: title ? decodeXml(title) : undefined }
  } catch { /* ignore */ }
  return null
}
interface Vid { id: string; title: string; description: string; url: string; published: string }
async function fetchFeed(channelId: string): Promise<{ title?: string; videos: Vid[] }> {
  const xml = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`).then((r) => r.ok ? r.text() : '')
  const feedTitle = xml.match(/<title>([^<]+)<\/title>/)?.[1]
  const videos: Vid[] = []
  for (const e of xml.split('<entry>').slice(1)) {
    const id = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
    if (!id) continue
    videos.push({
      id,
      title: decodeXml(e.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''),
      description: decodeXml(e.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] ?? ''),
      url: `https://www.youtube.com/watch?v=${id}`,
      published: e.match(/<published>([^<]+)<\/published>/)?.[1] ?? '',
    })
  }
  return { title: feedTitle ? decodeXml(feedTitle) : undefined, videos }
}
// Pull a single video's title + description (for the manual "paste a video link" path).
async function resolveVideo(raw: string): Promise<{ title: string; description: string } | null> {
  const u = ytUrl(raw)
  if (!u) return null
  const vid = u.searchParams.get('v') ?? (u.hostname === 'youtu.be' ? u.pathname.slice(1) : '')
  if (!vid) return null
  try {
    const html = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; NemoBot/1.0)' } }).then((r) => r.ok ? r.text() : '')
    const title = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? html.match(/"title":"([^"]+)"/)?.[1] ?? ''
    let desc = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)?.[1] ?? html.match(/<meta property="og:description" content="([^"]+)"/)?.[1] ?? ''
    try { desc = JSON.parse('"' + desc + '"') } catch { /* keep raw */ }
    if (!title) return null
    return { title: decodeXml(title), description: decodeXml(desc).slice(0, 2000) }
  } catch { return null }
}

// Localize a new video's title+description into ONE ready-to-post announcement in `langCode`.
async function localizeVideo(apiKey: string, langCode: string, title: string, description: string, biz: string): Promise<{ text: string; tokens: number }> {
  const langName = LANG_NAME[langCode] ?? langCode
  const sys = `You are a native ${langName} social media copywriter. A creator just published a new video. From its title and description, write ONE short, ready-to-publish social post in ${langName} announcing the video. LOCALIZE (adapt idioms/hooks for a native audience, do not translate literally). 3-6 short lines, an engaging hook, one CTA to watch, 2-4 relevant hashtags. Output ONLY the finished post text — no preface, no quotes.` + biz
  const usr = `Video title: ${title}\n\nVideo description:\n"""\n${description.slice(0, 1500)}\n"""`
  const r = await callOpenRouter({ apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.6, maxTokens: 500, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }] })
  return { text: (r.content ?? '').trim(), tokens: r.tokens ?? 0 }
}

// Process one source: if its feed has a video newer than last_video_id, localize + store
// drafts (and auto-publish to Telegram when configured). `force` regenerates the latest
// video even if already seen (used by the "check now" button). Returns a short summary.
async function processSource(admin: any, src: any, force = false): Promise<{ drafts: number; published: number; video?: string; skipped?: string }> {
  if (src.kind !== 'youtube' || !src.external_id) return { drafts: 0, published: 0, skipped: 'no-channel' }
  const { videos } = await fetchFeed(src.external_id)
  const stamp = () => admin.from('watched_sources').update({ last_checked_at: new Date().toISOString() }).eq('id', src.id)
  if (!videos.length) { await stamp(); return { drafts: 0, published: 0, skipped: 'empty-feed' } }
  const newest = videos[0]
  if (!force && newest.id === src.last_video_id) { await stamp(); return { drafts: 0, published: 0, skipped: 'no-new' } }

  // account guards (never spend for a blocked / empty-balance account)
  const { data: acc } = await admin.from('accounts').select('token_balance, blocked').eq('id', src.account_id).maybeSingle()
  if (acc?.blocked || (acc && Number(acc.token_balance) <= 0)) {
    await admin.from('watched_sources').update({ last_video_id: newest.id, last_checked_at: new Date().toISOString() }).eq('id', src.id)
    return { drafts: 0, published: 0, skipped: 'no-tokens' }
  }
  const apiKey = await resolveOpenRouterKey(admin, src.account_id, OPENROUTER_API_KEY)
  if (!apiKey) { await stamp(); return { drafts: 0, published: 0, skipped: 'no-llm-key' } }

  const { data: bp } = await admin.from('business_profiles').select('name, industry, offerings, tone, audience, cities').eq('account_id', src.account_id).maybeSingle()
  const biz = bp ? '\n\nBusiness context (keep the copy true to it): ' + [bp.name, bp.industry, bp.offerings, bp.tone, bp.audience, bp.cities].filter(Boolean).join(' | ') : ''

  const langs: string[] = (Array.isArray(src.languages) && src.languages.length ? src.languages : ['en']).slice(0, MAX_LANGS)
  const wantTelegram = src.auto_publish && Array.isArray(src.platforms) && src.platforms.includes('telegram') && src.tg_channel_id && src.tg_target
  let botToken: string | undefined
  if (wantTelegram) {
    const { data: ch } = await admin.from('channels').select('credentials').eq('id', src.tg_channel_id).maybeSingle()
    botToken = ch?.credentials?.bot_token
  }

  let drafts = 0, published = 0, spent = 0
  for (const lang of langs) {
    let text = ''
    try { const g = await localizeVideo(apiKey, lang, newest.title, newest.description, biz); text = g.text; spent += g.tokens } catch { text = '' }
    if (!text) continue
    let publishedTo: string | null = null
    if (botToken) { try { if (await tgSend(botToken, src.tg_target, text)) { publishedTo = 'telegram'; published++ } } catch { /* ignore */ } }
    await admin.from('content_drafts').insert({
      account_id: src.account_id, source_id: src.id, video_id: newest.id, video_title: newest.title,
      video_url: newest.url, lang, content: text, status: publishedTo ? 'published' : 'draft', published_to: publishedTo,
    })
    drafts++
  }
  if (spent > 0) {
    await admin.from('usage').insert({ account_id: src.account_id, tokens: spent, model: PRIMARY_MODEL })
    await admin.rpc('decrement_token_balance', { p_account: src.account_id, p_amount: spent })
  }
  await admin.from('watched_sources').update({ last_video_id: newest.id, last_checked_at: new Date().toISOString() }).eq('id', src.id)
  return { drafts, published, video: newest.title }
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  // ---- CRON: poll all active sources ----
  if (action === 'poll') {
    const secret = req.headers.get('x-cron-secret')
    const auth = req.headers.get('Authorization') ?? ''
    if (!CRON_SECRET || (secret !== CRON_SECRET && auth !== `Bearer ${SERVICE_ROLE}`)) return new Response('forbidden', { status: 403 })
    const { data: sources } = await admin.from('watched_sources').select('*').eq('active', true).order('last_checked_at', { ascending: true, nullsFirst: true }).limit(CRON_SOURCE_CAP)
    let drafts = 0, published = 0, changed = 0
    for (const s of sources ?? []) {
      try { const r = await processSource(admin, s); drafts += r.drafts; published += r.published; if (r.drafts) changed++ } catch { /* skip one bad source */ }
    }
    return json({ ok: true, sources: sources?.length ?? 0, changed, drafts, published })
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

  // resolve a pasted link into source text (video → its title+desc; channel → latest video)
  if (action === 'resolve') {
    const url = String(body?.url ?? '').trim()
    if (!ytUrl(url)) return json({ ok: false, error: 'Пока поддерживается только ссылка на YouTube (видео или канал).' }, 200)
    const v = await resolveVideo(url)
    if (v) return json({ ok: true, title: v.title, description: v.description, source: [v.title, v.description].filter(Boolean).join('\n\n') })
    const ch = await resolveChannelId(url)
    if (ch) { const feed = await fetchFeed(ch.channelId); const latest = feed.videos[0]; if (latest) return json({ ok: true, title: latest.title, description: latest.description, source: [latest.title, latest.description].filter(Boolean).join('\n\n'), channel: true }) }
    return json({ ok: false, error: 'Не удалось прочитать ссылку. Проверьте, что это публичное видео или канал YouTube.' }, 200)
  }

  if (action === 'add') {
    const url = String(body?.url ?? '').trim()
    const languages = (Array.isArray(body?.languages) ? body.languages.map((x: any) => String(x)).filter(Boolean) : []).slice(0, MAX_LANGS)
    const platforms = (Array.isArray(body?.platforms) ? body.platforms.map((x: any) => String(x)).filter(Boolean) : []).slice(0, 8)
    const autoPublish = Boolean(body?.auto_publish)
    let tgChannelId = String(body?.tg_channel_id ?? '') || null
    const tgTarget = String(body?.tg_target ?? '').trim() || null
    if (!ytUrl(url)) return json({ ok: false, error: 'Вставьте ссылку на YouTube-канал.' }, 200)
    if (!languages.length) return json({ ok: false, error: 'Выберите хотя бы один язык.' }, 200)
    const ch = await resolveChannelId(url)
    if (!ch) return json({ ok: false, error: 'Не удалось определить канал по ссылке. Откройте канал на YouTube и скопируйте ссылку из адресной строки.' }, 200)
    // telegram auto-publish: only keep the bot/target when it's actually requested,
    // and verify the chosen bot belongs to this account.
    const tgWanted = autoPublish && platforms.includes('telegram')
    if (tgWanted && tgChannelId) {
      const { data: c } = await admin.from('channels').select('agent_id').eq('id', tgChannelId).maybeSingle()
      const { data: ag } = c?.agent_id ? await admin.from('agents').select('account_id').eq('id', c.agent_id).maybeSingle() : { data: null }
      if (!ag || ag.account_id !== accountId) return json({ ok: false, error: 'Выбранный Telegram-бот не найден в вашем аккаунте.' }, 200)
    }
    const tgChannelFinal = tgWanted ? tgChannelId : null
    const tgTargetFinal = tgWanted ? tgTarget : null
    // seed last_video_id with the current newest so we do NOT backfill old videos
    const feed = await fetchFeed(ch.channelId)
    const seed = feed.videos[0]?.id ?? null
    const { data, error } = await admin.from('watched_sources').insert({
      account_id: accountId, url, kind: 'youtube', external_id: ch.channelId, title: ch.title ?? feed.title ?? null,
      languages, platforms, auto_publish: autoPublish, tg_channel_id: tgChannelFinal, tg_target: tgTargetFinal, last_video_id: seed,
    }).select('id, title, external_id').single()
    if (error) return json({ ok: false, error: error.message }, 200)
    return json({ ok: true, source: data, videos: feed.videos.length })
  }

  if (action === 'list') {
    const { data } = await admin.from('watched_sources').select('id, url, title, external_id, languages, platforms, auto_publish, tg_target, active, last_checked_at, created_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(50)
    return json({ ok: true, sources: data ?? [] })
  }

  if (action === 'toggle') {
    const id = String(body?.id ?? '')
    const { data: s } = await admin.from('watched_sources').select('active').eq('id', id).eq('account_id', accountId).maybeSingle()
    if (!s) return json({ ok: false, error: 'not found' }, 200)
    await admin.from('watched_sources').update({ active: !s.active }).eq('id', id).eq('account_id', accountId)
    return json({ ok: true, active: !s.active })
  }

  if (action === 'remove') {
    const id = String(body?.id ?? '')
    await admin.from('watched_sources').delete().eq('id', id).eq('account_id', accountId)
    return json({ ok: true })
  }

  if (action === 'run_now') {
    const id = String(body?.id ?? '')
    const { data: src } = await admin.from('watched_sources').select('*').eq('id', id).eq('account_id', accountId).maybeSingle()
    if (!src) return json({ ok: false, error: 'not found' }, 200)
    try { const r = await processSource(admin, src, true); return json({ ok: true, ...r }) }
    catch (e) { return json({ ok: false, error: String(e).slice(0, 200) }, 200) }
  }

  if (action === 'drafts') {
    const sourceId = String(body?.source_id ?? '') || null
    let q = admin.from('content_drafts').select('id, source_id, video_title, video_url, lang, content, status, published_to, created_at').eq('account_id', accountId)
    if (sourceId) q = q.eq('source_id', sourceId)
    const { data } = await q.order('created_at', { ascending: false }).limit(60)
    return json({ ok: true, drafts: data ?? [] })
  }

  if (action === 'discard') {
    const id = String(body?.id ?? '')
    await admin.from('content_drafts').delete().eq('id', id).eq('account_id', accountId)
    return json({ ok: true })
  }

  return json({ error: 'unknown action' }, 400)
})
/* eslint-enable @typescript-eslint/no-explicit-any */
