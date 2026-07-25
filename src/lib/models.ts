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
  { id: 'bytedance-seed/seedream-4.5', label: 'Seedream 4.5 — фотореализм', realistic: true },
  { id: 'black-forest-labs/flux.2-flex', label: 'FLUX.2 Flex — фото + детали', realistic: true },
  { id: 'black-forest-labs/flux.2-pro', label: 'FLUX.2 Pro — макс. качество', realistic: true },
  { id: 'google/gemini-2.5-flash-image', label: 'Gemini — иллюстрация (быстро)', realistic: false },
]
export const DEFAULT_IMAGE_MODEL = 'bytedance-seed/seedream-4.5'

// Video-generation models (Replicate slugs). Video is a budgeted feature — Plus/Pro/Max only.
// A wrong/unavailable slug just fails that one generation gracefully; the default is known-good.
export interface VideoModelDef { id: string; label: string }
export const VIDEO_MODEL_CATALOG: VideoModelDef[] = [
  { id: 'minimax/video-01', label: 'Minimax Hailuo — баланс (рекоменд.)' },
  { id: 'tencent/hunyuan-video', label: 'Hunyuan Video — реализм' },
  { id: 'lightricks/ltx-video', label: 'LTX Video — быстро/дёшево' },
  { id: 'kwaivgi/kling-v1.6-standard', label: 'Kling 1.6 — кинематограф' },
  { id: 'bytedance/seedance-1-pro', label: 'Seedance 1 Pro' },
  { id: 'wan-video/wan-2.1-1.3b', label: 'Wan 2.1 — открытая' },
]
export const DEFAULT_VIDEO_MODEL = 'minimax/video-01'
export const modelLabel = (id?: string | null): string => {
  if (!id) return ''
  const m = MODEL_CATALOG.find((x) => x.id === id)
  return m ? m.label.split(' — ')[0].split(' · ')[0].split(' (')[0] : id
}
