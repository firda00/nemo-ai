// In-platform image generation — runs on NEMO's OpenRouter key (included in the
// subscription), so customers don't need to bring their own provider key. Uses an
// image-output model via OpenRouter chat/completions (returns a base64 data URL).
const IMAGE_MODEL = Deno.env.get('IMAGE_MODEL') ?? 'google/gemini-2.5-flash-image'

export async function nemoImage(apiKey: string, prompt: string): Promise<{ image?: string; error?: string; tokens: number }> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://nemo.ai', 'X-Title': 'Nemo AI' },
      body: JSON.stringify({ model: IMAGE_MODEL, modalities: ['image', 'text'], messages: [{ role: 'user', content: prompt }] }),
    })
    const data = await r.json()
    const tokens = data?.usage?.total_tokens ?? 0
    if (!r.ok) return { error: data?.error?.message ?? 'Генератор изображений отклонил запрос.', tokens }
    // image-output models return images on message.images[].image_url.url (a data: URL)
    const img = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url
    if (!img) return { error: 'Пустой ответ генератора изображений.', tokens }
    return { image: String(img), tokens }
  } catch (e) {
    return { error: `Сеть/провайдер: ${String(e).slice(0, 160)}`, tokens: 0 }
  }
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
