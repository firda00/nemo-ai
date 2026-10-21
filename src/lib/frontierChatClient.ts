import { callBoundedFunction } from './boundedBriefingCall'
import type { FrontierSelection } from '../../supabase/functions/_shared/frontierModels'
export { FRONTIER_MODELS, FRONTIER_EFFORTS } from '../../supabase/functions/_shared/frontierModels'
export type { FrontierSelection, FrontierEffort } from '../../supabase/functions/_shared/frontierModels'

type Invoke = () => PromiseLike<{ data: unknown; error: { context?: Response } | null }>

export interface FrontierClientOptions {
  maxRetries?: number
  backoffBaseMs?: number
}

const RETRIABLE_CODES = new Set([
  'RATE_LIMITED',
  'TOO_MANY_REQUESTS',
  'OVERLOADED',
  'CONCURRENT_LIMIT',
  'MODEL_CONCURRENCY_EXCEEDED',
  'SERVER_OVERLOADED',
])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchFrontierAnswer(
  invoke: Invoke,
  selection: FrontierSelection,
  options?: FrontierClientOptions,
) {
  const maxRetries = options?.maxRetries ?? 2
  const baseMs = options?.backoffBaseMs ?? 300

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await callBoundedFunction(invoke, 90_000)
    const payload = result.payload

    // Hung / aborted requests (reached === false) must release immediately without retry
    if (!result.reached) {
      const code = typeof payload?.code === 'string' ? payload.code : 'PROVIDER_UNAVAILABLE'
      return { ok: false as const, code }
    }

    if (!result.ok || payload?.ok !== true) {
      const code = typeof payload?.code === 'string' ? payload.code : 'PROVIDER_UNAVAILABLE'
      const isRetriable = RETRIABLE_CODES.has(code)
      if (isRetriable && attempt < maxRetries) {
        const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * 50)
        await sleep(delay)
        continue
      }
      return { ok: false as const, code }
    }

    const text = typeof payload.message?.content === 'string' ? payload.message.content.trim() : ''
    const frontier = payload.frontier
    const exact = frontier?.selection
    if (
      payload.model !== selection.model ||
      exact?.provider !== selection.provider ||
      exact?.model !== selection.model ||
      exact?.effort !== selection.effort ||
      frontier?.status !== 'completed' ||
      !text ||
      text.length > 200_000 ||
      !Array.isArray(payload.message.tool_calls) ||
      payload.message.tool_calls.length ||
      typeof frontier?.continuation !== 'string' ||
      !frontier.continuation ||
      frontier.continuation.length > 2_000_000
    ) {
      return { ok: false as const, code: 'INVALID_PROVIDER_RESPONSE' }
    }
    return { ok: true as const, text, model: selection.model, continuation: frontier.continuation }
  }

  return { ok: false as const, code: 'PROVIDER_UNAVAILABLE' }
}
