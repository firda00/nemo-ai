// Voice/audio understanding — transcribe speech to text via OpenRouter (an audio-capable
// model, e.g. gemini-2.5-flash). Runs on Nemo's OpenRouter key = included in the
// subscription, no separate STT provider. Used to turn Telegram voice messages into text
// so any agent "understands voice". Returns '' on failure (caller degrades gracefully).
const AUDIO_MODEL = Deno.env.get('AUDIO_MODEL') ?? 'google/gemini-2.5-flash'
const UZ_STT_SPACE_URL = (Deno.env.get('UZ_STT_SPACE_URL') ?? '').replace(/\/+$/, '')

export interface TranscriptionResult {
  text: string
  tokens: number
  error?: string
}

function base64Bytes(value: string): Uint8Array {
  const raw = atob(value)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

export function parseGradioSse(body: string): string {
  for (const line of body.split(/\r?\n/).reverse()) {
    if (!line.startsWith('data:')) continue
    try {
      const parsed = JSON.parse(line.slice(5).trim())
      const text = Array.isArray(parsed) ? String(parsed[0] ?? '') : ''
      return text.replace(/^\[Audio duration:[^\]]+\]\s*/i, '').trim()
    } catch { /* keep looking for the completed event */ }
  }
  return ''
}

async function transcribeOvozify(base64: string, format: string): Promise<TranscriptionResult> {
  if (!UZ_STT_SPACE_URL) return { text: '', tokens: 0, error: 'Ovozify disabled' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const ext = /^[a-z0-9]{2,5}$/i.test(format) ? format.toLowerCase() : 'ogg'
    const mime = ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : 'audio/ogg'
    const bytes = base64Bytes(base64)
    const form = new FormData()
    form.append('files', new Blob([bytes], { type: mime }), `telegram-voice.${ext}`)
    const uploaded = await fetch(`${UZ_STT_SPACE_URL}/gradio_api/upload`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    const paths = await uploaded.json().catch(() => [])
    if (!uploaded.ok || !Array.isArray(paths) || !paths[0]) {
      return { text: '', tokens: 0, error: `Ovozify upload ${uploaded.status}` }
    }

    const file = {
      path: paths[0],
      orig_name: `telegram-voice.${ext}`,
      size: bytes.byteLength,
      mime_type: mime,
      meta: { _type: 'gradio.FileData' },
    }
    const called = await fetch(`${UZ_STT_SPACE_URL}/gradio_api/call/transcribe_audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [file, 'Uzbek'] }),
      signal: controller.signal,
    })
    const started = await called.json().catch(() => ({}))
    if (!called.ok || !started?.event_id) return { text: '', tokens: 0, error: `Ovozify call ${called.status}` }
    const result = await fetch(`${UZ_STT_SPACE_URL}/gradio_api/call/transcribe_audio/${encodeURIComponent(started.event_id)}`, {
      signal: controller.signal,
    })
    const text = parseGradioSse(await result.text())
    if (!result.ok || !text || /^error:/i.test(text)) {
      return { text: '', tokens: 0, error: `Ovozify result ${result.status}` }
    }
    return { text, tokens: 0 }
  } catch (e) {
    return { text: '', tokens: 0, error: `Ovozify ${String(e).slice(0, 120)}` }
  } finally {
    clearTimeout(timeout)
  }
}

export async function transcribeAudioDetailed(orKey: string, base64: string, format = 'ogg', maxTokens = 1200): Promise<TranscriptionResult> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://nemo.ai', 'X-Title': 'Nemo AI' },
      body: JSON.stringify({
        model: AUDIO_MODEL, max_tokens: Math.max(1, Math.min(8192, Math.floor(maxTokens))),
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Transcribe this audio VERBATIM in its original language. Output ONLY the transcription text, nothing else.' },
          { type: 'input_audio', input_audio: { data: base64, format } },
        ] }],
      }),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) return { text: '', tokens: 0, error: String(d?.error?.message ?? `OpenRouter ${r.status}`).slice(0, 200) }
    return {
      text: String(d?.choices?.[0]?.message?.content ?? '').trim(),
      tokens: Math.max(0, Number(d?.usage?.total_tokens ?? 0) || 0),
    }
  } catch (e) {
    return { text: '', tokens: 0, error: String(e).slice(0, 200) }
  }
}

export async function transcribeAudio(
  orKey: string,
  base64: string,
  format = 'ogg',
  language = 'auto',
  model: 'auto' | 'ovozify-whisper-small-uz' | 'gemini-openrouter' = 'auto',
): Promise<string> {
  const lang = language.toLowerCase()
  let ovoz: TranscriptionResult | null = null
  if (model === 'ovozify-whisper-small-uz' || (model === 'auto' && lang === 'uz')) {
    ovoz = await transcribeOvozify(base64, format)
    if (ovoz.text) return ovoz.text
  }

  const primary = await transcribeAudioDetailed(orKey, base64, format)
  if (primary.text) return primary.text

  if (model !== 'gemini-openrouter' && !ovoz && (lang === 'auto' || lang === 'uz')) {
    ovoz = await transcribeOvozify(base64, format)
    if (ovoz.text) return ovoz.text
  }
  console.warn('Telegram STT providers failed', {
    openrouter: primary.error ?? 'empty transcript',
    ovozify: ovoz?.error ?? 'not attempted',
  })
  return ''
}
