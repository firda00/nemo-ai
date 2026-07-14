// Honest model catalog (real OpenRouter IDs, real names). `premium` gates cost: premium
// models run only on a premium plan OR the account's own OpenRouter key (BYO). Mirror of
// src/lib/models.ts — keep in sync.
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

export function modelDef(id: string): ModelDef | undefined {
  return MODEL_CATALOG.find((m) => m.id === id)
}

// Every model id the product offers anywhere in the UI: the editor catalog above
// plus the provider picker (src/data/platform.ts PROVIDERS — kept in sync by
// release-entitlement-contracts). gateModel() rejects anything outside this
// list, so a direct API client cannot run arbitrary/expensive OpenRouter models
// on Nemo's key even when the id slips past the premium regex.
export const ALLOWED_MODEL_IDS = new Set<string>([
  ...MODEL_CATALOG.map((m) => m.id),
  'openai/gpt-5.4-mini',
  'openai/gpt-5.5',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-4.8',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
  'qwen/qwen3.7-plus',
  'qwen/qwen3.7-max',
  'z-ai/glm-5.2',
  'google/gemma-4-26b-a4b-it:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'meta-llama/llama-3.3-70b-instruct',
])
