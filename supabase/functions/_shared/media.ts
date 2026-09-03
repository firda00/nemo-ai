// In-platform image generation — runs on NEMO's OpenRouter key (included in the
// subscription), so customers don't need to bring their own provider key. Uses an
// image-output model via OpenRouter chat/completions (returns a base64 data URL).
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'

// Curated image-generation models (all served on Nemo's included OpenRouter key).
//  • Diffusion models (Seedream / FLUX.2) go through OpenRouter's dedicated
//    /images/generations endpoint and return TRUE PHOTOREALISTIC output — this is the
//    fix for the "3D-ish / cartoonish" complaint.
//  • The Gemini image model uses /chat/completions with an image modality: fast & cheap
//    but a stylized / render look — kept only as an "illustration" option.
// The list is the server-side allowlist: a caller may only pick an `id` present here,
// because generation bills Nemo's paid key.
export type ImgModelDef = { id: string; label: string; endpoint: 'images' | 'chat'; realistic: boolean }
export const IMAGE_MODELS: ImgModelDef[] = [
  { id: 'google/gemini-3.1-flash-lite-image', label: 'Nano Banana 2 Lite — быстро', endpoint: 'images', realistic: true },
  { id: 'google/gemini-3.1-flash-image', label: 'Nano Banana 2 — баланс', endpoint: 'images', realistic: true },
  { id: 'google/gemini-3-pro-image', label: 'Nano Banana Pro — качество', endpoint: 'images', realistic: true },
  { id: 'openai/gpt-image-2', label: 'GPT Image 2 — точный текст и фото', endpoint: 'images', realistic: true },
  { id: 'bytedance-seed/seedream-5-0-lite', label: 'Seedream 5 Lite — быстро', endpoint: 'images', realistic: true },
  { id: 'bytedance-seed/seedream-5-0-pro', label: 'Seedream 5 Pro — фотореализм', endpoint: 'images', realistic: true },
  { id: 'black-forest-labs/flux.2-flex', label: 'FLUX.2 Flex — фото + детали', endpoint: 'images', realistic: true },
  { id: 'black-forest-labs/flux.2-max', label: 'FLUX.2 Max — макс. качество', endpoint: 'images', realistic: true },
]
// realistic model by default (env override still wins if set to a valid id)
const DEFAULT_IMAGE_MODEL = Deno.env.get('IMAGE_MODEL') ?? 'google/gemini-3.1-flash-image'
export const imgModelDef = (id?: string): ImgModelDef =>
  IMAGE_MODELS.find((m) => m.id === id) ?? IMAGE_MODELS.find((m) => m.id === DEFAULT_IMAGE_MODEL) ?? IMAGE_MODELS[0]

type ImgResult = { image?: string; error?: string; tokens: number }

export async function nemoImage(apiKey: string, prompt: string, modelId?: string): Promise<ImgResult> {
  const def = imgModelDef(modelId)
  const shortPrompt = String(prompt).replace(/\s+/g, ' ').trim().slice(0, 1100)
  try {
    return def.endpoint === 'images'
      ? await imagesGen(apiKey, shortPrompt, def.id)
      : await chatImage(apiKey, shortPrompt, def.id)
  } catch (e) {
    return { error: `Сеть/провайдер: ${String(e).slice(0, 160)}`, tokens: 0 }
  }
}

// diffusion image models via OpenRouter's OpenAI-compatible images API -> { data:[{ b64_json }] }
async function imagesGen(apiKey: string, prompt: string, model: string): Promise<ImgResult> {
  const r = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://nemo.ai', 'X-Title': 'Nemo AI' },
    body: JSON.stringify({ model, prompt }),
  })
  const data = await r.json().catch(() => ({}))
  const tokens = data?.usage?.total_tokens ?? 0
  if (!r.ok) return { error: data?.error?.message ?? 'Генератор изображений отклонил запрос.', tokens }
  const item = data?.data?.[0]
  if (item?.b64_json) {
    const b64 = String(item.b64_json)
    // prefer the provider-declared type; else sniff from the base64 magic bytes
    const declared = String(item.media_type ?? item.mime_type ?? '')
    const mime = declared.startsWith('image/') ? declared
      : b64.startsWith('/9j/') ? 'image/jpeg'
      : b64.startsWith('R0lGOD') ? 'image/gif'
      : b64.startsWith('UklGR') ? 'image/webp'
      : 'image/png'
    return { image: `data:${mime};base64,${b64}`, tokens }
  }
  if (item?.url) return { image: String(item.url), tokens }
  return { error: 'Пустой ответ генератора изображений.', tokens }
}

// Text-to-speech through the same OpenRouter key used by the rest of Nemo.
export async function openRouterTTS(
  key: string,
  text: string,
  model = 'openai/gpt-4o-mini-tts-2025-12-15',
  voice = 'alloy',
): Promise<string> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://nemoai.uz', 'X-Title': 'Nemo AI' },
      body: JSON.stringify({ model, input: text.slice(0, 5000), voice, response_format: 'mp3' }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!r.ok) return ''
    const buf = new Uint8Array(await r.arrayBuffer())
    return `data:audio/mpeg;base64,${encodeBase64(buf)}`
  } catch { return '' }
}

// image-output chat models (e.g. gemini image) via /chat/completions modalities
async function chatImage(apiKey: string, prompt: string, model: string): Promise<ImgResult> {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://nemo.ai', 'X-Title': 'Nemo AI' },
    body: JSON.stringify({ model, modalities: ['image', 'text'], max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  })
  const data = await r.json()
  const tokens = data?.usage?.total_tokens ?? 0
  if (!r.ok) return { error: data?.error?.message ?? 'Генератор изображений отклонил запрос.', tokens }
  // image-output models return images on message.images[].image_url.url (a data: URL)
  const img = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url
  if (!img) return { error: 'Пустой ответ генератора изображений.', tokens }
  return { image: String(img), tokens }
}

// Host a base64 data-URL image in the public `media` bucket and return its public URL.
// A public URL is needed to post the image to Instagram/Facebook (Meta requires a URL,
// not base64). Returns '' on failure — callers keep the data URL for display either way.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function uploadImage(admin: any, accountId: string, dataUrl: string): Promise<string> {
  try {
    const m = String(dataUrl).match(/^data:(image\/[\w+.-]+);base64,(.+)$/)
    if (!m) return ''
    const contentType = m[1]
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))
    const ext = (contentType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
    const path = `${accountId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await admin.storage.from('media').upload(path, bytes, { contentType, upsert: false })
    if (error) return ''
    const { data } = admin.storage.from('media').getPublicUrl(path)
    return data?.publicUrl ?? ''
  } catch (_e) { return '' }
}

// Text-to-speech via OpenAI (cheap, multilingual — ~10x cheaper than ElevenLabs). Returns an
// mp3 data URL, or '' on failure. Used as the default/fallback voiceover engine.
export async function openaiTTS(key: string, text: string, voice = 'alloy'): Promise<string> {
  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice, input: text.slice(0, 4000), response_format: 'mp3' }),
    })
    if (!r.ok) return ''
    const buf = new Uint8Array(await r.arrayBuffer())
    return `data:audio/mpeg;base64,${encodeBase64(buf)}`
  } catch { return '' }
}

// Text-to-speech via ElevenLabs (multilingual). Returns an mp3 data URL, or '' on failure.
export async function elevenTTS(key: string, text: string, voiceId = '21m00Tcm4TlvDq8ikWAM'): Promise<string> {
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 5000), model_id: 'eleven_multilingual_v2' }),
    })
    if (!r.ok) return ''
    const buf = new Uint8Array(await r.arrayBuffer())
    return `data:audio/mpeg;base64,${encodeBase64(buf)}`
  } catch { return '' }
}

// Host a base64 audio data URL in the public `media` bucket -> public URL (needed as a video
// audio track / for cross-platform posting). Returns '' on failure.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function uploadAudio(admin: any, accountId: string, dataUrl: string): Promise<string> {
  try {
    const m = String(dataUrl).match(/^data:(audio\/[\w+.-]+);base64,(.+)$/)
    if (!m) return ''
    const contentType = m[1]
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))
    const sub = (contentType.split('/')[1] || 'mp3').replace(/[^a-z0-9]/gi, '')
    const ext = sub === 'mpeg' ? 'mp3' : sub
    const path = `${accountId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await admin.storage.from('media').upload(path, bytes, { contentType, upsert: false })
    if (error) return ''
    const { data } = admin.storage.from('media').getPublicUrl(path)
    return data?.publicUrl ?? ''
  } catch (_e) { return '' }
}
