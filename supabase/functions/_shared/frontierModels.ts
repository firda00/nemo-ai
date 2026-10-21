// Direct-provider models only. Never add these IDs to the legacy OpenRouter allowlist:
// an explicit flagship choice must either use its native API or fail visibly.
export const FRONTIER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type FrontierEffort = typeof FRONTIER_EFFORTS[number]
export type FrontierProvider = 'openai' | 'anthropic'
export type FrontierSelection = {
  provider: FrontierProvider
  model: 'gpt-6-astra' | 'claude-fable-5-1'
  effort: FrontierEffort
}
export const FRONTIER_MODELS = [
  { provider: 'openai', model: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { provider: 'anthropic', model: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
] as const

export function isFrontierSelection(value: unknown): value is FrontierSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).every(key => ['provider', 'model', 'effort'].includes(key))
    && FRONTIER_MODELS.some(item => item.provider === row.provider && item.model === row.model)
    && FRONTIER_EFFORTS.some(effort => effort === row.effort)
}
