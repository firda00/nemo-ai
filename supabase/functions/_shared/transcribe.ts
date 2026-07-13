// Voice/audio understanding — transcribe speech to text via OpenRouter (an audio-capable
// model, e.g. gemini-2.5-flash). Runs on Nemo's OpenRouter key = included in the
// subscription, no separate STT provider. Used to turn Telegram voice messages into text
// so any agent "understands voice". Returns '' on failure (caller degrades gracefully).
const AUDIO_MODEL = Deno.env.get('AUDIO_MODEL') ?? 'google/gemini-2.5-flash'

export interface TranscriptionResult {
  text: string
  tokens: number
  error?: string
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

export async function transcribeAudio(orKey: string, base64: string, format = 'ogg'): Promise<string> {
  return (await transcribeAudioDetailed(orKey, base64, format)).text
}
