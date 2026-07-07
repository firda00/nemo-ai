// Voice generation (text-to-speech) on the customer's OWN ElevenLabs key. Synchronous:
// returns the audio inline and saves it to the Library (media_assets, kind='audio').
//   POST /functions/v1/generate-voice  (Bearer jwt)  { text, voice_id? } -> { ok, audio }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM' // ElevenLabs "Rachel" (multilingual)

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
  const { data: keyRow } = await admin.from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', 'elevenlabs').maybeSingle()
  const key = keyRow?.api_key
  if (!key) return json({ ok: false, code: 'NO_KEY', message: 'Подключите ElevenLabs в разделе «Медиа», чтобы озвучивать.' }, 200)

  const body = await req.json().catch(() => ({}))
  const text = String(body?.text ?? '').trim()
  if (text.length < 2) return json({ ok: false, error: 'Введите текст для озвучки.' }, 200)
  const voiceId = String(body?.voice_id ?? '').trim() || DEFAULT_VOICE

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 5000), model_id: 'eleven_multilingual_v2' }),
    })
    if (!r.ok) {
      let msg = 'ElevenLabs отклонил запрос.'
      try { const e = await r.json(); msg = e?.detail?.message ?? e?.detail ?? msg } catch { /* non-json */ }
      return json({ ok: false, error: typeof msg === 'string' ? msg : 'ElevenLabs отклонил запрос.' }, 200)
    }
    const buf = new Uint8Array(await r.arrayBuffer())
    const audio = `data:audio/mpeg;base64,${encodeBase64(buf)}`
    await admin.from('media_assets').insert({ account_id: accountId, kind: 'audio', prompt: text.slice(0, 300), provider: 'elevenlabs', data: audio })
    return json({ ok: true, audio })
  } catch (e) {
    return json({ ok: false, error: `Сеть/провайдер: ${String(e).slice(0, 200)}` }, 502)
  }
})
