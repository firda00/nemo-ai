// Image generation. Default engine = NEMO's OpenRouter image model (INCLUDED in the
// subscription — no customer key needed), fair-use limited per plan. If the customer
// connected their own OpenAI key, it is used as a fallback. Saved to media_assets.
//   POST /functions/v1/generate-image  (Bearer jwt)  { prompt } -> { ok, image } | { ok:false, code }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { planOf, monthlyMedia } from '../_shared/plans.ts'
import { nemoImage, uploadImage } from '../_shared/media.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
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
  if (!prof?.is_admin) {
    if (!plan.media) return json({ ok: false, code: 'PLAN', message: 'Генерация изображений входит в тариф Starter и выше.' }, 200)
    const used = await monthlyMedia(admin, accountId)
    if (used >= plan.mediaMonthly) return json({ ok: false, code: 'LIMIT', message: `Лимит генераций по тарифу (${plan.mediaMonthly}/мес) исчерпан.` }, 200)
  }

  const body = await req.json().catch(() => ({}))
  const prompt = String(body?.prompt ?? '').trim()
  if (prompt.length < 3) return json({ ok: false, error: 'Опишите изображение подробнее.' }, 200)

  let image = ''
  let provider = 'nemo'
  const nemo = await nemoImage(OPENROUTER_KEY, prompt)
  if (nemo.image) image = nemo.image
  else {
    const { data: keyRow } = await admin.from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', 'openai').maybeSingle()
    const key = keyRow?.api_key
    if (key) {
      try {
        const r = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024', n: 1 }),
        })
        const data = await r.json()
        const item = data?.data?.[0]
        if (item?.b64_json) { image = `data:image/png;base64,${item.b64_json}`; provider = 'openai' }
        else if (item?.url) { image = item.url; provider = 'openai' }
      } catch (_e) { /* ignore */ }
    }
    if (!image) return json({ ok: false, error: nemo.error ?? 'Не удалось сгенерировать изображение.' }, 200)
  }

  const hosted = image.startsWith('data:') ? await uploadImage(admin, accountId, image) : image
  await admin.from('media_assets').insert({ account_id: accountId, kind: 'image', prompt, provider, data: image.startsWith('data:') ? image : null, url: hosted || (image.startsWith('http') ? image : null) })
  if (nemo.tokens) { await admin.from('usage').insert({ account_id: accountId, tokens: nemo.tokens, model: 'media-image' }); await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: nemo.tokens }) }
  return json({ ok: true, image, url: hosted || undefined, provider })
})
