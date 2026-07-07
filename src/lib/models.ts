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
export const modelLabel = (id?: string | null): string => {
  if (!id) return ''
  const m = MODEL_CATALOG.find((x) => x.id === id)
  return m ? m.label.split(' — ')[0].split(' (')[0] : id
}
