// "The AI makes the image itself." Given finished content (a post / script), the model
// DERIVES a clean image prompt on its own (the human never writes it), then generates the
// picture. Default engine = NEMO's OpenRouter image model (INCLUDED IN THE SUBSCRIPTION,
// no customer key needed); if the customer connected their own OpenAI key it is used as a
// fallback. Fair-use limited per plan. Result is saved to media_assets (Library).
//   POST /functions/v1/content-visual  (Bearer jwt)  { content } -> { ok, prompt, image } | { ok:false, code }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL, type ChatMsg } from '../_shared/llm.ts'
import { planOf } from '../_shared/plans.ts'
import { resolveMediaAccess } from '../_shared/mediaAccess.ts'
import { nemoImage, uploadImage, imgModelDef } from '../_shared/media.ts'
import { corsPreflight, json } from '../_shared/cors.ts'
import { openSecret } from '../_shared/secretBox.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

// Composition presets so a marketplace card / story / product photo comes out in the right
// proportions. gpt-image-1 supports a fixed set of sizes; the exact target ratio also goes
// into the prompt so the image model composes for it.
const SIZES: Record<string, { openai: string; hint: string }> = {
  square: { openai: '1024x1024', hint: 'square 1:1 composition, centered subject' },
  portrait: { openai: '1024x1536', hint: 'vertical 4:5 composition' },
  card: { openai: '1024x1536', hint: 'vertical 3:4 marketplace product card; the product fills the frame; leave clean space at the top for a short overlay caption' },
  story: { openai: '1024x1536', hint: 'vertical 9:16 story composition' },
  landscape: { openai: '1536x1024', hint: 'horizontal 16:9 composition' },
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id, is_admin').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('plan, blocked').eq('id', accountId).single()
  if (acc?.blocked) return json({ error: 'blocked' }, 403)
  const plan = planOf(acc?.plan)

  // Resolve which key to bill: own key (BYO) → Nemo included (Pro/Max) → weekly trial (Standard/Plus)
  const access = await resolveMediaAccess(admin, accountId, plan, 'image', OPENROUTER_KEY, Boolean(prof?.is_admin))
  if (!access.ok) return json({ ok: false, code: access.code, message: access.message }, 200)
  const imageKey = access.key as string

  const body = await req.json().catch(() => ({}))
  const content = String(body?.content ?? '').trim()
  if (content.length < 10) return json({ ok: false, error: 'Слишком мало текста, чтобы придумать визуал.' }, 200)
  const sizeKey = String(body?.size ?? 'square')
  const sz = Object.prototype.hasOwnProperty.call(SIZES, sizeKey) ? SIZES[sizeKey] : SIZES.square
  const brief = String(body?.brief ?? '').trim().slice(0, 400) // extra art-direction (e.g. "инфографика для карточки Wildberries")
  // Default to PHOTOREALISTIC (the common complaint is cartoonish/CGI output). A caller can pass
  // style: 'illustration' | '3d' | 'flat' | 'anime' etc. to opt out of the realism steer.
  const style = String(body?.style ?? '').trim().toLowerCase()
  const photoreal = !style || style === 'photo' || style === 'realistic' || style === 'photoreal'
  // chosen image model (validated against the server allowlist in media.ts). When the caller
  // asks for a realistic style we force a realistic engine; when they ask for illustration and
  // haven't picked a model, use the fast stylized engine.
  const reqModel = String(body?.image_model ?? '').trim()
  const picked = imgModelDef(reqModel || undefined)
  const imageModel = reqModel
    ? picked.id
    : (photoreal ? imgModelDef(undefined).id : 'google/gemini-2.5-flash-image')

  // 1) the AI derives the image prompt itself (English → best image quality)
  let prompt = ''
  let deriveTokens = 0
  try {
    const realismRule = photoreal
      ? 'The image MUST be PHOTOREALISTIC — a real photograph shot on a camera, authentic real-world scene, natural lighting, real people/objects, indistinguishable from a genuine photo. Do NOT make it a cartoon, illustration, 3D render, CGI, clipart or flat vector. Mention a camera/lens feel (e.g. shot on DSLR, 50mm, shallow depth of field). '
      : `Use this visual style: ${style}. `
    const msgs: ChatMsg[] = [
      { role: 'system', content: 'You are an art director. Read the social/marketing content and write ONE vivid, concrete English image-generation prompt for its MAIN visual. ' + realismRule + 'Describe subject, setting, mood, lighting and lens. No text/letters in the image. Under 65 words. Output ONLY the prompt.' },
      { role: 'user', content: (brief ? `Art direction: ${brief}\n\n` : '') + content.slice(0, 3000) },
    ]
    const r = await callOpenRouter({ apiKey: OPENROUTER_KEY, model: PRIMARY_MODEL, messages: msgs, temperature: 0.6, maxTokens: 170, fallbackModel: FALLBACK_MODEL })
    prompt = r.content.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 900)
    deriveTokens = r.tokens
  } catch { /* fall through to a safe default */ }
  if (prompt.length < 5) prompt = `Clean modern marketing visual for: ${content.slice(0, 200)}`
  prompt = `${prompt} Composition: ${sz.hint}.` // steer proportions for the chosen format
  // final realism reinforcement for the image model (only when photoreal)
  if (photoreal) prompt += ' Ultra-realistic photograph, natural lighting, lifelike detail, authentic candid moment, no illustration, no CGI, no cartoon.'

  // 2) generate — Nemo's OpenRouter engine first (included), customer OpenAI key as fallback
  let image = ''
  let provider = 'nemo'
  const nemo = await nemoImage(imageKey, prompt, imageModel)
  if (nemo.image) image = nemo.image
  else {
    const { data: keyRow } = await admin.from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', 'openai').maybeSingle()
    const key = await openSecret(keyRow?.api_key)
    if (key) {
      try {
        const r = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-image-1', prompt, size: sz.openai, n: 1 }),
        })
        const data = await r.json()
        const item = data?.data?.[0]
        if (item?.b64_json) { image = `data:image/png;base64,${item.b64_json}`; provider = 'openai' }
        else if (item?.url) { image = item.url; provider = 'openai' }
      } catch { /* ignore, report nemo error below */ }
    }
    if (!image) return json({ ok: false, prompt, error: nemo.error ?? 'Не удалось сгенерировать изображение.' }, 200)
  }

  // host it for a public URL (needed to post the image to Instagram/Facebook)
  const hosted = image.startsWith('data:') ? await uploadImage(admin, accountId, image) : image
  // save to Library + account usage
  await admin.from('media_assets').insert({ account_id: accountId, kind: 'image', prompt, provider, data: image.startsWith('data:') ? image : null, url: hosted || (image.startsWith('http') ? image : null) })
  const totalTokens = deriveTokens + (nemo.tokens ?? 0)
  if (totalTokens) { await admin.from('usage').insert({ account_id: accountId, tokens: totalTokens, model: 'media-image' }); await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: totalTokens }) }
  return json({ ok: true, prompt, image, url: hosted || undefined, model: provider === 'nemo' ? imageModel : 'gpt-image-1' })
})
