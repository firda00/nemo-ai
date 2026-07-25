// Self-service BYO model: a user connects their OWN OpenRouter key so the platform
// runs on THEIR balance (OpenRouter routes to GPT/Claude/Gemini/… legally, no ChatGPT
// login/scraping). The key is validated, then stored server-only in provider_keys.
//   POST /functions/v1/connect-model   (Bearer user jwt)
//   { action:'connect', api_key }         -> validates + stores openrouter key
//   { action:'status' }                   -> { connected, label, limit, usage }
//   { action:'disconnect' }               -> removes the key
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { openSecret, providerSecretContext, sealSecret } from '../_shared/secretBox.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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
    const { data } = await admin.from('provider_keys').select('api_key, created_at').eq('account_id', accountId).eq('provider', 'openrouter').maybeSingle()
    if (!data?.api_key) return json({ ok: true, connected: false })
    // fetch label/limit for a friendly display (never return the key)
    try {
      const info = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${await openSecret(data.api_key, providerSecretContext(accountId, 'openrouter'))}` } }).then((r) => r.json())
      return json({ ok: true, connected: true, label: info?.data?.label ?? null, limit: info?.data?.limit ?? null, usage: info?.data?.usage ?? null, since: data.created_at })
    } catch {
      return json({ ok: true, connected: true, since: data.created_at })
    }
  }

  if (action === 'disconnect') {
    await admin.from('provider_keys').delete().eq('account_id', accountId).eq('provider', 'openrouter')
    return json({ ok: true, connected: false })
  }

  if (action === 'connect') {
    const key = String(body?.api_key ?? '').trim()
    if (!key || key.length < 20) return json({ ok: false, error: 'Введите корректный ключ OpenRouter (sk-or-...).' }, 400)
    // validate against OpenRouter, then store server-only
    try {
      const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } })
      if (!r.ok) return json({ ok: false, error: 'Ключ не принят OpenRouter — проверьте, что скопировали верно.' }, 400)
      const info = await r.json() as { data?: { label?: string; limit?: number | null; usage?: number } }
      await admin.from('provider_keys').upsert({
        account_id: accountId,
        provider: 'openrouter',
        api_key: await sealSecret(key, providerSecretContext(accountId, 'openrouter')),
      }, { onConflict: 'account_id,provider' })
      return json({ ok: true, connected: true, label: info?.data?.label ?? null, limit: info?.data?.limit ?? null, usage: info?.data?.usage ?? null })
    } catch {
      return json({ ok: false, error: 'Не удалось проверить ключ (сеть). Повторите.' }, 502)
    }
  }

  return json({ error: 'unknown action' }, 400)
})
