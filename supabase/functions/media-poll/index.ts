// Polls async media jobs (Replicate video / HeyGen avatar) and finalizes finished ones
// into the Library (media_assets). Two callers:
//   • USER (Bearer jwt): { action:'status', job_id }  — check one job now
//   • CRON (x-cron-secret): { action:'run_due' }       — sweep all processing jobs
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { openSecret, providerSecretContext } from '../_shared/secretBox.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const NEMO_REPLICATE_KEY = Deno.env.get('REPLICATE_API_KEY') ?? '' // "included"/trial video runs on Nemo's key
const NEMO_OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

/* eslint-disable @typescript-eslint/no-explicit-any */
async function keyFor(admin: any, accountId: string, provider: string): Promise<string | null> {
  const { data } = await admin.from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', provider).maybeSingle()
  if (data?.api_key) return await openSecret(data.api_key, providerSecretContext(accountId, provider))
  // No own key → the job was created on Nemo's included/trial key; poll it with the same key.
  // (resolveMediaAccess picks BYO-first at creation, so "has own key" matches "created on own key".)
  if (provider === 'replicate' && NEMO_REPLICATE_KEY) return NEMO_REPLICATE_KEY
  if (provider === 'openrouter' && NEMO_OPENROUTER_KEY) return NEMO_OPENROUTER_KEY
  return null
}

async function finalize(admin: any, job: any, url: string) {
  await admin.from('media_assets').insert({ account_id: job.account_id, kind: job.kind, prompt: job.prompt, provider: job.provider, url })
  await admin.from('media_jobs').update({ status: 'done', output_url: url, updated_at: new Date().toISOString() }).eq('id', job.id)
  return { status: 'done', url }
}
async function fail(admin: any, job: any, error: string) {
  await admin.from('media_jobs').update({ status: 'failed', error: String(error).slice(0, 300), updated_at: new Date().toISOString() }).eq('id', job.id)
  return { status: 'failed', error }
}

async function hostOpenRouterVideo(admin: any, job: any, key: string, sourceUrl: string): Promise<string> {
  const response = await fetch(sourceUrl, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60_000) })
  if (!response.ok) return ''
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.length || bytes.length > 100 * 1024 * 1024) return ''
  const path = `${job.account_id}/${Date.now()}-${job.id}.mp4`
  const { error } = await admin.storage.from('media').upload(path, bytes, { contentType: response.headers.get('content-type') || 'video/mp4', upsert: false })
  if (error) return ''
  return admin.storage.from('media').getPublicUrl(path).data?.publicUrl ?? ''
}

async function pollJob(admin: any, job: any): Promise<any> {
  const key = await keyFor(admin, job.account_id, job.provider)
  if (!key) return fail(admin, job, 'нет ключа провайдера')
  try {
    if (job.provider === 'replicate') {
      const r = await fetch(`https://api.replicate.com/v1/predictions/${job.external_id}`, { headers: { Authorization: `Bearer ${key}` } }).then((x) => x.json())
      if (r?.status === 'succeeded') { const out = Array.isArray(r.output) ? r.output[0] : r.output; return out ? finalize(admin, job, out) : fail(admin, job, 'пустой вывод') }
      if (r?.status === 'failed' || r?.status === 'canceled') return fail(admin, job, r?.error ?? 'failed')
      return { status: 'processing' }
    }
    if (job.provider === 'openrouter') {
      const response = await fetch(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(job.external_id)}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
      })
      const r = await response.json().catch(() => ({}))
      if (!response.ok) return response.status === 404 ? fail(admin, job, 'задача OpenRouter не найдена') : { status: 'processing' }
      if (r?.status === 'completed') {
        const sourceUrl = Array.isArray(r.unsigned_urls) ? r.unsigned_urls[0] : ''
        const url = sourceUrl ? await hostOpenRouterVideo(admin, job, key, sourceUrl) : ''
        return url ? finalize(admin, job, url) : fail(admin, job, 'Не удалось сохранить готовое видео')
      }
      if (['failed', 'cancelled', 'expired'].includes(r?.status)) return fail(admin, job, r?.error ?? r.status)
      return { status: 'processing' }
    }
    if (job.provider === 'heygen') {
      const r = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${job.external_id}`, { headers: { 'X-Api-Key': key } }).then((x) => x.json())
      const st = r?.data?.status
      if (st === 'completed') { const url = r?.data?.video_url; return url ? finalize(admin, job, url) : fail(admin, job, 'нет ссылки на видео') }
      if (st === 'failed') return fail(admin, job, r?.data?.error?.message ?? 'failed')
      return { status: 'processing' }
    }
    return { status: 'processing' }
  } catch (e) {
    return { status: 'processing', note: String(e).slice(0, 120) }
  }
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  if (action === 'run_due') {
    const secret = req.headers.get('x-cron-secret')
    const auth = req.headers.get('Authorization') ?? ''
    if (!CRON_SECRET || (secret !== CRON_SECRET && auth !== `Bearer ${SERVICE_ROLE}`)) return new Response('forbidden', { status: 403 })
    const { data: jobs } = await admin.from('media_jobs').select('*').eq('status', 'processing').limit(30)
    let done = 0
    for (const j of jobs ?? []) { const res = await pollJob(admin, j); if (res.status === 'done') done++ }
    return json({ ok: true, checked: (jobs ?? []).length, finished: done })
  }

  // user: check one job
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  if (action === 'status') {
    const jobId = String(body?.job_id ?? '')
    const { data: job } = await admin.from('media_jobs').select('*').eq('id', jobId).eq('account_id', accountId).maybeSingle()
    if (!job) return json({ ok: false, error: 'job not found' }, 200)
    if (job.status !== 'processing') return json({ ok: true, status: job.status, url: job.output_url, error: job.error })
    const res = await pollJob(admin, job)
    return json({ ok: true, ...res })
  }

  return json({ error: 'unknown action' }, 400)
})
/* eslint-enable @typescript-eslint/no-explicit-any */
