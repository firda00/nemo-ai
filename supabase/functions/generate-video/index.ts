// Video generation on the customer's OWN Replicate key (async). Creates a prediction and
// records a media_job (processing); media-poll finalizes it into the Library when ready.
//   POST /functions/v1/generate-video  (Bearer jwt)  { prompt, model? } -> { ok, job_id, status }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const DEFAULT_MODEL = 'minimax/video-01' // text-to-video

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
  const { data: keyRow } = await admin.from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', 'replicate').maybeSingle()
  const key = keyRow?.api_key
  if (!key) return json({ ok: false, code: 'NO_KEY', message: 'Подключите Replicate в разделе «Медиа», чтобы генерировать видео.' }, 200)

  const body = await req.json().catch(() => ({}))
  const prompt = String(body?.prompt ?? '').trim()
  if (prompt.length < 3) return json({ ok: false, error: 'Опишите видео подробнее.' }, 200)
  const model = String(body?.model ?? '').trim() || DEFAULT_MODEL

  try {
    const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { prompt } }),
    })
    const data = await r.json()
    if (!r.ok || !data?.id) {
      return json({ ok: false, error: data?.detail ?? data?.title ?? 'Replicate отклонил запрос.' }, 200)
    }
    const { data: job } = await admin.from('media_jobs')
      .insert({ account_id: accountId, kind: 'video', provider: 'replicate', external_id: data.id, status: 'processing', prompt: prompt.slice(0, 300) })
      .select('id').single()
    return json({ ok: true, job_id: job?.id, status: 'processing' })
  } catch (e) {
    return json({ ok: false, error: `Сеть/провайдер: ${String(e).slice(0, 200)}` }, 502)
  }
})
