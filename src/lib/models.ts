// ONE model registry for the whole product. The picker in Content Studio used to carry its
// own hand-written list, so the same account saw a different set of models depending on the
// screen it was standing on. Everything now derives from PROVIDERS (src/data/platform.ts) —
// the same list the agent editor, the model picker and the server allowlist are built from.
// The server keeps a superset allowlist so agents saved on retired ids keep running.
import { PROVIDERS } from '../data/platform'

export interface ModelDef { id: string; label: string; category: string; premium: boolean }

const tierOf = (premium: boolean | undefined, tokenRate: number): string =>
  premium ? 'Премиум' : tokenRate <= 1 ? 'Быстрые' : 'Стандартные'

export const MODEL_CATALOG: ModelDef[] = PROVIDERS.flatMap((provider) =>
  provider.models.map((model) => ({
    id: model.id,
    label: model.label.split(' · ')[0],
    category: tierOf(model.premium, model.tokenRate ?? 0),
    premium: Boolean(model.premium),
  })),
)

export const MODEL_CATEGORIES = ['Быстрые', 'Стандартные', 'Премиум'] as const
export const DEFAULT_MODEL = 'openai/gpt-4o-mini'

// Image-generation models (mirror of the allowlist in supabase/functions/_shared/media.ts).
// Realistic engines produce true photographs; the Gemini one is a fast illustration/render look.
export interface ImageModelDef { id: string; label: string; realistic: boolean }
export const IMAGE_MODEL_CATALOG: ImageModelDef[] = [
  { id: 'google/gemini-3.1-flash-lite-image', label: 'Nano Banana 2 Lite — быстро', realistic: true },
  { id: 'google/gemini-3.1-flash-image', label: 'Nano Banana 2 — баланс', realistic: true },
  { id: 'google/gemini-3-pro-image', label: 'Nano Banana Pro — качество', realistic: true },
  { id: 'openai/gpt-image-2', label: 'GPT Image 2 — точный текст и фото', realistic: true },
  { id: 'bytedance-seed/seedream-5-0-pro', label: 'Seedream 5 Pro — фотореализм', realistic: true },
  { id: 'black-forest-labs/flux.2-flex', label: 'FLUX.2 Flex — фото + детали', realistic: true },
  { id: 'black-forest-labs/flux.2-max', label: 'FLUX.2 Max — макс. качество', realistic: true },
]
export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image'

// Video-generation models served by OpenRouter. Video is a budgeted feature — Plus/Pro/Max only.
// A wrong/unavailable slug just fails that one generation gracefully; the default is known-good.
export interface VideoModelDef { id: string; label: string }
export const VIDEO_MODEL_CATALOG: VideoModelDef[] = [
  { id: 'google/veo-3.1-fast', label: 'Veo 3.1 Fast — быстро + звук' },
  { id: 'google/veo-3.1', label: 'Veo 3.1 — максимум качества + звук' },
  { id: 'kwaivgi/kling-v3.0-pro', label: 'Kling 3.0 Pro — кинематограф' },
  { id: 'kwaivgi/kling-v3.0-std', label: 'Kling 3.0 Standard — баланс' },
  { id: 'bytedance/seedance-2.5', label: 'Seedance 2.5 — динамика' },
  { id: 'bytedance/seedance-2.0-fast', label: 'Seedance 2.0 Fast — быстро' },
  { id: 'openai/sora-2-pro', label: 'Sora 2 Pro — премиум' },
  { id: 'minimax/hailuo-3', label: 'Hailuo 3 — баланс' },
]
export const DEFAULT_VIDEO_MODEL = 'google/veo-3.1-fast'
export const modelLabel = (id?: string | null): string => {
  if (!id) return ''
  const m = MODEL_CATALOG.find((x) => x.id === id)
  return m ? m.label.split(' — ')[0].split(' · ')[0].split(' (')[0] : id
}
