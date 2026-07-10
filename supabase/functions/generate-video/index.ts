// Video generation on the customer's OWN Replicate key (async). Creates a prediction and
// records a media_job (processing); media-poll finalizes it into the Library when ready.
//   POST /functions/v1/generate-video  (Bearer jwt)  { prompt, model? } -> { ok, job_id, status }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import { planOf } from '../_shared/plans.ts'
import { resolveMediaAccess } from '../_shared/mediaAccess.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const NEMO_REPLICATE_KEY = Deno.env.get('REPLICATE_API_KEY') ?? '' // Nemo's own key powers "included" video (Pro/Max)
const DEFAULT_MODEL = 'minimax/video-01' // text-to-video

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
  // VIDEO is a budgeted feature — only Plus / Pro / Max tiers (admins exempt)
  if (!plan.video && !prof?.is_admin) return json({ ok: false, code: 'PLAN', message: 'Генерация видео доступна на тарифах Плюс, Про и Макс.' }, 200)
  // own Replicate key (BYO) → Nemo included (Pro/Max) → weekly trial
  const access = await resolveMediaAccess(admin, accountId, plan, 'video', NEMO_REPLICATE_KEY, Boolean(prof?.is_admin))
  if (!access.ok) return json({ ok: false, code: access.code, message: access.message }, 200)
  const key = access.key as string

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
