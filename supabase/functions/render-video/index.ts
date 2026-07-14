// Content Factory video render — broker between the app and the VPS render worker.
// Included in the subscription (fair-use gated). The heavy Remotion+Chromium render runs on
// the VPS worker (RENDER_WORKER_URL, secured by RENDER_SECRET); this function just authorizes,
// plan-gates, forwards the scenes, and lets the client poll status.
//   POST /functions/v1/render-video   (Authorization: Bearer <user jwt>)
//     { action:'render', props:{ title?, brand?, accent?, audioUrl?, scenes:[{imageUrl?,caption?,durationSec?}] } }
//        -> { ok, job_id }
//     { action:'status', job_id }  -> { ok, status:queued|rendering|done|error, url?, error? }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { planOf, monthlyVideo } from '../_shared/plans.ts'
import { elevenTTS, openaiTTS, uploadAudio } from '../_shared/media.ts'
import { corsPreflight, json } from '../_shared/cors.ts'
import { openSecret } from '../_shared/secretBox.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WORKER = (Deno.env.get('RENDER_WORKER_URL') ?? '').replace(/\/$/, '')
const RSECRET = Deno.env.get('RENDER_SECRET') ?? ''

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

  if (!WORKER || !RSECRET) return json({ ok: false, code: 'NO_WORKER', message: 'Видео-движок временно недоступен (не настроен).' }, 200)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('plan, blocked').eq('id', accountId).single()
  if (acc?.blocked) return json({ error: 'blocked' }, 403)
  const plan = planOf(acc?.plan)

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? 'render')
  const H = { 'Content-Type': 'application/json', 'x-render-secret': RSECRET }

  if (action === 'status') {
    const jobId = String(body?.job_id ?? '')
    if (!jobId) return json({ ok: false, error: 'job_id required' }, 200)
    // ownership: the render branch records each job id in tool_runs — only the owning account
    // may read its status/url (otherwise any user could read another tenant's rendered video)
    const { data: own } = await admin.from('tool_runs').select('id').eq('account_id', accountId).eq('tool', 'render_video').eq('result', jobId).maybeSingle()
    if (!own) return json({ ok: false, error: 'job not found' }, 200)
    try {
      const r = await fetch(`${WORKER}/render/${encodeURIComponent(jobId)}`, { headers: H }).then((x) => x.json())
      return json({ ok: r?.status !== 'error', status: r?.status, url: r?.url ?? null, error: r?.error ?? null })
    } catch (e) { return json({ ok: false, status: 'error', error: String(e).slice(0, 200) }, 200) }
  }

  // render — included in subscription, fair-use gated (admins exempt)
  const props = body?.props ?? {}
  const scenes = Array.isArray(props?.scenes) ? props.scenes : []
  if (!scenes.length && !props?.title) return json({ ok: false, error: 'Добавьте кадры (сцены) для видео.' }, 200)
  // Resolution entitlement: the client sends ONLY a quality enum (never dimensions).
  // 1080p and 4K are a Pro-and-above feature (plans.hiResVideo); lower tiers get 720p.
  // Unknown values are rejected, absent quality defaults plan-aware — no silent downgrade
  // of an explicit hi-res request.
  const VIDEO_QUALITIES = ['720p', '1080p', '4k']
  const hiResAllowed = plan.hiResVideo || Boolean(prof?.is_admin)
  const quality = body?.quality == null || body.quality === '' ? (hiResAllowed ? '1080p' : '720p') : String(body.quality)
  if (!VIDEO_QUALITIES.includes(quality)) return json({ ok: false, error: 'Недопустимое качество видео.' }, 200)
  if (quality !== '720p' && !hiResAllowed) {
    return json({ ok: false, code: 'PLAN_HIRES', message: '1080p и 4K доступны на тарифе Pro и выше. На вашем тарифе видео рендерится в 720p.' }, 200)
  }
  if (!prof?.is_admin) {
    if (!plan.media) return json({ ok: false, code: 'PLAN', message: 'Видео-движок входит в тариф Starter и выше.' }, 200)
    const used = await monthlyVideo(admin, accountId)
    if (used >= plan.videoMonthly) return json({ ok: false, code: 'LIMIT', message: `Лимит видео по тарифу (${plan.videoMonthly}/мес) исчерпан.` }, 200)
  }

  // Voiceover: if a script is given and ElevenLabs is connected, synthesize speech, host it,
  // and attach it as the video's audio track — so the video comes out WITH narration (not silent).
  let voiced = false
  const voiceText = String(body?.voiceText ?? props?.voiceText ?? '').trim()
  if (voiceText && !props.audioUrl) {
    // ElevenLabs if connected, else the cheaper OpenAI TTS — so voiceover works on either key
    let audio = '', provider = ''
    const { data: vk } = await admin.from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', 'elevenlabs').maybeSingle()
    if (vk?.api_key) { audio = await elevenTTS(await openSecret(vk.api_key), voiceText, String(body?.voice_id ?? '').trim() || undefined); provider = 'elevenlabs' }
    if (!audio) {
      const { data: ok } = await admin.from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', 'openai').maybeSingle()
      if (ok?.api_key) { audio = await openaiTTS(await openSecret(ok.api_key), voiceText); provider = 'openai' }
    }
    const url = audio ? await uploadAudio(admin, accountId, audio) : ''
    if (url) {
      props.audioUrl = url; voiced = true
      await admin.from('media_assets').insert({ account_id: accountId, kind: 'audio', prompt: voiceText.slice(0, 300), provider, data: audio, url })
    }
  }

  try {
    const r = await fetch(`${WORKER}/render`, { method: 'POST', headers: H, body: JSON.stringify({ accountId, props, quality }) }).then((x) => x.json())
    if (!r?.jobId) return json({ ok: false, error: r?.error ?? 'Не удалось запустить рендер.' }, 200)
    // count this render toward the monthly fair-use cap
    await admin.from('tool_runs').insert({ account_id: accountId, tool: 'render_video', args: { scenes: scenes.length, title: String(props?.title ?? '').slice(0, 120), quality }, result: r.jobId, ok: true })
    return json({ ok: true, job_id: r.jobId, status: 'queued', voiced, voiceRequested: Boolean(voiceText) })
  } catch (e) { return json({ ok: false, error: String(e).slice(0, 200) }, 200) }
})
