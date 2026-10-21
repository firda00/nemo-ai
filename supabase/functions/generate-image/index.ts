// Image generation. Default engine = NEMO's OpenRouter image model (INCLUDED in the
// subscription — no customer key needed), fair-use limited per plan. Supports the
// current OpenRouter image catalog and saves the result to media_assets.
// The ONLY direct adapter is an explicit image_model:'gpt-image-1' request, which runs
// on the tenant's own OpenAI key; a stored OpenAI key never reroutes other requests.
//   POST /functions/v1/generate-image  (Bearer jwt)  { prompt, image_model? }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { planOf } from '../_shared/plans.ts'
import { resolveMediaAccess } from '../_shared/mediaAccess.ts'
import { nemoImage, uploadImage, imgModelDef, IMAGE_MODELS } from '../_shared/media.ts'
import { corsPreflight, json } from '../_shared/cors.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

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
  if (await blocksExternalActions(admin, accountId)) return json(PRODUCTION_E2E_EXTERNAL_BLOCK, 403)
  const { data: acc } = await admin.from('accounts').select('plan, blocked').eq('id', accountId).single()
  if (acc?.blocked) return json({ error: 'blocked' }, 403)
  const plan = planOf(acc?.plan)
  const body = await req.json().catch(() => ({}))
  const rawPrompt = String(body?.prompt ?? '').trim()
  if (rawPrompt.length < 3) return json({ ok: false, error: 'Опишите изображение подробнее.' }, 200)
  const requestedModel = String(body?.image_model ?? '').trim()
  const directOpenAi = requestedModel === 'gpt-image-1'
  const catalogModel = IMAGE_MODELS.some((m) => m.id === requestedModel)
  // unknown model → reject before touching any provider budget
  if (requestedModel && !directOpenAi && !catalogModel) return json({ ok: false, error: 'Неизвестная модель изображения.' }, 200)
  const imageModel = directOpenAi ? 'gpt-image-1' : imgModelDef(catalogModel ? requestedModel : undefined).id

  // explicit gpt-image-1 → the tenant's own OpenAI key with NO shared-key fallback;
  // everything else stays on OpenRouter (default catalog model when none was given)
  const access = directOpenAi
    ? await resolveMediaAccess(admin, accountId, plan, 'image', '', Boolean(prof?.is_admin), ['openai'])
    : await resolveMediaAccess(admin, accountId, plan, 'image', OPENROUTER_KEY, Boolean(prof?.is_admin))
  if (!access.ok) return json({ ok: false, code: access.code, message: access.message }, 200)
  const imageKey = access.key as string

  const style = String(body?.style ?? '').trim().toLowerCase()
  const photoreal = !style || style === 'photo' || style === 'realistic' || style === 'photoreal'
  // steer toward a real photograph by default (fixes the cartoon/3D-render look)
  const prompt = photoreal
    ? `${rawPrompt}. Ultra-realistic photograph, natural lighting, lifelike detail, shot on camera, no illustration, no CGI, no cartoon.`
    : rawPrompt

  let image = ''
  const provider = directOpenAi ? 'openai' : 'nemo'
  let nemo: { image?: string; error?: string; tokens?: number } = {}
  if (directOpenAi) {
    try {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers: { Authorization: `Bearer ${imageKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024', n: 1 }),
        signal: AbortSignal.timeout(60_000),
      })
      const data = await r.json().catch(() => null)
      const item = r.ok ? data?.data?.[0] : undefined
      if (item?.b64_json) image = `data:image/png;base64,${item.b64_json}`
      else if (item?.url) image = item.url
      else return json({ ok: false, error: data?.error?.message ?? 'OpenAI отклонил запрос изображения.' }, 200)
    } catch { return json({ ok: false, error: 'Сеть/провайдер: OpenAI недоступен.' }, 502) }
  } else {
    // no cross-provider fallback: an explicitly chosen route fails loudly instead of
    // silently switching provider (and billing a key the user didn't choose)
    nemo = await nemoImage(imageKey, prompt, imageModel)
    if (nemo.image) image = nemo.image
  }
  if (!image) return json({ ok: false, error: nemo.error ?? 'Не удалось сгенерировать изображение.' }, 200)

  const hosted = image.startsWith('data:') ? await uploadImage(admin, accountId, image) : image
  await admin.from('media_assets').insert({ account_id: accountId, kind: 'image', prompt, provider, data: image.startsWith('data:') ? image : null, url: hosted || (image.startsWith('http') ? image : null) })
  if (nemo.tokens) { await admin.from('usage').insert({ account_id: accountId, tokens: nemo.tokens, model: null, stage: 'media-image' }); await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: nemo.tokens }) }
  return json({ ok: true, image, url: hosted || undefined, provider, model: imageModel })
})
