// Video generation through OpenRouter's asynchronous Video API.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { planOf } from '../_shared/plans.ts'
import { resolveMediaAccess } from '../_shared/mediaAccess.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const NEMO_OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const DEFAULT_MODEL = 'google/veo-3.1-fast'
// the only model served by the direct Replicate adapter — selected ONLY by an explicit request
const REPLICATE_DIRECT_MODEL = 'minimax/video-01'
const VIDEO_MODELS = new Set([
  'google/veo-3.1-fast', 'google/veo-3.1-lite', 'google/veo-3.1',
  'kwaivgi/kling-v3.0-pro', 'kwaivgi/kling-v3.0-std', 'kwaivgi/kling-video-o1',
  'bytedance/seedance-2.5', 'bytedance/seedance-2.0-fast', 'bytedance/seedance-2.0',
  'openai/sora-2-pro', 'minimax/hailuo-3', 'minimax/hailuo-3-max', 'alibaba/wan-3.0',
])
const ASPECTS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '9:21'])
const RESOLUTIONS = new Set(['480p', '720p', '768p', '1080p', '1K', '2K', '4K'])
const MODEL_DEFAULTS: Record<string, { durations: number[]; resolutions: string[] }> = {
  'google/veo-3.1-fast': { durations: [4, 6, 8], resolutions: ['720p', '1080p', '4K'] },
  'google/veo-3.1-lite': { durations: [4, 6, 8], resolutions: ['720p', '1080p'] },
  'google/veo-3.1': { durations: [4, 6, 8], resolutions: ['720p', '1080p', '4K'] },
  'openai/sora-2-pro': { durations: [4, 8, 12, 16, 20], resolutions: ['720p', '1080p'] },
  'minimax/hailuo-3': { durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['2K'] },
  'minimax/hailuo-3-max': { durations: [5, 6, 7, 8, 9, 10], resolutions: ['2K'] },
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
  if (await blocksExternalActions(admin, accountId)) return json(PRODUCTION_E2E_EXTERNAL_BLOCK, 403)
  const { data: acc } = await admin.from('accounts').select('plan, blocked').eq('id', accountId).single()
  if (acc?.blocked) return json({ error: 'blocked' }, 403)
  const plan = planOf(acc?.plan)
  if (!plan.video && !prof?.is_admin) return json({ ok: false, code: 'PLAN', message: 'Генерация видео доступна на тарифах Плюс, Про и Макс.' }, 200)

  const body = await req.json().catch(() => ({}))
  const prompt = String(body?.prompt ?? '').trim()
  if (prompt.length < 3) return json({ ok: false, error: 'Опишите видео подробнее.' }, 200)
  const requestedModel = String(body?.model ?? '').trim()
  const directReplicate = requestedModel === REPLICATE_DIRECT_MODEL
  // unknown model → reject before any paid provider call
  if (requestedModel && !directReplicate && !VIDEO_MODELS.has(requestedModel)) return json({ ok: false, error: 'Неизвестная модель видео.' }, 200)
  const model = VIDEO_MODELS.has(requestedModel) ? requestedModel : DEFAULT_MODEL
  const aspectRatio = ASPECTS.has(String(body?.aspect_ratio)) ? String(body.aspect_ratio) : '16:9'
  const requestedResolution = RESOLUTIONS.has(String(body?.resolution)) ? String(body.resolution) : '720p'
  const requestedDuration = Math.max(3, Math.min(20, Number(body?.duration) || 6))
  const modelDefaults = MODEL_DEFAULTS[model]
  const resolution = modelDefaults?.resolutions.includes(requestedResolution) ? requestedResolution : modelDefaults?.resolutions[0] ?? requestedResolution
  const duration = modelDefaults?.durations.includes(requestedDuration) ? requestedDuration : modelDefaults?.durations[0] ?? requestedDuration
  const referenceUrls = Array.isArray(body?.reference_urls)
    ? body.reference_urls.filter((url: unknown) => typeof url === 'string' && /^(https?:|data:image\/)/.test(url)).slice(0, 4)
    : []
  // the Replicate video-01 adapter honors neither audio nor reference images —
  // an explicit request for them must fail BEFORE any paid external call
  if (directReplicate && body?.generate_audio === true) return json({ ok: false, error: 'minimax/video-01 (Replicate) не поддерживает генерацию звука. Отключите звук или выберите модель OpenRouter.' }, 200)
  if (directReplicate && referenceUrls.length) return json({ ok: false, error: 'minimax/video-01 (Replicate) не поддерживает референс-изображения. Уберите их или выберите модель OpenRouter.' }, 200)

  // explicit minimax/video-01 → the tenant's own Replicate key with NO shared-key
  // fallback; every other model runs through OpenRouter
  const access = directReplicate
    ? await resolveMediaAccess(admin, accountId, plan, 'video', '', Boolean(prof?.is_admin), ['replicate'])
    : await resolveMediaAccess(admin, accountId, plan, 'video', NEMO_OPENROUTER_KEY, Boolean(prof?.is_admin))
  if (!access.ok) return json({ ok: false, code: access.code, message: access.message }, 200)

  if (directReplicate) {
    try {
      // fixed adapter path — never interpolate a caller-supplied model into the URL
      const response = await fetch(`https://api.replicate.com/v1/models/${REPLICATE_DIRECT_MODEL}/predictions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { prompt: prompt.slice(0, 4000) } }),
        signal: AbortSignal.timeout(30_000),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.id) return json({ ok: false, error: data?.detail ?? data?.title ?? 'Replicate отклонил запрос видео.' }, 200)
      const { data: job, error: jobError } = await admin.from('media_jobs')
        .insert({ account_id: accountId, kind: 'video', provider: 'replicate', external_id: data.id, status: 'processing', prompt: prompt.slice(0, 300) })
        .select('id').single()
      if (jobError || !job?.id) {
        // the provider already accepted the paid job — report the tracking failure
        // honestly and do NOT retry the provider from here
        console.error('generate-video media_jobs insert failed (replicate)', jobError?.code)
        return json({ ok: false, code: 'TRACKING', error: 'Видео запущено у провайдера, но задачу не удалось сохранить для отслеживания. Не запускайте повторно — обратитесь в поддержку.' }, 200)
      }
      return json({ ok: true, job_id: job.id, status: data.status ?? 'processing', model: REPLICATE_DIRECT_MODEL })
    } catch (e) {
      return json({ ok: false, error: `Сеть/провайдер: ${String(e).slice(0, 200)}` }, 502)
    }
  }
  const requestBody: Record<string, unknown> = {
    model, prompt: prompt.slice(0, 4000), duration, resolution, aspect_ratio: aspectRatio,
    generate_audio: body?.generate_audio !== false,
  }
  if (referenceUrls.length) requestBody.input_references = referenceUrls.map((url: string) => ({ type: 'image_url', image_url: { url } }))

  try {
    const r = await fetch('https://openrouter.ai/api/v1/videos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access.key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://nemoai.uz', 'X-Title': 'Nemo AI' },
      body: JSON.stringify(requestBody), signal: AbortSignal.timeout(30_000),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok || !data?.id) return json({ ok: false, error: data?.error?.message ?? 'OpenRouter отклонил запрос видео.' }, 200)
    const { data: job, error: jobError } = await admin.from('media_jobs')
      .insert({ account_id: accountId, kind: 'video', provider: 'openrouter', external_id: data.id, status: 'processing', prompt: prompt.slice(0, 300) })
      .select('id').single()
    if (jobError || !job?.id) {
      console.error('generate-video media_jobs insert failed (openrouter)', jobError?.code)
      return json({ ok: false, code: 'TRACKING', error: 'Видео запущено у провайдера, но задачу не удалось сохранить для отслеживания. Не запускайте повторно — обратитесь в поддержку.' }, 200)
    }
    return json({ ok: true, job_id: job.id, status: data.status ?? 'pending', model, generate_audio: requestBody.generate_audio })
  } catch (e) {
    return json({ ok: false, error: `Сеть/провайдер: ${String(e).slice(0, 200)}` }, 502)
  }
})
