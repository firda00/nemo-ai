// AI voice call on the customer's OWN Bland.ai key. The agent calls the number and
// talks according to `task`. Logs the call. (Vapi supported similarly if connected.)
//   POST /functions/v1/make-call  (Bearer jwt)  { phone, task } -> { ok, call_id }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { openSecret, providerSecretContext } from '../_shared/secretBox.ts'

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
  const { data: account } = await admin.from('accounts').select('token_balance, blocked').eq('id', accountId).maybeSingle()
  if (!account || account.blocked || Number(account.token_balance ?? 0) <= 0) {
    return json({ ok: false, code: 'NO_CREDITS', message: 'Пополните баланс, чтобы совершать AI-звонки.' }, 402)
  }
  const { data: keyRow } = await admin.from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', 'bland').maybeSingle()
  const key = await openSecret(keyRow?.api_key, providerSecretContext(accountId, 'bland'))
  if (!key) return json({ ok: false, code: 'NO_KEY', message: 'Подключите Bland.ai в разделе «Интеграции», чтобы агент мог звонить.' }, 200)

  const body = await req.json().catch(() => ({}))
  const phone = String(body?.phone ?? '').trim().replace(/[\s()-]/g, '')
  const task = String(body?.task ?? '').trim()
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return json({ ok: false, error: 'Укажите номер в международном формате, например +998901234567.' }, 200)
  if (phone.length < 7) return json({ ok: false, error: 'Укажите корректный номер телефона.' }, 200)
  if (task.length < 3) return json({ ok: false, error: 'Опишите, что агент должен сказать/сделать.' }, 200)

  try {
    const r = await fetch('https://api.bland.ai/v1/calls', {
      method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_number: phone, task, voice: 'nat', record: true }),
    })
    const data = await r.json()
    const callId = data?.call_id ?? data?.callId
    if (!r.ok || (data?.status && data.status === 'error') || !callId) {
      return json({ ok: false, error: data?.message ?? data?.errors?.[0] ?? 'Bland отклонил запрос.' }, 200)
    }
    await admin.from('calls').insert({ account_id: accountId, phone, task: task.slice(0, 500), provider: 'bland', external_id: String(callId), status: 'queued' })
    return json({ ok: true, call_id: callId })
  } catch (e) {
    return json({ ok: false, error: `Сеть/провайдер: ${String(e).slice(0, 200)}` }, 502)
  }
})
