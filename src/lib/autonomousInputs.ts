export interface AutonomousInputArtifact {
  name: string
  content: string
  originalChars: number
  truncated: boolean
}

export const MAX_AUTONOMOUS_INPUT_FILES = 4
export const MAX_AUTONOMOUS_FILE_CHARS = 24_000
export const MAX_AUTONOMOUS_TOTAL_CHARS = 60_000

const MARKETPLACE_SCOPE =
  /(uzum|marketplace|маркетплейс|sku|артикул|ассортимент|остатк|товар|закуп|полк|inventory|assortment|reorder)/i
const DATA_DEPENDENT_OUTCOME =
  /(анализ|классиф|рассч|посч|марж|оборач|скорост|закуп|заказать|остатк|прогноз|abc|xyz|reorder|calculate|classif|margin|stock|forecast|slow.?mov|top.?sell)/i
const INLINE_DATA_SIGNAL =
  /(^|\n)\s*(sku|артикул|product|товар|sales|продаж|stock|остаток|cost|себестоимость|price|цена)\s*[,;:\t]/i

export function needsMarketplaceSourceData(goal: string, contextHint = ''): boolean {
  const combined = `${contextHint}\n${goal}`
  return MARKETPLACE_SCOPE.test(combined) && DATA_DEPENDENT_OUTCOME.test(combined)
}

export function hasInlineSourceData(goal: string, contextHint = ''): boolean {
  return INLINE_DATA_SIGNAL.test(`${contextHint}\n${goal}`)
}

export function marketplaceInputMissing(
  goal: string,
  artifacts: AutonomousInputArtifact[],
  contextHint = '',
): boolean {
  return needsMarketplaceSourceData(goal, contextHint) &&
    artifacts.length === 0 &&
    !hasInlineSourceData(goal, contextHint)
}

export function boundedArtifact(
  name: string,
  extracted: string,
  remainingChars: number,
): AutonomousInputArtifact | null {
  const normalized = extracted.split('\u0000').join('').trim()
  if (!normalized || remainingChars <= 0) return null
  const limit = Math.min(MAX_AUTONOMOUS_FILE_CHARS, remainingChars)
  const content = normalized.slice(0, limit)
  return {
    name: name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) || 'data',
    content,
    originalChars: normalized.length,
    truncated: normalized.length > content.length,
  }
}

export function artifactHandoffContext(
  outputs: Array<{ name: string; role: string; output?: string }>,
): string {
  return outputs
    .map((item, index) => (
      `=== HANDOFF ${index + 1}: ${item.name} (${item.role}) ===\n${item.output ?? ''}`
    ))
    .join('\n\n')
    .slice(-18_000)
}
