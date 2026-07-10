// Honest model catalog (mirror of supabase/functions/_shared/models.ts — keep in sync).
export interface ModelDef { id: string; label: string; category: string; premium: boolean }

export const MODEL_CATALOG: ModelDef[] = [
  // Быстрые — дешёвые и быстрые, доступны всем
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', category: 'Быстрые', premium: false },
  { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini', category: 'Быстрые', premium: false },
  { id: 'google/gemini-flash-1.5', label: 'Gemini Flash 1.5', category: 'Быстрые', premium: false },
  { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash', category: 'Быстрые', premium: false },
  { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku', category: 'Быстрые', premium: false },
  { id: 'mistralai/mistral-small', label: 'Mistral Small', category: 'Быстрые', premium: false },
  // Стандартные — открытые модели среднего класса
  { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B', category: 'Стандартные', premium: false },
  { id: 'qwen/qwen3-next-80b-a3b-instruct:free', label: 'Qwen3 80B', category: 'Стандартные', premium: false },
  { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B', category: 'Стандартные', premium: false },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3', category: 'Стандартные', premium: false },
  { id: 'meta-llama/llama-3.1-405b-instruct', label: 'Llama 3.1 405B', category: 'Стандартные', premium: false },
  // Премиум — флагманы (тариф Pro+ или свой ключ OpenRouter)
  { id: 'openai/gpt-4o', label: 'GPT-4o', category: 'Премиум', premium: true },
  { id: 'openai/gpt-4.1', label: 'GPT-4.1', category: 'Премиум', premium: true },
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', category: 'Премиум', premium: true },
  { id: 'anthropic/claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', category: 'Премиум', premium: true },
  { id: 'google/gemini-pro-1.5', label: 'Gemini 1.5 Pro', category: 'Премиум', premium: true },
  { id: 'mistralai/mistral-large', label: 'Mistral Large', category: 'Премиум', premium: true },
]

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
  return m ? m.label.split(' — ')[0].split(' (')[0] : id
}
