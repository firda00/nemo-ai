import { z } from 'zod'
import { createHash } from 'node:crypto'

export const ContextMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().max(256 * 1024),
  name: z.string().min(1).max(128).optional(),
}).strict()

export type ContextMessage = z.infer<typeof ContextMessageSchema>

export interface CompressContextOptions {
  maxMessages?: number
  maxEstimatedTokens?: number
  criticalSystemContract?: string
  structuralCompression?: boolean
  promptCacheAlignment?: boolean
}

export interface CompressionMetrics {
  beforeEstimatedTokens: number
  afterEstimatedTokens: number
  savedEstimatedTokens: number
  estimationRatio: number
  removedMessages: number
  budgetExceeded: boolean
}

export interface CompressedContext {
  messages: ContextMessage[]
  metrics: CompressionMetrics
  cachePlan: {
    prefixMessageCount: number
    prefixSha256: string
    stablePrefix: ContextMessage[]
    dynamicSuffix: ContextMessage[]
  }
}

function comparisonKey(content: string): string {
  return content.trim().replace(/\s+/g, ' ')
}

function compactJson(value: string): string | null {
  try { return JSON.stringify(JSON.parse(value)) } catch { return null }
}

function structurallyCompress(content: string): string {
  const trimmed = content.trim()
  const wholeJson = compactJson(trimmed)
  if (wholeJson) return wholeJson
  // JSON blocks are safe to minify because JSON whitespace is not semantic. Code blocks are
  // intentionally left byte-for-byte intact: Python indentation and JavaScript ASI matter.
  return trimmed.replace(/```json\s*\n([\s\S]*?)\n```/gi, (block, body: string) => {
    const compact = compactJson(body)
    return compact ? `\`\`\`json\n${compact}\n\`\`\`` : block
  })
}

function cleanContent(content: string, structural: boolean): string {
  return structural ? structurallyCompress(content) : content.trim()
}

export function estimateTokens(messages: readonly ContextMessage[]): number {
  const characters = messages.reduce((sum, message) => sum + message.role.length + message.content.length + (message.name?.length ?? 0) + 4, 0)
  return Math.max(messages.length ? 1 : 0, Math.ceil(characters / 4))
}

export function compressContext(
  rawMessages: readonly ContextMessage[],
  options: CompressContextOptions = {},
): CompressedContext {
  const source = z.array(ContextMessageSchema).max(10_000).parse(rawMessages)
  const maxMessages = Math.min(10_000, Math.max(1, options.maxMessages ?? 64))
  const maxEstimatedTokens = Math.min(1_000_000, Math.max(64, options.maxEstimatedTokens ?? 32_000))
  // Preserve internal whitespace because code, diffs, tables, and structured prompts are
  // whitespace-sensitive. A collapsed copy is used only as the system-prompt dedup key.
  const structural = options.structuralCompression ?? true
  const cleaned = source.map((message) => ({ ...message, content: cleanContent(message.content, structural) }))
  const explicitContract = options.criticalSystemContract ? cleanContent(options.criticalSystemContract, structural) : null
  const firstSystemIndex = cleaned.findIndex((message) => message.role === 'system')
  const critical: ContextMessage | null = explicitContract
    ? { role: 'system', content: explicitContract }
    : firstSystemIndex >= 0 ? cleaned[firstSystemIndex] : null

  const seenSystems = new Set<string>()
  if (critical) seenSystems.add(comparisonKey(critical.content))
  const candidates = cleaned.filter((message, index) => {
    if (!message.content) return false
    if (index === firstSystemIndex && !explicitContract) return false
    if (message.role !== 'system') return true
    const key = comparisonKey(message.content)
    if (seenSystems.has(key)) return false
    seenSystems.add(key)
    return true
  })

  const budget = Math.max(0, maxMessages - (critical ? 1 : 0))
  let retained = budget ? candidates.slice(-budget) : []
  while (retained.length && estimateTokens(critical ? [critical, ...retained] : retained) > maxEstimatedTokens) {
    retained = retained.slice(1)
  }
  const messages = critical ? [critical, ...retained] : retained
  const beforeEstimatedTokens = estimateTokens(source)
  const afterEstimatedTokens = estimateTokens(messages)
  const savedEstimatedTokens = Math.max(0, beforeEstimatedTokens - afterEstimatedTokens)
  let prefixMessageCount = options.promptCacheAlignment === false ? 0 : messages.findIndex((message) => message.role !== 'system')
  if (prefixMessageCount < 0) prefixMessageCount = messages.length
  const stablePrefix = messages.slice(0, prefixMessageCount)
  const dynamicSuffix = messages.slice(prefixMessageCount)
  const prefixSha256 = createHash('sha256').update(JSON.stringify(stablePrefix)).digest('hex')
  return {
    messages,
    cachePlan: { prefixMessageCount, prefixSha256, stablePrefix, dynamicSuffix },
    metrics: {
      beforeEstimatedTokens,
      afterEstimatedTokens,
      savedEstimatedTokens,
      estimationRatio: beforeEstimatedTokens ? savedEstimatedTokens / beforeEstimatedTokens : 0,
      removedMessages: source.length - messages.length,
      budgetExceeded: afterEstimatedTokens > maxEstimatedTokens,
    },
  }
}
