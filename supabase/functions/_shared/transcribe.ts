// Voice/audio understanding — transcribe speech to text via OpenRouter (an audio-capable
// model, e.g. gemini-2.5-flash). Runs on Nemo's OpenRouter key = included in the
// subscription, no separate STT provider. Used to turn Telegram voice messages into text
// so any agent "understands voice". Returns '' on failure (caller degrades gracefully).
const AUDIO_MODEL = Deno.env.get('AUDIO_MODEL') ?? 'google/gemini-2.5-flash'

export async function transcribeAudio(orKey: string, base64: string, format = 'ogg'): Promise<string> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://nemo.ai', 'X-Title': 'Nemo AI' },
      body: JSON.stringify({
        model: AUDIO_MODEL, max_tokens: 1200,
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Transcribe this audio VERBATIM in its original language. Output ONLY the transcription text, nothing else.' },
          { type: 'input_audio', input_audio: { data: base64, format } },
        ] }],
      }),
    })
    const d = await r.json()
    if (!r.ok) return ''
    return String(d?.choices?.[0]?.message?.content ?? '').trim()
  } catch (_e) { return '' }
}
