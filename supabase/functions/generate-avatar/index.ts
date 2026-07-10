// AI avatar video on the customer's OWN HeyGen key (async). The avatar speaks the given
// script. Records a media_job (processing); media-poll finalizes it into the Library.
//   POST /functions/v1/generate-avatar  (Bearer jwt)  { text, avatar_id?, voice_id? } -> { ok, job_id, status }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import { planOf } from '../_shared/plans.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// HeyGen public defaults (a customer can pass their own avatar_id/voice_id from their account)
const DEFAULT_AVATAR = 'Daisy-inskirt-20220818'
const DEFAULT_VOICE = '2d5b0e6cf36f460aa7fc47e3eee4ba54'

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
  const { data: acc } = await admin.from('accounts').select('plan').eq('id', accountId).single()
  // avatar video is a budgeted feature — only Plus / Pro / Max tiers (admins exempt)
  if (!planOf(acc?.plan).video && !prof?.is_admin) return json({ ok: false, code: 'PLAN', message: 'Видео с аватаром доступно на тарифах Плюс, Про и Макс.' }, 200)
  const { data: keyRow } = await admin.from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', 'heygen').maybeSingle()
  const key = keyRow?.api_key
  if (!key) return json({ ok: false, code: 'NO_KEY', message: 'Подключите HeyGen в разделе «Медиа», чтобы делать видео с аватаром.' }, 200)

  const body = await req.json().catch(() => ({}))
  const text = String(body?.text ?? '').trim()
  if (text.length < 2) return json({ ok: false, error: 'Введите текст, который произнесёт аватар.' }, 200)
  const avatarId = String(body?.avatar_id ?? '').trim() || DEFAULT_AVATAR
  const voiceId = String(body?.voice_id ?? '').trim() || DEFAULT_VOICE

  try {
    const r = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_inputs: [{
          character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
          voice: { type: 'text', input_text: text.slice(0, 1500), voice_id: voiceId },
        }],
        dimension: { width: 1920, height: 1080 },
      }),
    })
    const data = await r.json()
    const videoId = data?.data?.video_id
    if (!r.ok || !videoId) {
      const msg = data?.error?.message ?? data?.message ?? 'HeyGen отклонил запрос (проверьте avatar_id/voice_id в вашем аккаунте).'
      return json({ ok: false, error: typeof msg === 'string' ? msg : 'HeyGen отклонил запрос.' }, 200)
    }
    const { data: job } = await admin.from('media_jobs')
      .insert({ account_id: accountId, kind: 'avatar', provider: 'heygen', external_id: videoId, status: 'processing', prompt: text.slice(0, 300) })
      .select('id').single()
    return json({ ok: true, job_id: job?.id, status: 'processing' })
  } catch (e) {
    return json({ ok: false, error: `Сеть/провайдер: ${String(e).slice(0, 200)}` }, 502)
  }
})
