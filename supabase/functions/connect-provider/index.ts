// Generic BYO provider-key connect for media generation (images/video/avatars/voice)
// and other services. Each key is validated (format) and stored server-only in
// provider_keys — write-only from the client, never read back (like connect-model).
//   POST /functions/v1/connect-provider  (Bearer jwt)
//   { action:'connect', provider, api_key } | { action:'status' } | { action:'disconnect', provider }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { sealSecret } from '../_shared/secretBox.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// providers we let a customer connect (id -> label + a light validity check).
// Media providers power generation; integration providers become tools for the AI agent.
const PROVIDERS: Record<string, { label: string; ok: (k: string) => boolean }> = {
  // media / voice / video generation
  openai: { label: 'OpenAI (изображения)', ok: (k) => k.startsWith('sk-') && k.length > 20 },
  replicate: { label: 'Replicate (видео/фото)', ok: (k) => k.length >= 20 },
  heygen: { label: 'HeyGen (аватары)', ok: (k) => k.length >= 16 },
  elevenlabs: { label: 'ElevenLabs (озвучка/дубляж)', ok: (k) => k.length >= 24 },
  did: { label: 'D-ID (говорящие аватары)', ok: (k) => k.length >= 16 },
  synthesia: { label: 'Synthesia (видео с аватаром)', ok: (k) => k.length >= 16 },
  higgsfield: { label: 'Higgsfield (видео/аватары)', ok: (k) => k.length >= 16 },
  stability: { label: 'Stability AI (изображения)', ok: (k) => k.length >= 16 },
  deepgram: { label: 'Deepgram (распознавание речи)', ok: (k) => k.length >= 16 },
  // integrations (tools for the agent)
  github: { label: 'GitHub', ok: (k) => k.startsWith('ghp_') || k.startsWith('github_pat_') || k.length >= 20 },
  stripe: { label: 'Stripe', ok: (k) => k.startsWith('sk_') || k.startsWith('rk_') || k.length >= 20 },
  hubspot: { label: 'HubSpot CRM', ok: (k) => k.length >= 20 },
  amocrm: { label: 'amoCRM (формат: поддомен|токен)', ok: (k) => k.includes('|') && k.length >= 25 },
  bitrix24: { label: 'Bitrix24', ok: (k) => k.length >= 15 },
  notion: { label: 'Notion', ok: (k) => k.startsWith('secret_') || k.startsWith('ntn_') || k.length >= 20 },
  airtable: { label: 'Airtable', ok: (k) => k.length >= 16 },
  slack: { label: 'Slack', ok: (k) => k.startsWith('xoxb-') || k.length >= 20 },
  sentry: { label: 'Sentry (ошибки)', ok: (k) => k.length >= 16 },
  // marketplaces (seller API)
  uzum: { label: 'Uzum Market (API продавца)', ok: (k) => k.length >= 10 },
  wildberries: { label: 'Wildberries (API продавца)', ok: (k) => k.length >= 20 },
  ozon: { label: 'Ozon (формат: Client-Id|Api-Key)', ok: (k) => k.includes('|') && k.length >= 15 },
  kaspi: { label: 'Kaspi (API продавца)', ok: (k) => k.length >= 10 },
  // voice calls
  bland: { label: 'Bland.ai (звонки)', ok: (k) => k.length >= 20 },
  vapi: { label: 'Vapi (звонки)', ok: (k) => k.length >= 20 },
  twilio: { label: 'Twilio (SMS/звонки)', ok: (k) => k.length >= 20 },
  // browser agent (visits sites, fills forms on the user's behalf)
  hyperbrowser: { label: 'Hyperbrowser (браузер-агент)', ok: (k) => k.length >= 16 },
}

// own-key lookup only — plain-object index access resolves inherited members
// ('toString', 'constructor', '__proto__'), which would slip past a truthy guard.
const provider_def = (id: string) => (Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : undefined)

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
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  if (action === 'status') {
    // which providers are connected (never return the keys)
    const { data } = await admin.from('provider_keys').select('provider').eq('account_id', accountId)
    const connected = (data ?? []).map((r: { provider: string }) => r.provider)
    return json({ ok: true, connected, providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, connected: connected.includes(id) })) })
  }

  if (action === 'disconnect') {
    const provider = String(body?.provider ?? '')
    if (!provider_def(provider)) return json({ ok: false, error: 'unknown provider' }, 200)
    await admin.from('provider_keys').delete().eq('account_id', accountId).eq('provider', provider)
    return json({ ok: true })
  }

  if (action === 'connect') {
    const provider = String(body?.provider ?? '')
    const key = String(body?.api_key ?? '').trim()
    const def = provider_def(provider)
    if (!def) return json({ ok: false, error: 'Неизвестный провайдер.' }, 200)
    if (!def.ok(key)) return json({ ok: false, error: `Ключ выглядит некорректно для ${def.label}.` }, 200)
    await admin.from('provider_keys').upsert({ account_id: accountId, provider, api_key: await sealSecret(key) }, { onConflict: 'account_id,provider' })
    return json({ ok: true, connected: true, provider, label: def.label })
  }

  return json({ error: 'unknown action' }, 400)
})
