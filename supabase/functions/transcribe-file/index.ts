// Long-audio transcription for the "audio analysis" feature (meeting/call recordings up to hours).
// Two engines:
//   • Gemini File API (if GEMINI_API_KEY is set) — uploads the file to Google and transcribes it
//     natively; handles LONG audio (hours) that inline base64 can't.
//   • OpenRouter inline (fallback) — good for short clips only.
// Input: { audio_url } (public URL, e.g. from storage) OR { audio_b64, format }. Returns { transcript }.
//   POST /functions/v1/transcribe-file  (Bearer jwt)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import { transcribeAudio } from '../_shared/transcribe.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? ''
const MAX_BYTES = 60 * 1024 * 1024 // safety cap for edge-function memory

async function geminiTranscribe(bytes: Uint8Array, mime: string): Promise<{ text: string; error?: string }> {
  try {
    // 1) upload the file to the Gemini File API (raw single-shot upload)
    const up = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'X-Goog-Upload-Protocol': 'raw', 'Content-Type': mime }, body: bytes,
    })
    const uj = await up.json().catch(() => ({}))
    const fileUri = uj?.file?.uri
    if (!up.ok || !fileUri) return { text: '', error: `Gemini upload: ${uj?.error?.message ?? up.status}` }
    // 2) transcribe with gemini-2.5-flash (handles long audio)
    const gen = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ file_data: { mime_type: mime, file_uri: fileUri } }, { text: 'Transcribe this audio VERBATIM in its original language (Uzbek/Russian/English etc.). Output ONLY the transcription text.' }] }] }),
    })
    const gj = await gen.json().catch(() => ({}))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (gj?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim()
    if (!text) return { text: '', error: `Gemini transcribe: ${gj?.error?.message ?? 'empty'}` }
    return { text }
  } catch (e) { return { text: '', error: String(e).slice(0, 150) } }
}

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

  const body = await req.json().catch(() => ({}))
  const audioUrl = String(body?.audio_url ?? '').trim()
  const audioB64 = String(body?.audio_b64 ?? '').trim()
  let mime = String(body?.format ?? '').trim()

  // load the audio bytes (from a URL or inline base64)
  let bytes: Uint8Array | null = null
  try {
    if (audioUrl && /^https?:\/\//.test(audioUrl)) {
      const r = await fetch(audioUrl)
      if (!r.ok) return json({ ok: false, error: 'Не удалось скачать аудио по ссылке.' }, 200)
      mime = mime || r.headers.get('content-type') || 'audio/mpeg'
      const buf = new Uint8Array(await r.arrayBuffer())
      if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: `Файл слишком большой (${Math.round(buf.byteLength / 1048576)}МБ). Максимум ${MAX_BYTES / 1048576}МБ.` }, 200)
      bytes = buf
    } else if (audioB64) {
      const clean = audioB64.replace(/^data:[^;]+;base64,/, '')
      bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0))
      mime = mime || 'audio/ogg'
    }
  } catch (e) { return json({ ok: false, error: `Ошибка загрузки аудио: ${String(e).slice(0, 150)}` }, 200) }
  if (!bytes) return json({ ok: false, error: 'Передайте audio_url или audio_b64.' }, 200)

  // transcribe: Gemini File API for long audio, else OpenRouter inline (short clips)
  let transcript = '', engine = ''
  if (GEMINI_API_KEY) {
    const g = await geminiTranscribe(bytes, mime)
    if (g.text) { transcript = g.text; engine = 'gemini-file' }
  }
  if (!transcript) {
    if (bytes.byteLength > 12 * 1024 * 1024) return json({ ok: false, code: 'TOO_LONG', message: 'Для длинного аудио подключите Gemini-ключ (GEMINI_API_KEY) — без него можно только короткие записи.' }, 200)
    let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    const b64 = btoa(bin)
    const orKey = await resolveOpenRouterKey(userDb, accountId, OPENROUTER_API_KEY)
    const fmt = mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : 'mp3'
    transcript = String(await transcribeAudio(orKey, b64, fmt)).trim(); engine = 'openrouter'
  }
  if (!transcript) return json({ ok: false, error: 'Не удалось расшифровать аудио.' }, 200)
  return json({ ok: true, transcript: transcript.slice(0, 40000), engine })
})
