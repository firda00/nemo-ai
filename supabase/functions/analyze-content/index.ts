// Autonomous COMPETITOR / VIRAL analysis crew. The customer drops a profile/video link
// (+ its subtitles/caption/metrics when available) and a goal; a crew of agents runs
// AUTONOMOUSLY server-side — Analyst breaks the content down, a Retention predictor
// estimates the attention curve (clearly an AI PREDICTION, not private analytics), and a
// Strategist turns it into a ready content plan grounded in the customer's own business.
//   POST /functions/v1/analyze-content  (Bearer jwt)
//   { platform, url?, handle?, transcript?, caption?, metrics?, goal? } -> { ok, analysis, retention, plan, id }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL, type ChatMsg } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { corsPreflight, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

// A) Auto-pull signals from a link so the customer doesn't paste subtitles by hand.
// OpenRouter can't transcribe audio, but YouTube exposes caption tracks and most pages
// expose an OG description — we use those. Best-effort; never throws.
async function fetchPageSignals(url: string): Promise<{ caption: string; transcript: string; thumbnail: string }> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NemoBot/1.0)' } })
    const html = await res.text()
    const og = (p: string): string => { const m = html.match(new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']+)["']`, 'i')); return m ? m[1] : '' }
    const caption = (og('description') || (html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? '')).slice(0, 2000)
    const thumbnail = og('image')
    let transcript = ''
    const ct = html.match(/"captionTracks":(\[.*?\])/)
    if (ct) {
      try {
        const tracks = JSON.parse(ct[1].replace(/\\u0026/g, '&'))
        const base = tracks?.[0]?.baseUrl
        if (base) {
          const xml = await fetch(base).then((r) => r.text())
          transcript = xml.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, 8000)
        }
      } catch (_e) { /* ignore */ }
    }
    return { caption, transcript, thumbnail }
  } catch (_e) { return { caption: '', transcript: '', thumbnail: '' } }
}

// Vision: let an agent LOOK at a frame/cover image the customer provides (OpenRouter vision model).
async function visionDescribe(orKey: string, imageUrl: string): Promise<string> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://nemo.ai', 'X-Title': 'Nemo AI' },
      body: JSON.stringify({ model: 'google/gemini-2.5-flash', max_tokens: 320, messages: [{ role: 'user', content: [{ type: 'text', text: 'Опиши, что на этом кадре видео: сцена, люди, текст на экране, композиция, стиль, настроение. Кратко и по делу, на русском.' }, { type: 'image_url', image_url: { url: imageUrl } }] }] }),
    })
    const data = await r.json()
    return String(data?.choices?.[0]?.message?.content ?? '').trim().slice(0, 800)
  } catch (_e) { return '' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function businessBlock(admin: any, accountId: string): Promise<string> {
  const { data } = await admin.from('business_profiles').select('*').eq('account_id', accountId).maybeSingle()
  if (!data) return ''
  const rows: [string, unknown][] = [['Компания', data.name], ['Сфера', data.industry], ['О компании', data.about], ['Аудитория', data.audience], ['Продукты/услуги', data.offerings], ['Тон', data.tone], ['Города', data.cities]]
  const filled = rows.filter(([, v]) => v && String(v).trim())
  return filled.length ? '\n\n=== БИЗНЕС КЛИЕНТА (адаптируй план под него, не копируй тему конкурента) ===\n' + filled.map(([k, v]) => `${k}: ${String(v).trim()}`).join('\n') : ''
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
  const platform = String(body?.platform ?? 'Instagram')
  const url = String(body?.url ?? '').trim()
  const handle = String(body?.handle ?? '').trim()
  let transcript = String(body?.transcript ?? '').trim().slice(0, 8000)
  let caption = String(body?.caption ?? '').trim().slice(0, 2000)
  const metrics = String(body?.metrics ?? '').trim().slice(0, 500)
  const goal = String(body?.goal ?? '').trim().slice(0, 600)
  const imageUrl = String(body?.image_url ?? '').trim()
  if (!transcript && !caption && !url && !handle && !imageUrl) return json({ ok: false, error: 'Дайте ссылку, субтитры/подпись или кадр контента для анализа.' }, 200)

  const orKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
  if (!orKey) return json({ ok: false, code: 'MISSING_PROVIDER_SECRET', message: 'LLM-ключ не настроен.' }, 503)
  const biz = await businessBlock(admin, accountId)

  // A) auto-pull subtitles/caption from the link (so no manual pasting), and let an agent LOOK at a frame
  if (!transcript && url) {
    const sig = await fetchPageSignals(url)
    if (sig.transcript) transcript = sig.transcript
    if (!caption && sig.caption) caption = sig.caption
  }
  const frameNote = imageUrl ? await visionDescribe(orKey, imageUrl) : ''

  const material =
    `Платформа: ${platform}\n` +
    (handle ? `Автор/конкурент: ${handle}\n` : '') +
    (url ? `Ссылка: ${url}\n` : '') +
    (caption ? `Подпись/описание:\n${caption}\n` : '') +
    (metrics ? `Метрики (лайки/просмотры/комменты): ${metrics}\n` : '') +
    (frameNote ? `Что видно на кадре (посмотрел ИИ): ${frameNote}\n` : '') +
    (transcript ? `Субтитры/транскрипт видео:\n"""\n${transcript}\n"""\n` : 'Субтитров нет — анализ по подписи/метрикам/кадру будет ограничен, честно укажи это.\n') +
    (goal ? `\nЦель клиента: ${goal}` : '')

  let tokens = 0
  const langRule = 'Отвечай на русском.'
  try {
    // 1) ANALYST — breaks the content down
    const a = await callOpenRouter({
      apiKey: orKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.3, maxTokens: 1100,
      messages: [
        { role: 'system', content: 'Ты — старший контент-аналитик. Разбери контент конкурента ПО КОСТОЧКАМ, опираясь на субтитры/подпись/метрики. Дай по пунктам: 1) Хук (0–3 сек) — что именно цепляет и почему; 2) Структура и ритм (по сценам/секундам, насколько видно из субтитров); 3) Приёмы удержания и триггеры вовлечения; 4) Призыв (CTA); 5) Что сильно и что слабо. Конкретно, с цитатами из материала. Если субтитров нет — честно скажи, что разбор ограничен, и попроси субтитры. ' + langRule },
        { role: 'user', content: material },
      ],
    })
    tokens += a.tokens
    const analysis = a.content

    // 2) RETENTION PREDICTOR — AI prediction, explicitly labeled
    const r = await callOpenRouter({
      apiKey: orKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.3, maxTokens: 800,
      messages: [
        { role: 'system', content: 'Ты — аналитик удержания коротких видео. На основе разбора СПРОГНОЗИРУЙ (важно: это ПРОГНОЗ ИИ по содержанию, а не реальная аналитика владельца) : 1) Кривую удержания — сильные моменты и ВЕРОЯТНЫЕ точки оттока с примерными таймкодами и причиной; 2) Силу хука по шкале /10; 3) Ожидаемый диапазон удержания в % (например 25–40%); 4) 3–5 факторов виральности. Начни блок со строки "⚠️ Прогноз ИИ (не реальные данные владельца)". ' + langRule },
        { role: 'user', content: `Разбор аналитика:\n${analysis}\n\nМатериал:\n${material}` },
      ],
    })
    tokens += r.tokens
    const retention = r.content

    // 3) STRATEGIST — actionable plan grounded in the customer's business
    const s = await callOpenRouter({
      apiKey: orKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.5, maxTokens: 1400,
      messages: [
        { role: 'system', content: 'Ты — контент-стратег. На основе анализа и прогноза выдай для БИЗНЕСА КЛИЕНТА: 1) 3–5 рабочих принципов/паттернов, которые стоит перенять (почему они работают); 2) ГОТОВЫЙ сценарий первого Reels под продукт клиента — хук (0–3 сек), сцены с таймкодами (кадр + закадровый текст), текст на экране, финальный CTA, идея обложки. Адаптируй под продукт клиента, НЕ копируй тему конкурента. Чистый Markdown. ' + langRule + biz },
        { role: 'user', content: `Анализ:\n${analysis}\n\nПрогноз удержания:\n${retention}\n\nЦель клиента: ${goal || '(создать сильный контент в этой нише)'}` },
      ],
    })
    tokens += s.tokens
    const plan = s.content

    // account usage + save to Library
    await admin.from('usage').insert({ account_id: accountId, tokens, model: PRIMARY_MODEL })
    if (tokens) await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: tokens })
    const report = `## Разбор контента\n${analysis}\n\n## Прогноз удержания и виральности\n${retention}\n\n## План для вашего бизнеса\n${plan}`
    const { data: run } = await admin.from('research_runs').insert({ account_id: accountId, task: `Анализ конкурента: ${handle || url || platform}`, kind: 'analysis', status: 'done', report, model: PRIMARY_MODEL }).select('id').single()

    return json({ ok: true, analysis, retention, plan, id: run?.id })
  } catch (e) {
    return json({ ok: false, error: `Ошибка анализа: ${String(e).slice(0, 200)}` }, 502)
  }
})
