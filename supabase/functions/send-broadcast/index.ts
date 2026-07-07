// SMS broadcast (Nemo → its users). ADMIN-ONLY. Sends a message to every saved phone
// (business_profiles.phone) via Twilio. Runs on Nemo's own Twilio (env). Logs each run.
//   POST /functions/v1/send-broadcast  (Bearer jwt, admin)  { message } -> { ok, recipients, sent, failed }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? ''
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? ''
const TWILIO_FROM = Deno.env.get('TWILIO_FROM') ?? ''

function cleanPhone(p: string): string { return (p || '').replace(/[^\d+]/g, '') }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('is_admin').maybeSingle()
  if (!prof?.is_admin) return json({ error: 'forbidden' }, 403)

  const body = await req.json().catch(() => ({}))
  const message = String(body?.message ?? '').trim()
  if (message.length < 2) return json({ ok: false, error: 'Пустое сообщение.' }, 200)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: rows } = await admin.from('business_profiles').select('phone').not('phone', 'is', null).limit(2000)
  const phones = [...new Set((rows ?? []).map((r: { phone: string }) => cleanPhone(r.phone)).filter((p) => p.length >= 7))]

  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    return json({ ok: false, code: 'NOT_CONFIGURED', recipients: phones.length, message: `Найдено ${phones.length} номеров. Подключите Twilio на сервере (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM), чтобы отправлять.` }, 200)
  }

  const auth = btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)
  let sent = 0, failed = 0
  for (const to of phones.slice(0, 1000)) {
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: message }),
      })
      if (r.ok) sent++; else failed++
    } catch { failed++ }
  }
  await admin.from('broadcasts').insert({ message: message.slice(0, 1000), recipients: phones.length, sent, failed })
  return json({ ok: true, recipients: phones.length, sent, failed })
})
