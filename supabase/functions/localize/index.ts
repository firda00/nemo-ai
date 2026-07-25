// Multi-language content factory: turn ONE source post/script into a ready-to-publish
// post in a target language, adapted to a target platform's norms. The panel calls this
// once per (language x platform) cell and renders a grid; images come from content-visual,
// Telegram delivery from autopost — both reused as-is.
//
//   POST /functions/v1/localize   (Bearer jwt)
//   { action:'post', source, lang, platform, goal? } -> { ok, post, tokens }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, estimateCostUsd, PRIMARY_MODEL, FALLBACK_MODEL, type ChatMsg } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { corsPreflight, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

// human name so the model writes idiomatic, not "translated", copy
const LANG_NAME: Record<string, string> = {
  uz: 'Uzbek', ru: 'Russian', en: 'English', kk: 'Kazakh', ky: 'Kyrgyz', tg: 'Tajik',
  tr: 'Turkish', ar: 'Arabic', es: 'Spanish', pt: 'Portuguese', hi: 'Hindi', id: 'Indonesian',
  zh: 'Chinese (Simplified)', fr: 'French', de: 'German', it: 'Italian', ja: 'Japanese',
  ko: 'Korean', fa: 'Persian', ur: 'Urdu', az: 'Azerbaijani', uk: 'Ukrainian', vi: 'Vietnamese',
  th: 'Thai', pl: 'Polish',
}

// per-platform copy norms so each post fits where it lands (not one caption everywhere)
const PLATFORM_RULE: Record<string, string> = {
  instagram: 'Instagram caption: a strong first line hook, 3-6 short lines, an emoji or two, a clear CTA, then 8-15 relevant hashtags on a new line.',
  tiktok: 'TikTok caption: very short and punchy, 1-2 lines, a curiosity hook, 3-6 trending-style hashtags. Casual, native slang for the language.',
  telegram: 'Telegram post: 3-6 lines, conversational, one clear CTA, no hashtag spam (1-2 max), can include a link placeholder.',
  x: 'X/Twitter post: under 280 characters, one sharp idea, a hook, at most 2 hashtags.',
  youtube: 'YouTube: give a clickable Title (<=70 chars) on the first line, then a Description of 2-4 sentences with a CTA and 3-5 tags.',
  reddit: 'Reddit: a plain, non-salesy Title on the first line, then a genuine, community-first body. No marketing hype, no emojis, no hashtags.',
  facebook: 'Facebook post: 2-4 sentences, friendly, one CTA, 0-3 hashtags.',
}

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
  const { data: acc } = await admin.from('accounts').select('token_balance, blocked').eq('id', accountId).single()
  if (acc?.blocked) return json({ error: 'blocked' }, 403)
  if (acc && Number(acc.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)

  const body = await req.json().catch(() => ({}))
  const source = String(body?.source ?? '').trim().slice(0, 4000)
  const langCode = String(body?.lang ?? '').trim().toLowerCase()
  const platform = String(body?.platform ?? 'telegram').trim().toLowerCase()
  const goal = String(body?.goal ?? '').trim().slice(0, 400)
  if (!source) return json({ error: 'source required' }, 400)
  const langName = LANG_NAME[langCode] ?? langCode ?? 'the same language'
  const platRule = PLATFORM_RULE[platform] ?? PLATFORM_RULE.telegram

  const orKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
  if (!orKey) return json({ ok: false, code: 'MISSING_PROVIDER_SECRET', message: 'LLM-ключ не настроен.' }, 503)

  // business profile so the localized copy stays grounded in the real business
  const { data: bp } = await admin.from('business_profiles').select('name, industry, offerings, tone, audience, cities').eq('account_id', accountId).maybeSingle()
  const biz = bp
    ? '\n\nBusiness context (keep the copy true to it): ' + [bp.name, bp.industry, bp.offerings, bp.tone, bp.audience, bp.cities].filter(Boolean).join(' | ')
    : ''

  const sys =
    `You are a native ${langName} social media copywriter and localizer. Rewrite the source content as ONE ready-to-publish post in ${langName}. ` +
    'LOCALIZE, do not translate literally: adapt idioms, hooks, examples and tone so it reads like it was written by a native for that audience. ' +
    `Adapt it to the platform: ${platRule} ` +
    'Keep the core message, offer and any concrete facts. Output ONLY the finished post text (no preface, no explanation, no quotes).' + biz
  const usr = `${goal ? `Goal of the post: ${goal}\n\n` : ''}Source content:\n"""\n${source}\n"""`

  const msgs: ChatMsg[] = [{ role: 'system', content: sys }, { role: 'user', content: usr }]
  try {
    const r = await callOpenRouter({ apiKey: orKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.6, maxTokens: 700, messages: msgs })
    const post = (r.content ?? '').trim()
    if (r.tokens) {
      await admin.from('usage').insert({ account_id: accountId, tokens: r.tokens, model: PRIMARY_MODEL, cost: estimateCostUsd(PRIMARY_MODEL, r.tokens) })
      await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: r.tokens })
    }
    if (!post) return json({ ok: false, error: 'empty' }, 502)
    return json({ ok: true, post, lang: langCode, platform, tokens: r.tokens })
  } catch (e) {
    return json({ ok: false, error: String(e).slice(0, 200) }, 502)
  }
})
