// Authenticated meeting-audio transcription (recordings up to 5 hours).
// Long audio is advertised only when Gemini File API is configured. Otherwise
// the server deliberately exposes and enforces the smaller OpenRouter fallback.
// Storage URLs are never fetched directly: only files uploaded under the
// authenticated user's own media/<user-id>/audio/ prefix are accepted.
//
// Long recordings cannot be transcribed in one model call (a 5h verbatim
// transcript exceeds a single response's output-token budget) and cannot be
// finished inside one edge invocation (wall-clock). So the file is uploaded to
// the Gemini File API ONCE, then transcribed in overlapping ~50-minute windows;
// when the request's time budget runs out the job state is persisted to the
// service-role-only transcribe_jobs table and the client continues with
// {action:'continue', job_id}. Concurrent/retried continues are serialized by
// an atomic 3-minute claim lease, and finalize is idempotent (status+billed_at
// guard) so billing happens exactly once: max(sum provider tokens, chars / 4).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { transcribeAudioDetailed } from '../_shared/transcribe.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { mergeTranscriptWindows } from '../_shared/transcriptMerge.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? ''

const SHORT_MAX_BYTES = 12 * 1024 * 1024
const LONG_MAX_BYTES = 180 * 1024 * 1024
const LONG_MAX_SECONDS = 5 * 60 * 60
const MAX_TRANSCRIPT_CHARS = 600_000
const SHORT_OUTPUT_TOKENS = 8192
const LONG_OUTPUT_TOKENS = 32_768
// 50-minute windows keep each response safely inside the output-token budget
// even for fast multilingual speech; 30s of overlap is re-transcribed on both
// sides and deduplicated at the seam (transcriptMerge.ts).
const WINDOW_SECONDS = 3000
const WINDOW_OVERLAP_SECONDS = 30
// hard server-side 5h bound — even a lying client cannot buy more windows:
// ceil(18000 / (3000 - 30)) = 7
const MAX_WINDOWS = 7
// per-invocation budget: leave wall-clock headroom for the edge runtime; the
// remaining windows run in follow-up {action:'continue'} calls
const REQUEST_BUDGET_MS = 150_000
// a claim older than this is considered crashed and may be re-claimed
const CLAIM_LEASE_MS = 3 * 60 * 1000
const NO_SPEECH_MARK = 'NO_SPEECH_IN_RANGE'
const MEDIA_BUCKET = 'media'

interface GeminiResult {
  text: string
  tokens: number
  error?: string
  done?: boolean
}

interface TranscribeJob {
  id: string
  account_id: string
  file_name: string
  file_uri: string
  mime: string
  language: string
  windows_done: number
  max_windows: number
  transcript: string
  provider_tokens: number
  status: string
  claim_token: string | null
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
      message: `Длинная расшифровка не включена на сервере: сейчас доступны только короткие записи до ${SHORT_MAX_BYTES / 1048576} МБ. Настройте GEMINI_API_KEY, чтобы включить записи до 5 часов.`,
      received_mb: mb,
    }
  }
  return {
    ok: false,
    code: 'FILE_TOO_LARGE',
    message: `Аудиофайл ${mb} МБ превышает лимит ${LONG_MAX_BYTES / 1048576} МБ. Для 5-часовых записей используйте сжатие ~64 кбит/с.`,
    received_mb: mb,
  }
}

const hms = (totalSeconds: number) => new Date(totalSeconds * 1000).toISOString().slice(11, 19)

// Upload once to the Gemini File API and wait until the file is ACTIVE
// (long files stay PROCESSING for a while; generateContent would reject them).
async function geminiUpload(bytes: Uint8Array, mime: string): Promise<{ name: string; uri: string; error?: string }> {
  const up = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Protocol': 'raw', 'Content-Type': mime },
    body: bytes,
  })
  const uploaded = await up.json().catch(() => ({}))
  const uri = String(uploaded?.file?.uri ?? '')
  const name = String(uploaded?.file?.name ?? '')
  if (!up.ok || !uri || !name) {
    return { name, uri: '', error: `Gemini upload: ${String(uploaded?.error?.message ?? up.status).slice(0, 160)}` }
  }
  let state = String(uploaded?.file?.state ?? 'PROCESSING')
  for (let attempt = 0; state === 'PROCESSING' && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const meta = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${GEMINI_API_KEY}`).then((r) => r.json()).catch(() => ({}))
    state = String(meta?.state ?? 'PROCESSING')
  }
  if (state !== 'ACTIVE') return { name, uri: '', error: `Gemini file is not ready (${state}).` }
  return { name, uri }
}

async function geminiDeleteFile(fileName: string): Promise<void> {
  if (!fileName) return
  await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`, { method: 'DELETE' }).catch(() => undefined)
}

// Transcribe one time window of an already-uploaded file. `done` means the
// window lies entirely past the end of the audio.
async function geminiTranscribeWindow(fileUri: string, mime: string, languageHint: string, startSec: number, endSec: number): Promise<GeminiResult> {
  try {
    const gen = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { file_data: { mime_type: mime, file_uri: fileUri } },
          { text: `Transcribe ONLY the segment of this meeting audio between ${hms(startSec)} and ${hms(endSec)} verbatim. Detect and understand mixed speech in Russian, English, Uzbek, Kazakh, Kyrgyz, Tajik, Turkmen, Turkish, Arabic, Persian, Hindi, Urdu, Chinese, Japanese, Korean, German, French, Spanish, Italian and Portuguese. Preserve the original language, distinguish speakers when possible, and keep meaningful timestamps or speaker changes. Do not summarize and do not translate. Language hint: ${languageHint}. If the audio ends before ${hms(startSec)}, output exactly ${NO_SPEECH_MARK}. Output ONLY the transcription of that segment.` },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: LONG_OUTPUT_TOKENS },
      }),
    })
    const generated = await gen.json().catch(() => ({}))
    const candidate = generated?.candidates?.[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (candidate?.content?.parts ?? []).map((part: any) => part?.text ?? '').join('').trim()
    const finishReason = String(candidate?.finishReason ?? '')
    const tokens = Math.max(0, Number(generated?.usageMetadata?.totalTokenCount ?? 0) || 0)
    if (!gen.ok) return { text: '', tokens, error: `Gemini transcribe: ${String(generated?.error?.message ?? gen.status).slice(0, 160)}` }
    if (text.replace(/[^A-Z_]/g, '') === NO_SPEECH_MARK) return { text: '', tokens, done: true }
    if (!text) {
      // empty output only means "past the end of the audio" when generation
      // STOPped normally — MAX_TOKENS/safety/missing candidates are errors,
      // never a silent end-of-job
      if (finishReason === 'STOP') return { text: '', tokens, done: true }
      return { text: '', tokens, error: `Gemini transcribe: empty output (${finishReason || 'no candidates'})` }
    }
    return { text, tokens }
  } catch (e) {
    return { text: '', tokens: 0, error: String(e).slice(0, 160) }
  }
}

Deno.serve(async (req) => {
  const startedAt = Date.now()
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

  const languageHint = String(body?.language ?? 'auto').replace(/[\r\n]/g, ' ').trim().slice(0, 40)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  // ---- resumable long-audio jobs (service-role-only transcribe_jobs table) ----
  // Atomic claim: only ONE request may process a pending job at a time; a claim
  // older than the lease is treated as crashed and may be re-claimed. The claim
  // token proves OWNERSHIP: a worker that outlived its lease and lost the job
  // to a re-claimer can no longer overwrite progress or finalize, because every
  // subsequent write must match the token that is currently on the row.
  const claimJob = async (jobId: string): Promise<TranscribeJob | null> => {
    if (!UUID_RE.test(jobId)) return null
    const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString()
    const { data } = await admin
      .from('transcribe_jobs')
      .update({ claimed_at: new Date().toISOString(), claim_token: crypto.randomUUID() })
      .eq('id', jobId)
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
      .select('*')
      .maybeSingle()
    return (data as TranscribeJob | null) ?? null
  }
  const saveProgress = async (job: TranscribeJob) => {
    const { error } = await admin
      .from('transcribe_jobs')
      .update({ windows_done: job.windows_done, transcript: job.transcript, provider_tokens: job.provider_tokens, claimed_at: null, claim_token: null, updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'pending')
      .eq('claim_token', job.claim_token)
    if (error) console.error('transcribe job save failed:', error)
  }

  // Run as many windows as fit this request's budget; finalize (bill exactly
  // once + cleanup) when the audio is fully covered, else persist and continue.
  const runWindows = async (job: TranscribeJob) => {
    let finished = false
    let windowError = ''
    const maxWindows = Math.max(1, Math.min(MAX_WINDOWS, Number(job.max_windows) || MAX_WINDOWS))
    while (job.windows_done < maxWindows) {
      if (Date.now() - startedAt > REQUEST_BUDGET_MS) break
      const start = job.windows_done * (WINDOW_SECONDS - WINDOW_OVERLAP_SECONDS)
      if (start >= LONG_MAX_SECONDS) { finished = true; break }
      // the final window is clamped to the 5-hour bound — 7 windows never
      // request audio past 18000s regardless of what the client declared
      const end = Math.min(start + WINDOW_SECONDS, LONG_MAX_SECONDS)
      const r = await geminiTranscribeWindow(job.file_uri, job.mime, job.language, start, end)
      job.provider_tokens += r.tokens
      if (r.error) { windowError = r.error; break }
      if (r.done) { finished = true; break }
      job.transcript = job.windows_done === 0 ? r.text : mergeTranscriptWindows(job.transcript, r.text)
      job.windows_done++
      if (job.transcript.length > MAX_TRANSCRIPT_CHARS) { finished = true; break }
    }
    if (job.windows_done >= maxWindows) finished = true
    if (!finished) {
      if (windowError && job.windows_done === 0) {
        // first window failed hard — nothing to protect, end the job. The Gemini
        // file is deleted ONLY when this worker actually won the failed-flip:
        // a stale lease must not destroy the file the new owner is processing.
        const { data: failedRow } = await admin.from('transcribe_jobs').update({ status: 'failed', claimed_at: null, claim_token: null }).eq('id', job.id).eq('status', 'pending').eq('claim_token', job.claim_token).select('id').maybeSingle()
        if (failedRow?.id) await geminiDeleteFile(job.file_name)
        return json({ ok: false, code: 'TRANSCRIPTION_FAILED', message: `Не удалось расшифровать длинную запись через Gemini. ${windowError}`.trim() }, 200)
      }
      // mid-job errors are NOT fatal: progress is saved and the client retries 'continue'
      await saveProgress(job)
      return json({ ok: true, pending: true, job_id: job.id, windows_done: job.windows_done, windows_max: maxWindows, ...(windowError ? { note: windowError } : {}) })
    }
    const transcript = job.transcript
    if (!transcript) {
      const { data: failedRow } = await admin.from('transcribe_jobs').update({ status: 'failed', claimed_at: null, claim_token: null }).eq('id', job.id).eq('status', 'pending').eq('claim_token', job.claim_token).select('id').maybeSingle()
      if (failedRow?.id) await geminiDeleteFile(job.file_name)
      return json({ ok: false, code: 'TRANSCRIPTION_FAILED', message: 'Не удалось расшифровать аудио: речь не распознана.' }, 200)
    }
    // Transactional finalize (SQL RPC): verifies the claim token, records usage,
    // decrements the balance and marks the job done+billed in ONE transaction —
    // a job can never be marked billed unless the billing writes committed too.
    const { data: billedTokens, error: finalizeError } = await admin.rpc('finalize_transcribe_job', {
      p_job_id: job.id,
      p_account_id: accountId,
      p_claim_token: job.claim_token,
      p_windows_done: job.windows_done,
      p_transcript: job.transcript,
      p_provider_tokens: job.provider_tokens,
    })
    if (finalizeError) {
      // finalize is retryable: KEEP the Gemini file, release the claim with the
      // progress intact, and let the client continue again
      console.error('transcribe finalize failed:', finalizeError)
      await saveProgress(job)
      return json({ ok: true, pending: true, job_id: job.id, windows_done: job.windows_done, windows_max: maxWindows, note: 'finalize retry' })
    }
    if (billedTokens == null) {
      // lost the finalize race or the lease was re-claimed: the current state of
      // the row is authoritative — return it if done, else let the client retry
      const { data: current } = await admin.from('transcribe_jobs').select('status, transcript, provider_tokens').eq('id', job.id).eq('account_id', accountId).maybeSingle()
      if (current?.status === 'done') {
        const doneTranscript = String(current.transcript ?? '')
        return json({ ok: true, transcript: doneTranscript, transcript_chars: doneTranscript.length, engine: 'gemini-file', tokens: Number(current.provider_tokens) || 0 })
      }
      return json({ ok: true, pending: true, job_id: job.id, windows_done: job.windows_done, windows_max: maxWindows })
    }
    await geminiDeleteFile(job.file_name)
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      return json({
        ok: false,
        code: 'TRANSCRIPT_TOO_LARGE',
        message: `Расшифровка содержит ${transcript.length} символов и превышает явный лимит ${MAX_TRANSCRIPT_CHARS}. Текст не был обрезан: разделите запись на части.`,
        transcript_chars: transcript.length,
      }, 200)
    }
    return json({ ok: true, transcript, transcript_chars: transcript.length, engine: 'gemini-file', tokens: Number(billedTokens) || 0 })
  }

  if (String(body?.action ?? '') === 'continue') {
    const jobId = String(body?.job_id ?? '').trim()
    const claimed = jobId ? await claimJob(jobId) : null
    if (claimed) return await runWindows(claimed)
    // claim failed: either finished, busy (live claim), failed, or foreign/unknown
    const { data: existing } = jobId && UUID_RE.test(jobId)
      ? await admin.from('transcribe_jobs').select('*').eq('id', jobId).eq('account_id', accountId).maybeSingle()
      : { data: null }
    if (existing?.status === 'done') {
      const transcript = String(existing.transcript ?? '')
      if (transcript.length > MAX_TRANSCRIPT_CHARS) {
        return json({ ok: false, code: 'TRANSCRIPT_TOO_LARGE', message: `Расшифровка превышает лимит ${MAX_TRANSCRIPT_CHARS} символов.`, transcript_chars: transcript.length }, 200)
      }
      return json({ ok: true, transcript, transcript_chars: transcript.length, engine: 'gemini-file', tokens: Number(existing.provider_tokens) || 0 })
    }
    if (existing?.status === 'pending') {
      // another request holds the claim — the client just polls again
      return json({ ok: true, pending: true, job_id: existing.id, windows_done: existing.windows_done, windows_max: existing.max_windows })
    }
    return json({ ok: false, code: 'JOB_NOT_FOUND', message: 'Задача расшифровки не найдена или уже завершена.' }, 200)
  }

  // The credit gate applies to NEW jobs only — it sits after the 'continue'
  // handler so a finished job's transcript stays readable even when its own
  // final charge drained the balance to zero.
  if (Number(account.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)

  // declared length is validated up front for a clear error; the hard bound is
  // the clamped window range + max_windows server-side either way
  const durationSeconds = Math.max(0, Number(body?.duration_seconds ?? 0) || 0)
  if (durationSeconds > LONG_MAX_SECONDS) {
    return json({ ok: false, code: 'AUDIO_TOO_LONG', message: `Максимальная длина записи — 5 часов (300 минут).`, received_seconds: Math.round(durationSeconds) }, 200)
  }

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

    let transcript = ''
    let engine = ''
    let providerError = ''
    let providerTokens = 0

    if (longAudio) {
      const uploadResult = await geminiUpload(bytes, mime)
      if (uploadResult.uri) {
        // a declared duration narrows the window budget; the hard cap stays MAX_WINDOWS
        const declaredWindows = durationSeconds > 0 ? Math.ceil(durationSeconds / (WINDOW_SECONDS - WINDOW_OVERLAP_SECONDS)) : MAX_WINDOWS
        const { data: jobRow, error: jobError } = await admin
          .from('transcribe_jobs')
          .insert({
            account_id: accountId,
            user_id: user.id,
            file_name: uploadResult.name,
            file_uri: uploadResult.uri,
            mime,
            language: languageHint || 'auto',
            max_windows: Math.max(1, Math.min(MAX_WINDOWS, declaredWindows)),
            claimed_at: new Date().toISOString(),
            claim_token: crypto.randomUUID(),
          })
          .select('*')
          .single()
        if (!jobError && jobRow) {
          // the Gemini file now holds the audio — free the storage copy right away
          if (storagePath) {
            await admin.storage.from(MEDIA_BUCKET).remove([storagePath]).catch(() => undefined)
            storagePath = ''
          }
          return await runWindows(jobRow as TranscribeJob)
        }
        providerError = jobError?.message ?? 'transcription job could not be created'
        await geminiDeleteFile(uploadResult.name)
      } else {
        providerError = uploadResult.error ?? ''
      }
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
    await admin.from('usage').insert({ account_id: accountId, tokens: billableTokens, model: null, stage: `audio-transcription:${engine}` })
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
