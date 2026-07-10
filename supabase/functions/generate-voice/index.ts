// Voice generation (text-to-speech) on the customer's OWN ElevenLabs key. Synchronous:
// returns the audio inline and saves it to the Library (media_assets, kind='audio').
//   POST /functions/v1/generate-voice  (Bearer jwt)  { text, voice_id? } -> { ok, audio }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import { elevenTTS, openaiTTS, uploadAudio } from '../_shared/media.ts'
import { planOf } from '../_shared/plans.ts'
import { resolveMediaAccess } from '../_shared/mediaAccess.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// Nemo's own voice keys power "included" TTS (Pro/Max) — set as secrets to enable it
const NEMO_ELEVEN_KEY = Deno.env.get('ELEVENLABS_API_KEY') ?? ''
const NEMO_OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM' // ElevenLabs "Rachel" (multilingual)

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
  const body = await req.json().catch(() => ({}))
  const text = String(body?.text ?? '').trim()
  if (text.length < 2) return json({ ok: false, error: 'Введите текст для озвучки.' }, 200)
  const voiceId = String(body?.voice_id ?? '').trim() || DEFAULT_VOICE

  // own key (BYO) → Nemo included (Pro/Max) → weekly trial (Standard/Plus). Nemo prefers its
  // ElevenLabs key, else its OpenAI key, for the included/trial path.
  const nemoVoiceKey = NEMO_ELEVEN_KEY || NEMO_OPENAI_KEY
  const access = await resolveMediaAccess(admin, accountId, planOf(acc?.plan), 'voice', nemoVoiceKey, Boolean(prof?.is_admin))
  if (!access.ok) return json({ ok: false, code: access.code, message: access.message }, 200)

  try {
    // pick the engine: BYO uses the matched provider's key; included/trial uses Nemo's key
    let audio = '', provider = ''
    if (access.source === 'byo') {
      if (access.provider === 'elevenlabs') { audio = await elevenTTS(access.key as string, text, voiceId); if (audio) provider = 'elevenlabs' }
      else { audio = await openaiTTS(access.key as string, text); if (audio) provider = 'openai' }
    } else {
      // Nemo's included/trial key — try ElevenLabs, fall back to OpenAI if it fails
      if (NEMO_ELEVEN_KEY) { audio = await elevenTTS(NEMO_ELEVEN_KEY, text, voiceId); if (audio) provider = 'elevenlabs' }
      if (!audio && NEMO_OPENAI_KEY) { audio = await openaiTTS(NEMO_OPENAI_KEY, text); if (audio) provider = 'openai' }
    }
    if (!audio) {
      // distinguish "you must connect a key" (BYO path failed to produce) from a Nemo-side outage
      const nemoSide = access.source !== 'byo'
      return json({ ok: false, code: nemoSide ? 'PROVIDER' : 'NO_KEY', message: nemoSide ? 'Озвучка временно недоступна, попробуйте позже.' : 'Не удалось озвучить на вашем ключе — проверьте баланс/ключ провайдера.' }, 200)
    }
    // host it for a public URL so it can be used as a video voiceover track / posted anywhere
    const url = await uploadAudio(admin, accountId, audio)
    await admin.from('media_assets').insert({ account_id: accountId, kind: 'audio', prompt: text.slice(0, 300), provider, data: audio, url: url || null })
    return json({ ok: true, audio, url: url || undefined, provider })
  } catch (e) {
    return json({ ok: false, error: `Сеть/провайдер: ${String(e).slice(0, 200)}` }, 502)
  }
})
