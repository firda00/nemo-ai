// Authenticated meeting-audio transcription.
// Long audio is advertised only when Gemini File API is configured. Otherwise
// the server deliberately exposes and enforces the smaller OpenRouter fallback.
// Storage URLs are never fetched directly: only files uploaded under the
// authenticated user's own media/<user-id>/audio/ prefix are accepted.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { transcribeAudioDetailed } from '../_shared/transcribe.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? ''

const SHORT_MAX_BYTES = 12 * 1024 * 1024
const LONG_MAX_BYTES = 180 * 1024 * 1024
const LONG_MAX_SECONDS = 2 * 60 * 60
const MAX_TRANSCRIPT_CHARS = 240_000
const SHORT_OUTPUT_TOKENS = 8192
const LONG_OUTPUT_TOKENS = 32_768
const MEDIA_BUCKET = 'media'

interface GeminiResult {
  text: string
  tokens: number
  error?: string
}

function ownedAudioPath(path: string, userId: string): string {
  const normalized = path.replace(/^\/+/, '').trim()
  if (!normalized || normalized.length > 500) return ''
  if (!normalized.startsWith(`${userId}/audio/`)) return ''
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) return ''
  return normalized
}

function ownedPathFromPublicUrl(raw: string, userId: string): string {
  try {
    const url = new URL(raw)
    if (url.origin !== new URL(SUPABASE_URL).origin) return ''
    const prefix = `/storage/v1/object/public/${MEDIA_BUCKET}/`
    if (!url.pathname.startsWith(prefix)) return ''
    return ownedAudioPath(decodeURIComponent(url.pathname.slice(prefix.length)), userId)
  } catch {
    return ''
  }
}

function supportedMime(value: string): string {
  const mime = value.split(';')[0].trim().toLowerCase()
  if (mime.startsWith('audio/')) return mime
  if (mime === 'video/mp4' || mime === 'application/octet-stream') return mime
  return ''
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

function sizeError(byteLength: number, longAudio: boolean) {
  const mb = Math.ceil(byteLength / 1048576)
  if (!longAudio && byteLength > SHORT_MAX_BYTES) {
    return {
      ok: false,
      code: 'LONG_AUDIO_UNAVAILABLE',
      message: `Длинная расшифровка не включена на сервере: сейчас доступны только короткие записи до ${SHORT_MAX_BYTES / 1048576} МБ. Настройте GEMINI_API_KEY, чтобы включить записи до 120 минут.`,
      received_mb: mb,
    }
  }
  return {
    ok: false,
    code: 'FILE_TOO_LARGE',
    message: `Аудиофайл ${mb} МБ превышает лимит ${LONG_MAX_BYTES / 1048576} МБ.`,
    received_mb: mb,
  }
}

async function geminiTranscribe(bytes: Uint8Array, mime: string, languageHint = 'auto'): Promise<GeminiResult> {
  let fileName = ''
  try {
    const up = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'X-Goog-Upload-Protocol': 'raw', 'Content-Type': mime },
      body: bytes,
    })
    const uploaded = await up.json().catch(() => ({}))
    const fileUri = String(uploaded?.file?.uri ?? '')
    fileName = String(uploaded?.file?.name ?? '')
    if (!up.ok || !fileUri) {
      return { text: '', tokens: 0, error: `Gemini upload: ${String(uploaded?.error?.message ?? up.status).slice(0, 160)}` }
    }

    const gen = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { file_data: { mime_type: mime, file_uri: fileUri } },
          { text: `Transcribe this meeting audio verbatim. Detect and understand mixed speech in Russian, English, Uzbek, Kazakh, Kyrgyz, Tajik, Turkmen, Turkish, Arabic, Persian, Hindi, Urdu, Chinese, Japanese, Korean, German, French, Spanish, Italian and Portuguese. Preserve the original language, distinguish speakers when possible, and keep meaningful timestamps or speaker changes. Do not summarize and do not translate. Language hint: ${languageHint}. Output ONLY the complete transcription.` },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: LONG_OUTPUT_TOKENS },
      }),
    })
    const generated = await gen.json().catch(() => ({}))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (generated?.candidates?.[0]?.content?.parts ?? []).map((part: any) => part?.text ?? '').join('').trim()
    const tokens = Math.max(0, Number(generated?.usageMetadata?.totalTokenCount ?? 0) || 0)
    if (!gen.ok || !text) {
      return { text: '', tokens, error: `Gemini transcribe: ${String(generated?.error?.message ?? 'empty response').slice(0, 160)}` }
    }
    return { text, tokens }
  } catch (e) {
    return { text: '', tokens: 0, error: String(e).slice(0, 160) }
  } finally {
    if (fileName) {
      await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`, { method: 'DELETE' }).catch(() => undefined)
    }
  }
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await userDb.from('users').select('account_id').eq('id', user.id).maybeSingle()
  const accountId = profile?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: account } = await admin.from('accounts').select('token_balance, blocked').eq('id', accountId).maybeSingle()
  if (!account) return json({ error: 'no account' }, 403)
  if (account.blocked) return json({ error: 'blocked' }, 403)

  const body = await req.json().catch(() => ({}))
  const longAudio = Boolean(GEMINI_API_KEY)
  if (String(body?.action ?? '') === 'capabilities') {
    return json({
      ok: true,
      long_audio: longAudio,
      max_bytes: longAudio ? LONG_MAX_BYTES : SHORT_MAX_BYTES,
      max_minutes: longAudio ? LONG_MAX_SECONDS / 60 : null,
      languages: 20,
      transcript_max_chars: MAX_TRANSCRIPT_CHARS,
      engine: longAudio ? 'gemini-file' : 'openrouter-short',
    })
  }

  if (Number(account.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)

  const requestedPath = String(body?.storage_path ?? '').trim()
  const audioUrl = String(body?.audio_url ?? '').trim()
  const audioB64 = String(body?.audio_b64 ?? '').trim()
  let storagePath = requestedPath ? ownedAudioPath(requestedPath, user.id) : ''
  if (!storagePath && audioUrl) storagePath = ownedPathFromPublicUrl(audioUrl, user.id)
  if ((requestedPath || audioUrl) && !storagePath) {
    return json({ ok: false, code: 'UNSAFE_AUDIO_SOURCE', message: 'Разрешено расшифровывать только аудио, загруженное в ваше хранилище Nemo.' }, 200)
  }

  const dataUrlMime = audioB64.match(/^data:([^;]+);base64,/i)?.[1] ?? ''
  let mime = supportedMime(String(body?.format ?? '') || dataUrlMime)
  const maxBytes = longAudio ? LONG_MAX_BYTES : SHORT_MAX_BYTES
  let bytes: Uint8Array | null = null

  try {
    if (storagePath) {
      const { data: blob, error } = await admin.storage.from(MEDIA_BUCKET).download(storagePath)
      if (error || !blob) return json({ ok: false, code: 'AUDIO_DOWNLOAD_FAILED', message: 'Не удалось прочитать загруженное аудио.' }, 200)
      if (blob.size > maxBytes) return json(sizeError(blob.size, longAudio), 200)
      mime = mime || supportedMime(blob.type)
      bytes = new Uint8Array(await blob.arrayBuffer())
    } else if (audioB64) {
      // Inline JSON is intentionally limited to the short path. Large audio must
      // use storage so request bodies cannot exhaust the edge worker's memory.
      const encodedLimit = Math.ceil(SHORT_MAX_BYTES * 4 / 3) + 65_536
      if (audioB64.length > encodedLimit) return json(sizeError(SHORT_MAX_BYTES + 1, false), 200)
      const clean = audioB64.replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '')
      bytes = Uint8Array.from(atob(clean), (char) => char.charCodeAt(0))
      if (bytes.byteLength > SHORT_MAX_BYTES) return json(sizeError(bytes.byteLength, false), 200)
    }

    if (!bytes) return json({ ok: false, code: 'AUDIO_REQUIRED', message: 'Передайте storage_path или короткое audio_b64.' }, 200)
    if (bytes.byteLength > maxBytes) return json(sizeError(bytes.byteLength, longAudio), 200)
    mime = mime || 'audio/mpeg'
    if (!supportedMime(mime)) return json({ ok: false, code: 'UNSUPPORTED_AUDIO', message: 'Формат файла не распознан как аудио.' }, 200)

    const languageHint = String(body?.language ?? 'auto').replace(/[\r\n]/g, ' ').trim().slice(0, 40)
    let transcript = ''
    let engine = ''
    let providerError = ''
    let providerTokens = 0

    if (longAudio) {
      const result = await geminiTranscribe(bytes, mime, languageHint)
      transcript = result.text
      providerTokens = result.tokens
      providerError = result.error ?? ''
      if (transcript) engine = 'gemini-file'
    }

    if (!transcript) {
      if (bytes.byteLength > SHORT_MAX_BYTES) {
        return json({ ok: false, code: 'TRANSCRIPTION_FAILED', message: `Не удалось расшифровать длинную запись через Gemini. ${providerError}`.trim() }, 200)
      }
      const orKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
      if (!orKey) return json({ ok: false, code: 'MISSING_PROVIDER_SECRET', message: 'OpenRouter key is not configured on the server.' }, 503)
      const format = mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : 'mp3'
      const result = await transcribeAudioDetailed(orKey, bytesToBase64(bytes), format, SHORT_OUTPUT_TOKENS)
      transcript = result.text
      providerTokens = result.tokens
      providerError = result.error ?? providerError
      if (transcript) engine = 'openrouter'
    }

    if (!transcript) return json({ ok: false, code: 'TRANSCRIPTION_FAILED', message: `Не удалось расшифровать аудио. ${providerError}`.trim() }, 200)

    const billableTokens = Math.max(providerTokens, Math.ceil(transcript.length / 4), 1)
    await admin.from('usage').insert({ account_id: accountId, tokens: billableTokens, model: `audio-transcription:${engine}` })
    await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: billableTokens })

    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      return json({
        ok: false,
        code: 'TRANSCRIPT_TOO_LARGE',
        message: `Расшифровка содержит ${transcript.length} символов и превышает явный лимит ${MAX_TRANSCRIPT_CHARS}. Текст не был обрезан: разделите запись на части.`,
        transcript_chars: transcript.length,
      }, 200)
    }

    return json({ ok: true, transcript, transcript_chars: transcript.length, engine, tokens: billableTokens })
  } catch (e) {
    return json({ ok: false, code: 'AUDIO_PROCESSING_FAILED', message: `Ошибка обработки аудио: ${String(e).slice(0, 160)}` }, 200)
  } finally {
    // The browser also performs best-effort cleanup. Server-side deletion is the
    // authoritative cleanup path and runs even when transcription fails.
    if (storagePath) await admin.storage.from(MEDIA_BUCKET).remove([storagePath]).catch(() => undefined)
  }
})
